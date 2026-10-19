// End-to-end test against the local Instagram mock: `node test/integration.js`
// Runs the real actor (src/main.js) as a child process with pay-per-event simulation turned on.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMock } from './mock-instagram.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PRICES = { 'profile-lead': 0.005, 'profile-lead-with-contact': 0.012 };
const pricingInfo = JSON.stringify({
    pricingModel: 'PAY_PER_EVENT',
    pricingPerEvent: { actorChargeEvents: Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, { eventPriceUsd: v, eventTitle: k }])) },
});

const readDir = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : []);

async function runActor(name, input, { mock, env = {}, keepStorage = false, storage } = {}) {
    const dir = storage ?? join(ROOT, 'storage-test', name);
    if (!keepStorage) rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'key_value_stores', 'default'), { recursive: true });
    writeFileSync(join(dir, 'key_value_stores', 'default', 'INPUT.json'), JSON.stringify(input));
    const started = Date.now();
    const child = spawn('node', ['src/main.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '',
            CRAWLEE_STORAGE_DIR: dir, APIFY_LOCAL_STORAGE_DIR: dir, CRAWLEE_PURGE_ON_START: '0',
            IG_API_BASE: mock.base,
            ACTOR_TEST_PAY_PER_EVENT: 'true', ACTOR_USE_CHARGING_LOG_DATASET: 'true',
            APIFY_ACTOR_PRICING_INFO: pricingInfo, APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
            ...env,
        },
    });
    let logs = '';
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });
    const code = await new Promise((r) => child.on('close', r));
    writeFileSync(join(dir, `run-${name}.log`), logs);
    const rows = readDir(join(dir, 'datasets', 'default'));
    const items = rows.filter((x) => x.status === 'ok');
    const failed = rows.filter((x) => x.status !== 'ok');
    const charges = readDir(join(dir, 'datasets', 'charging_log'));
    const summaryPath = join(dir, 'key_value_stores', 'default', 'RUN_SUMMARY.json');
    const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null;
    return { code, items, failed, charges, summary, logs, secs: Math.round((Date.now() - started) / 100) / 10 };
}

