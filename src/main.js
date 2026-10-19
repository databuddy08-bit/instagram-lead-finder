// Instagram Lead Finder — Apify actor entry point.
import { Actor, log } from 'apify';
import { InstagramClient, Session, NotFoundError, BlockedError, StoppedError } from './fetcher.js';
import { buildProfile, finalizeContacts, normalizeUsername, scannableLinks } from './profile.js';
import { extractFromPage, phoneKey } from './contacts.js';
import { leadScore, gradeLetter } from './scoring.js';
import { compileKeyword, matchKeywords } from './keywords.js';

// Pay-per-event names — must match the Monetization settings exactly.
export const EVENT_PROFILE = 'profile-lead';
export const EVENT_CONTACT = 'profile-lead-with-contact';

const CONCURRENCY = 25;
const STOP_BEFORE_TIMEOUT_MS = 45000;
const PROGRESS_EVERY = 50;
const SAMPLE_LIMIT = 15;
const FILL_RATE_FIELDS = [
    'full_name', 'biography', 'followers', 'category', 'external_url', 'business_email', 'business_phone', 'emails_found',
    'phones_found', 'emails_from_links', 'phones_from_links', 'primary_email', 'primary_phone', 'engagement_rate_pct',
    'avg_likes', 'avg_video_views', 'last_post_at', 'business_address', 'related_profiles', 'recent_posts', 'influencer_tier',
    'lead_grade', 'keyword_match_evidence',
];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const opts = {
    usernames: Array.isArray(input.usernames) ? input.usernames : [],
    maxResults: Math.max(0, Number(input.maxResults) || 0),
    scrapeRelatedProfiles: Boolean(input.scrapeRelatedProfiles),
    maxRelatedPerProfile: Math.min(80, Math.max(1, Number(input.maxRelatedPerProfile) || 10)),
    scanBioLinks: Boolean(input.scanBioLinks),
    includeRecentPosts: input.includeRecentPosts !== false,
    recentPostsLimit: Math.min(12, Math.max(1, Number(input.recentPostsLimit) || 12)),
    excludePinnedPosts: input.excludePinnedPosts !== false,
    minFollowers: Math.max(0, Number(input.minFollowers) || 0),
    maxFollowers: Math.max(0, Number(input.maxFollowers) || 0),
    influencerTiers: Array.isArray(input.influencerTiers) ? input.influencerTiers : [],
    onlyWithContact: Boolean(input.onlyWithContact),
    onlyBusinessAccounts: Boolean(input.onlyBusinessAccounts),
    minLeadGrade: ['A', 'B', 'C', 'D'].includes(input.minLeadGrade) ? input.minLeadGrade : 'D',
    minEngagementRate: Math.max(0, Number(input.minEngagementRate) || 0),
    includeUnclearEngagement: input.includeUnclearEngagement !== false,
    includePrivateAccounts: input.includePrivateAccounts !== false,
    keywordMatchMode: ['exact', 'all', 'any', 'off'].includes(input.keywordMatchMode) ? input.keywordMatchMode : 'exact',
    skipPreviouslyScraped: Boolean(input.skipPreviouslyScraped),
    dedupeStoreName: /^[a-z0-9-]{1,63}$/.test(input.dedupeStoreName ?? '') ? input.dedupeStoreName : 'instagram-lead-finder-seen',
};
const keywords = opts.keywordMatchMode === 'off' ? []
    : (Array.isArray(input.bioKeywords) ? input.bioKeywords : []).map((k) => compileKeyword(k, opts.keywordMatchMode)).filter(Boolean);

// ---------- Deadline, proxy, pricing ----------
const startedAt = Date.now();
const { timeoutAt } = Actor.getEnv();
const deadline = timeoutAt ? new Date(timeoutAt).getTime() - STOP_BEFORE_TIMEOUT_MS : Infinity;
const msLeft = () => deadline - Date.now();

let proxyConfiguration;
try {
    proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
} catch (err) {
    log.warning(`Proxy could not be configured (${err.message}). Running without a proxy — Instagram will likely block most requests.`);
}
const proxyGroups = input.proxyConfiguration?.apifyProxyGroups ?? [];
if (!proxyConfiguration) log.warning('No proxy: limited to 60 requests/min. Instagram blocks datacenter IPs — use the Apify RESIDENTIAL proxy.');
else if (input.proxyConfiguration?.useApifyProxy && !proxyGroups.includes('RESIDENTIAL')) {
    log.warning('Apify proxy without the RESIDENTIAL group: Instagram blocks most datacenter IPs. Switch to RESIDENTIAL if you see many blocks.');
}

const charging = Actor.getChargingManager();
const pricing = charging.getPricingInfo();
log.info(`Pricing: ${pricing.isPayPerEvent ? 'pay per event' : 'not pay-per-event'}; max cost per run: ${Number.isFinite(pricing.maxTotalChargeUsd) ? `$${pricing.maxTotalChargeUsd}` : 'none'}`);