const results = [];
const check = (label, ok, detail = '') => {
    results.push({ label, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const chargedTotal = (charges) => charges.reduce((s, c) => s + (c.count ?? 1), 0);

const proxy = (mock) => ({ useApifyProxy: false, proxyUrls: [mock.proxyUrl] });
const generic = Array.from({ length: 110 }, (_, i) => `creator_${String(i).padStart(3, '0')}`);
const specials = ['hidden_likes_creator', 'private_person', 'sleepy_brand', 'ghost_account_404', 'deleted_user_null', 'blocked_forever'];
const seeds = ['seed_fitness', 'seed_travel', 'seed_shop'];

// ---------- 1. Main realistic run ----------
{
    const mock = await startMock({ blockRate: 0.15 });
    const input = {
        usernames: [...seeds, ...generic, ...specials, '@Creator_000', 'https://www.instagram.com/creator_001/?hl=en', 'https://instagram.com/p/XYZ/', 'bad handle!'],
        scrapeRelatedProfiles: true, maxRelatedPerProfile: 5, scanBioLinks: true,
        proxyConfiguration: proxy(mock),
    };
    const r = await runActor('main', input, { mock });
    mock.close();
    const s = r.summary;
    console.log(`\n=== 1. MAIN RUN (${r.secs}s, exit ${r.code}) ===`);
    check('run exits cleanly (SUCCEEDED)', r.code === 0);
    check('RUN_SUMMARY written', Boolean(s));
    check('rows saved = summary.saved', r.items.length === s.saved, `${r.items.length} rows`);
    check('charged events = output rows', chargedTotal(r.charges) === r.items.length, `${chargedTotal(r.charges)} charges`);
    check('contact rows charged as contact event', r.items.filter((x) => x.has_contact).length === r.charges.filter((c) => c.eventName === 'profile-lead-with-contact').length);
    check('no duplicate usernames', new Set(r.items.map((x) => x.username)).size === r.items.length);
    check('URL/@ duplicates removed', s.skipReasons.duplicate_in_input === 2);
    check('invalid inputs reported', s.skipReasons.invalid_username === 2);
    check('404 + null user reported as not found (not charged)', s.skipReasons.not_found_or_unavailable === 2);
    check('permanently blocked profile reported', s.skipReasons.blocked_after_retries === 1);
    check('blocks were retried and recovered', s.requests.blocked > 10 && s.requests.successes >= r.items.length, `${s.requests.blocked} blocks, ${s.requests.retries} retries`);
    check('related profiles discovered (3 seeds × 5)', s.savedFromRelated === 15);
    check('private account: engagement empty, not guessed', r.items.find((x) => x.username === 'private_person')?.engagement_rate_pct === null);
    check('hidden likes: engagement empty with note', r.items.find((x) => x.username === 'hidden_likes_creator')?.engagement_note === 'account hides like counts');
    check('no fake phones from "2012-2024 / 12345678"', r.items.filter((x) => /Est\. 2012/.test(x.biography ?? '')).every((x) => x.phones_found.length === 0));
    check('platform email support@linktr.ee never captured', r.items.every((x) => !x.all_emails.includes('support@linktr.ee')));
    check('every contact has evidence', r.items.every((x) => x.all_emails.length + x.all_phones.length <= x.contact_evidence.length));
    check('failed inputs shown as uncharged rows with a fix hint', r.failed.length === 5 && r.failed.every((x) => x.fix_hint && x.error), JSON.stringify(r.failed.map((x) => x.status)));
    check('charges only for ok rows', chargedTotal(r.charges) === r.items.length);
    check('progress logged every 50', (r.logs.match(/Progress: \d+ processed/g) ?? []).length >= 2);
    console.log('\nFill rates (% of saved rows):', JSON.stringify(s.fillRatesPct));
    const sample = r.items.find((x) => x.has_contact && x.emails_from_links.length && x.recent_posts.length) ?? r.items[0];
    console.log('\nSample row:\n', JSON.stringify({ ...sample, recent_posts: sample.recent_posts.slice(0, 2) }, null, 2));
    const { skipSamples, fillCounts, fillRatesPct, ...compact } = s;
    console.log('\nRUN_SUMMARY:\n', JSON.stringify({ ...compact, perSearch: Object.fromEntries(Object.entries(s.perSearch).slice(0, 4)), perSearchCount: Object.keys(s.perSearch).length }, null, 2));
    writeFileSync(join(ROOT, 'storage-test', 'main-sample.json'), JSON.stringify({ sample, summary: s }, null, 2));
}

// ---------- 2. Filters: with vs without, and every kept row verified ----------
{
    console.log('\n=== 2. FILTERS (with vs without) ===');
    const base = { usernames: generic, scanBioLinks: false };
    const runs = {
        none: {},
        keyword: { bioKeywords: ['fitness coach', 'e-commerce'], keywordMatchMode: 'exact' },
        contact: { onlyWithContact: true },
        tier: { influencerTiers: ['micro', 'macro'] },
        followers: { minFollowers: 5000, maxFollowers: 200000 },
        business: { onlyBusinessAccounts: true },
        grade: { minLeadGrade: 'B' },
        engagement: { minEngagementRate: 2, includeUnclearEngagement: false },
    };
    const out = {};
    for (const [name, extra] of Object.entries(runs)) {
        const mock = await startMock({ blockRate: 0 });
        out[name] = await runActor(`filter-${name}`, { ...base, ...extra, proxyConfiguration: proxy(mock) }, { mock });
        mock.close();
    }
    const n = (k) => out[k].items.length;
    const all = out.none.items;
    console.log(`Rows — none:${n('none')} keyword:${n('keyword')} contact:${n('contact')} tier:${n('tier')} followers:${n('followers')} business:${n('business')} grade:${n('grade')} engagement:${n('engagement')}`);
    check('keyword filter: rows reduced and all have evidence', n('keyword') < n('none') && out.keyword.items.every((x) => x.keyword_match_evidence));
    check('keyword filter: matches equal expected from unfiltered run', n('keyword') === all.filter((x) => /fitness coach|e-commerce/i.test(x.biography ?? '')).length);
    check('contact filter: all rows have contact', n('contact') < n('none') && out.contact.items.every((x) => x.has_contact));
    check('tier filter: only micro/macro', out.tier.items.every((x) => ['micro', 'macro'].includes(x.influencer_tier)) && n('tier') === all.filter((x) => ['micro', 'macro'].includes(x.influencer_tier)).length);
    check('follower range respected', out.followers.items.every((x) => x.followers >= 5000 && x.followers <= 200000));
    check('business filter respected', out.business.items.every((x) => x.is_business_account || x.is_professional_account));
    check('grade filter: only A/B', out.grade.items.every((x) => /^[AB]/.test(x.lead_grade)));
    check('engagement filter: all ≥ 2% and unknown excluded', out.engagement.items.every((x) => x.engagement_rate_pct >= 2));
    check('skip reasons account for every filtered row', Object.entries(out).every(([, r]) => r.summary.saved + r.summary.skippedTotal === generic.length));
    console.log('Keyword run skip reasons:', JSON.stringify(out.keyword.summary.skipReasons));
    console.log('Keyword evidence example:', out.keyword.items[0]?.keyword_match_evidence);
}

// ---------- 3. Max cost per run ----------
{
    console.log('\n=== 3. MAX COST PER RUN (locally the SDK prices every event at $1, so $20 = 20 events) ===');
    const mock = await startMock({ blockRate: 0 });
    const r = await runActor('maxcost', { usernames: generic, proxyConfiguration: proxy(mock) }, { mock, env: {
        ACTOR_MAX_TOTAL_CHARGE_USD: '20',
        // Local SDK budgets with $1/event but sums real prices, so use $1 prices here to keep both consistent.
        APIFY_ACTOR_PRICING_INFO: JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { 'profile-lead': { eventPriceUsd: 1, eventTitle: 'a' }, 'profile-lead-with-contact': { eventPriceUsd: 1, eventTitle: 'b' } } } }),
    } });
    mock.close();
    check('stops cleanly at max cost', r.code === 0 && r.summary.stopReason === 'max_cost_per_run_reached', `saved ${r.items.length}, charged events ${chargedTotal(r.charges)}`);
    check('never charges above the limit (exactly 20 events)', chargedTotal(r.charges) === 20 && r.items.length === 20);
    check('charged events = output rows', chargedTotal(r.charges) === r.items.length);
}