// ---------- State (survives migrations) ----------
const stored = (await Actor.getValue('STATE')) ?? {};
const summary = stored.summary ?? {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationSec: null,
    stopReason: null,
    inputCount: opts.usernames.length,
    uniqueInputUsernames: 0,
    profilesProcessed: 0,
    saved: 0,
    savedWithContact: 0,
    savedFromInput: 0,
    savedFromRelated: 0,
    chargedEvents: { [EVENT_PROFILE]: 0, [EVENT_CONTACT]: 0 },
    perSearch: {},
    skipReasons: {},
    skipSamples: {},
    requests: { requests: 0, successes: 0, retries: 0, blocked: 0, networkErrors: 0, serverErrors: 0, linkRequests: 0 },
    contactsFromLinkPages: 0,
    notes: { inputProfilesWithNoRelatedShown: 0 },
    fillRatesPct: {},
    fillCounts: {},
    filtersUsed: {},
};
const done = new Set(stored.done ?? []);

summary.filtersUsed = {
    minFollowers: opts.minFollowers || null,
    maxFollowers: opts.maxFollowers || null,
    influencerTiers: opts.influencerTiers.length ? opts.influencerTiers : null,
    onlyWithContact: opts.onlyWithContact || null,
    onlyBusinessAccounts: opts.onlyBusinessAccounts || null,
    minLeadGrade: opts.minLeadGrade !== 'D' ? opts.minLeadGrade : null,
    minEngagementRate: opts.minEngagementRate || null,
    includeUnclearEngagement: opts.minEngagementRate ? opts.includeUnclearEngagement : null,
    includePrivateAccounts: opts.includePrivateAccounts,
    bioKeywords: keywords.length ? { mode: opts.keywordMatchMode, keywords: keywords.map((k) => k.keyword) } : null,
    skipPreviouslyScraped: opts.skipPreviouslyScraped ? opts.dedupeStoreName : null,
};

const skip = (reason, sample) => {
    summary.skipReasons[reason] = (summary.skipReasons[reason] ?? 0) + 1;
    const list = (summary.skipSamples[reason] ??= []);
    if (sample && list.length < SAMPLE_LIMIT) list.push(sample);
};
const perSearch = (seed) => (summary.perSearch[seed] ??= { saved: 0, relatedQueued: 0, relatedSaved: 0, skipped: 0 });

let stopReason = null;
const stop = (reason) => {
    if (!stopReason) {
        stopReason = reason;
        log.info(`Stopping: ${reason}`);
    }
};
const shouldStop = () => {
    if (!stopReason && Date.now() >= deadline) stop('timeout_approaching (stopped 45 s early so data is saved)');
    return Boolean(stopReason);
};

// ---------- Previous-runs memory ----------
let seenStore = null;
let seenPrev = new Set();
if (opts.skipPreviouslyScraped) {
    seenStore = await Actor.openKeyValueStore(opts.dedupeStoreName);
    seenPrev = new Set((await seenStore.getValue('SEEN_USERNAMES')) ?? []);
    log.info(`Skip previous runs: ${seenPrev.size} usernames remembered in store "${opts.dedupeStoreName}".`);
}
const saveSeen = async () => {
    if (seenStore) await seenStore.setValue('SEEN_USERNAMES', [...seenPrev]);
};

let finished = false;
const persistState = async () => {
    if (finished) return; // run is complete — never write resume state after the final summary
    await Actor.setValue('STATE', { summary, done: [...done] });
    await saveSeen();
};
Actor.on('migrating', persistState);
Actor.on('persistState', persistState);

// ---------- Build the queue ----------
const queue = [];
const queued = new Set();
for (const raw of opts.usernames) {
    const username = normalizeUsername(raw);
    if (!username) {
        skip('invalid_username', String(raw));
        continue;
    }
    if (queued.has(username)) {
        skip('duplicate_in_input', username);
        continue;
    }
    queued.add(username);
    if (done.has(username)) continue; // already handled before a migration
    queue.push({ username, source: 'input', seed: username, inputValue: String(raw) });
    perSearch(username);
}
summary.uniqueInputUsernames = queued.size;
if (!queue.length && !done.size) log.warning('No valid usernames in the input. Add Instagram handles or profile URLs to "usernames".');
log.info(`Queued ${queue.length} profiles (${opts.usernames.length} given). Concurrency ${CONCURRENCY}, ${proxyConfiguration ? 400 : 60} requests/min.`);

// ---------- Scraping ----------
const client = new InstagramClient({ proxyConfiguration, stats: summary.requests, shouldStop, msLeft });
const savedRows = { fills: summary.fillCounts };

function recordFill(row) {
    for (const f of FILL_RATE_FIELDS) {
        const v = row[f];
        const filled = Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== '';
        if (filled) savedRows.fills[f] = (savedRows.fills[f] ?? 0) + 1;
    }
}

// Saves are serialised so the max-results and max-cost checks are exact under concurrency.
let saveChain = Promise.resolve();
const save = (row, seedInfo) => {
    saveChain = saveChain.then(async () => {
        if (stopReason) {
            skip('not_saved_run_stopping', row.username);
            return;
        }
        if (opts.maxResults && summary.saved >= opts.maxResults) {
            stop('max_results_reached');
            skip('not_saved_run_stopping', row.username);
            return;
        }
        const event = row.has_contact ? EVENT_CONTACT : EVENT_PROFILE;
        if (pricing.isPayPerEvent && charging.calculateMaxEventChargeCountWithinLimit(event) <= 0) {
            stop('max_cost_per_run_reached');
            skip('not_saved_max_cost_reached', row.username);
            return;
        }
        const result = await Actor.pushData(row, event);
        summary.saved += 1;
        summary.chargedEvents[event] += result?.chargedCount ?? 0;
        if (row.has_contact) summary.savedWithContact += 1;
        if (row.source === 'input') summary.savedFromInput += 1;
        else summary.savedFromRelated += 1;
        const ps = perSearch(seedInfo.seed);
        if (row.source === 'input') ps.saved += 1;
        else ps.relatedSaved += 1;
        recordFill(row);
        if (seenStore) seenPrev.add(row.username);
        if (result?.eventChargeLimitReached) stop('max_cost_per_run_reached');
        if (opts.maxResults && summary.saved >= opts.maxResults) stop('max_results_reached');
    });
    return saveChain;
};

const minGradeLetters = { A: ['A'], B: ['A', 'B'], C: ['A', 'B', 'C'], D: ['A', 'B', 'C', 'D'] }[opts.minLeadGrade];

/** Cheap filters that need no extra requests. Returns a skip reason or null. */
function preFilter(row) {
    if (row.is_private && !opts.includePrivateAccounts) return 'filtered_private_account';
    if (opts.minFollowers && (row.followers ?? 0) < opts.minFollowers) return 'filtered_below_min_followers';
    if (opts.maxFollowers && (row.followers ?? 0) > opts.maxFollowers) return 'filtered_above_max_followers';
    if (opts.influencerTiers.length && !opts.influencerTiers.includes(row.influencer_tier)) return 'filtered_influencer_tier';
    if (opts.onlyBusinessAccounts && !row.is_business_account && !row.is_professional_account) return 'filtered_not_business_account';
    if (keywords.length) {
        const m = matchKeywords(keywords, [
            { label: 'bio', text: row.biography },
            { label: 'full name', text: row.full_name },
            { label: 'category', text: row.category },
            { label: 'business category', text: row.business_category },
        ]);
        if (!m.matched) return 'filtered_keyword_mismatch';
        row.keyword_match_evidence = m.evidence;
    }
    if (opts.minEngagementRate) {
        if (row.engagement_rate_pct == null) {
            if (!opts.includeUnclearEngagement) return 'filtered_engagement_unknown';
        } else if (row.engagement_rate_pct < opts.minEngagementRate) return 'filtered_below_min_engagement';
    }
    return null;
}

async function scanLinks(row, session) {
    for (const url of scannableLinks(row)) {
        if (shouldStop()) return;
        const page = await client.fetchPage(url, session);
        if (!page) continue;
        const { emails, phones } = extractFromPage(page.body, page.finalUrl || url);
        for (const e of emails) {
            if (row.all_emails.includes(e.value) || row.emails_from_links.includes(e.value)) continue;
            row.emails_from_links.push(e.value);
            row.contact_evidence.push(`${e.value} ← ${e.evidence}`);
            summary.contactsFromLinkPages += 1;
        }
        for (const p of phones) {
            if ([...row.all_phones, ...row.phones_from_links].some((x) => phoneKey(x) === phoneKey(p.value))) continue;
            row.phones_from_links.push(p.value);
            row.contact_evidence.push(`${p.value} ← ${p.evidence}`);
            summary.contactsFromLinkPages += 1;
        }
        if (row.emails_from_links.length >= 5) break;
    }
    finalizeContacts(row);
}

let lastLoggedAt = 0;
function logProgress(force = false) {
    const n = summary.profilesProcessed;
    if (!force && (n === 0 || n % PROGRESS_EVERY !== 0 || n === lastLoggedAt)) return;
    lastLoggedAt = n;
    const minutes = Math.max((Date.now() - startedAt) / 60000, 1 / 60);
    log.info(`Progress: ${n} processed, ${summary.saved} saved (${summary.savedWithContact} with contact), `
        + `${Math.round(summary.saved / minutes)} saved/min, ${Math.round(n / minutes)} processed/min, queue ${queue.length}, `
        + `blocks so far ${summary.requests.blocked}.`);
}