// ---------- 4. Max results ----------
{
    console.log('\n=== 4. MAX RESULTS (20) ===');
    const mock = await startMock({ blockRate: 0.1 });
    const r = await runActor('maxresults', { usernames: generic, maxResults: 20, proxyConfiguration: proxy(mock) }, { mock });
    mock.close();
    check('exactly 20 rows and 20 charges', r.items.length === 20 && chargedTotal(r.charges) === 20);
}

// ---------- 5. Skip items from previous runs ----------
{
    console.log('\n=== 5. SKIP PREVIOUS RUNS ===');
    const storage = join(ROOT, 'storage-test', 'dedupe');
    rmSync(storage, { recursive: true, force: true });
    const mock = await startMock({ blockRate: 0 });
    const inp = { usernames: generic.slice(0, 30), skipPreviouslyScraped: true, dedupeStoreName: 'test-seen', proxyConfiguration: proxy(mock) };
    const first = await runActor('dedupe1', inp, { mock, storage, keepStorage: true });
    const firstRows = first.items.length;
    const second = await runActor('dedupe2', { ...inp, usernames: generic.slice(0, 40) }, { mock, storage, keepStorage: true });
    mock.close();
    const newRows = second.items.length - firstRows; // default dataset is shared in this storage dir
    check('second run skips the 30 seen profiles and saves only the 10 new ones', second.summary.skipReasons.seen_in_previous_run === 30 && second.summary.saved === 10, `first ${firstRows}, second saved ${second.summary.saved}`);
    void newRows;
}

// ---------- 6. Clean stop before timeout ----------
{
    console.log('\n=== 6. TIMEOUT (ACTOR_TIMEOUT_AT = now + 60 s, slow site) ===');
    const mock = await startMock({ blockRate: 0, delayMs: 1500 });
    const many = Array.from({ length: 600 }, (_, i) => `slow_${i}`);
    const r = await runActor('timeout', { usernames: many, proxyConfiguration: proxy(mock) }, { mock, env: { ACTOR_TIMEOUT_AT: new Date(Date.now() + 60000).toISOString() } });
    mock.close();
    check('stops ~45 s before timeout with data saved', r.code === 0 && /timeout_approaching/.test(r.summary.stopReason) && r.items.length > 0 && r.secs < 25, `${r.secs}s, ${r.items.length} saved, ${r.summary.notProcessedCount} left`);
}

// ---------- 7. Everything blocked ----------
{
    console.log('\n=== 7. INSTAGRAM BLOCKS EVERYTHING ===');
    const mock = await startMock({ blockRate: 1 });
    const r = await runActor('allblocked', { usernames: generic, proxyConfiguration: proxy(mock) }, { mock });
    mock.close();
    check('gives up early with a clear reason, nothing charged', r.code === 0 && /blocking_all_requests/.test(r.summary.stopReason) && r.charges.length === 0, `${r.secs}s, ${r.summary.requests.requests} requests`);
}

// ---------- 8. Single profile that Instagram keeps blocking (the "no output at all" case) ----------
{
    console.log('\n=== 8. ONE PROFILE, ALWAYS BLOCKED ===');
    const mock = await startMock({ blockRate: 0 });
    const r = await runActor('single-blocked', { usernames: ['blocked_forever'], proxyConfiguration: proxy(mock) }, { mock });
    mock.close();
    const row = r.failed[0];
    check('output still shows a row explaining why', r.code === 0 && r.failed.length === 1 && row.status === 'blocked', row?.error);
    check('row tells the user to switch to RESIDENTIAL', /RESIDENTIAL/.test(row?.fix_hint ?? ''), row?.fix_hint);
    check('all 12 attempts used, nothing charged', mock.hits.perUser.blocked_forever === 12 && r.charges.length === 0, `${mock.hits.perUser.blocked_forever} attempts`);
    check('status message names the block', /blocked the requests/.test(r.logs));
}

// ---------- 9. Blocked on desktop style, works on mobile style ----------
{
    console.log('\n=== 9. ROTATING REQUEST STYLES ===');
    const mock = await startMock({ blockRate: 0, blockDesktop: true });
    const r = await runActor('mobile-fallback', { usernames: ['creator_001', 'creator_002'], proxyConfiguration: proxy(mock) }, { mock });
    mock.close();
    check('profiles saved via the mobile request style', r.items.length === 2, `${mock.hits.api} requests`);
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