async function processItem(item, session) {
    const { username } = item;
    if (seenPrev.has(username)) {
        skip('seen_in_previous_run', username);
        return true;
    }
    let user;
    try {
        user = await client.fetchProfile(username, session);
    } catch (err) {
        if (err instanceof StoppedError) {
            summary.profilesProcessed -= 1; // undone by the finally below — it was never processed
            queue.unshift(item); // left for a resumed run
            return false;
        }
        if (err instanceof NotFoundError) skip('not_found_or_unavailable', username);
        else if (err instanceof BlockedError) skip('blocked_after_retries', `${username} (${err.message})`);
        else skip('request_error', `${username} (${err.message})`);
        perSearch(item.seed).skipped += 1;
        return true;
    } finally {
        summary.profilesProcessed += 1;
    }

    const row = buildProfile(user, {
        source: item.source === 'input' ? 'input' : `related:${item.seed}`,
        inputValue: item.inputValue,
        recentPostsLimit: opts.recentPostsLimit,
        excludePinnedPosts: opts.excludePinnedPosts,
        includeRecentPosts: opts.includeRecentPosts,
    });

    // Discovery: queue related profiles from input profiles (one level deep), before filtering.
    if (opts.scrapeRelatedProfiles && item.source === 'input') {
        let added = 0;
        for (const r of row.related_profiles) {
            if (added >= opts.maxRelatedPerProfile) break;
            const u = normalizeUsername(r.username);
            if (!u || queued.has(u)) continue;
            queued.add(u);
            queue.push({ username: u, source: 'related', seed: item.seed, inputValue: `related to @${item.seed}` });
            added += 1;
        }
        perSearch(item.seed).relatedQueued += added;
        if (!row.related_profiles.length) summary.notes.inputProfilesWithNoRelatedShown += 1;
    }

    let reason = preFilter(row);
    if (!reason && opts.scanBioLinks) await scanLinks(row, session);
    if (!reason && opts.onlyWithContact && !row.has_contact) reason = 'filtered_no_contact';
    Object.assign(row, leadScore(row));
    if (!reason && !minGradeLetters.includes(gradeLetter(row.lead_grade))) reason = 'filtered_lead_grade';
    if (reason) {
        skip(reason, username);
        perSearch(item.seed).skipped += 1;
        return true;
    }
    await save(row, item);
    return true;
}

let inFlight = 0;
async function worker() {
    const session = new Session();
    while (true) {
        if (shouldStop()) return;
        const item = queue.shift();
        if (!item) {
            if (inFlight === 0) return;
            await new Promise((r) => setTimeout(r, 200));
            continue;
        }
        inFlight += 1;
        try {
            if (await processItem(item, session)) done.add(item.username);
        } catch (err) {
            log.exception(err, `Unexpected error on @${item.username}`);
            skip('processing_error', `${item.username} (${err.message})`);
        } finally {
            inFlight -= 1;
        }
        logProgress();
        // Whole run is being blocked: stop early instead of burning proxy traffic.
        if (summary.requests.successes === 0 && (summary.skipReasons.blocked_after_retries ?? 0) >= 10) {
            stop('instagram_blocking_all_requests (use the Apify RESIDENTIAL proxy)');
        }
    }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await saveChain;

// ---------- Summary ----------
if (!stopReason) stopReason = 'completed';
if (queue.length && stopReason !== 'completed') summary.notProcessedCount = queue.length;
summary.stopReason = stopReason;
summary.finishedAt = new Date().toISOString();
summary.durationSec = Math.round((Date.now() - startedAt) / 1000);
summary.fillRatesPct = Object.fromEntries(FILL_RATE_FIELDS.map((f) => [
    f, summary.saved ? Math.round(((summary.fillCounts[f] ?? 0) / summary.saved) * 1000) / 10 : 0,
]));
summary.skippedTotal = Object.values(summary.skipReasons).reduce((a, b) => a + b, 0);

finished = true;
await Actor.setValue('RUN_SUMMARY', summary);
await Actor.setValue('STATE', null);
await saveSeen();
logProgress(true);

const statusMsg = `Saved ${summary.saved} profiles (${summary.savedWithContact} with contact). Skipped ${summary.skippedTotal}. Stop reason: ${stopReason}. See RUN_SUMMARY.`;
log.info(statusMsg);
if (summary.saved === 0 && summary.requests.blocked > 0) {
    log.error('Instagram blocked the requests. Use the Apify proxy with the RESIDENTIAL group (Input → Proxy configuration).');
}
await Actor.exit({ statusMessage: statusMsg });
