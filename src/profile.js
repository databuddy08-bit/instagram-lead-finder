// Builds one flat output row from Instagram's raw user object.
import { extractEmails, extractPhones, phonesFromUrl, emailsFromUrl, phoneKey, plain, isUsableEmail } from './contacts.js';
import { parsePosts, engagement, activity, influencerTier } from './scoring.js';

const RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'accounts', 'direct', 'about', 'developer',
    'legal', 'web', 'graphql', 'api', 's', 'challenge', 'privacy', 'emails', 'session']);

/** "@natgeo", "natgeo", "https://instagram.com/natgeo/?hl=en" → "natgeo"; null when not a valid handle. */
export function normalizeUsername(raw) {
    let s = String(raw ?? '').trim();
    if (!s) return null;
    const m = s.match(/instagram\.com\/(?:stories\/|_u\/)?([^/?#\s]+)/i);
    if (m) s = m[1];
    try {
        s = decodeURIComponent(s);
    } catch { /* keep as is */ }
    s = s.replace(/^@+/, '').trim().toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(s) || RESERVED.has(s)) return null;
    return s;
}

const SOCIAL_HOSTS = /(^|\.)(instagram\.com|facebook\.com|fb\.me|fb\.com|threads\.net|tiktok\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|wa\.me|whatsapp\.com|t\.me|spotify\.com|apple\.com|music\.apple\.com|snapchat\.com|pinterest\.com)$/i;

/** Pages worth scanning for contacts (link-in-bio tools, own websites). */
export function scannableLinks(row) {
    const urls = [row.external_url, ...row.bio_links].filter(Boolean);
    const out = [];
    for (const u of urls) {
        try {
            const url = new URL(u);
            if (!/^https?:$/.test(url.protocol) || SOCIAL_HOSTS.test(url.hostname)) continue;
            if (!out.some((x) => new URL(x).href === url.href)) out.push(url.href);
        } catch { /* invalid URL */ }
    }
    return out.slice(0, 3);
}

function businessAddress(user) {
    if (!user.business_address_json) return null;
    try {
        const a = typeof user.business_address_json === 'string' ? JSON.parse(user.business_address_json) : user.business_address_json;
        const parts = [a.street_address, a.city_name, a.region_name, a.zip_code, a.country_code].filter((x) => x && String(x).trim());
        return parts.length ? parts.join(', ') : null;
    } catch {
        return null;
    }
}

function businessPhone(user) {
    if (user.business_phone_number) return String(user.business_phone_number).trim();
    if (user.public_phone_number) {
        const cc = user.public_phone_country_code ? `+${String(user.public_phone_country_code).replace(/\D/g, '')}` : '';
        return `${cc}${String(user.public_phone_number).replace(/\D/g, '')}`;
    }
    if (user.contact_phone_number) return String(user.contact_phone_number).trim();
    return null;
}

/**
 * @param {object} user  raw Instagram user
 * @param {object} meta  { source, inputValue, recentPostsLimit, excludePinnedPosts, includeRecentPosts }
 */
export function buildProfile(user, meta) {
    const followers = user.edge_followed_by?.count ?? null;
    const bioLinks = (user.bio_links ?? []).map((l) => l?.url).filter(Boolean);
    const posts = parsePosts(user);
    const eng = engagement(user, posts, { limit: meta.recentPostsLimit, excludePinned: meta.excludePinnedPosts });
    const act = activity(posts);

    const bio = user.biography ?? '';
    const evidence = [];
    const emailsFound = extractEmails(bio, 'bio');
    const phonesFound = extractPhones(bio, 'bio');
    // Contacts hidden in bio link URLs (mailto:, tel:, wa.me)
    for (const u of [user.external_url, ...bioLinks]) {
        for (const e of emailsFromUrl(u, 'bio link')) if (!emailsFound.some((x) => x.value === e.value)) emailsFound.push(e);
        for (const p of phonesFromUrl(u, 'bio link')) if (!phonesFound.some((x) => phoneKey(x.value) === phoneKey(p.value))) phonesFound.push(p);
    }
    emailsFound.forEach((e) => evidence.push(`${e.value} ← ${e.evidence}`));
    phonesFound.forEach((p) => evidence.push(`${p.value} ← ${p.evidence}`));

    const bizEmailRaw = user.business_email ? String(user.business_email).trim().toLowerCase() : null;
    const bizEmail = bizEmailRaw && isUsableEmail(bizEmailRaw) ? bizEmailRaw : null;
    const bizPhone = businessPhone(user);
    if (bizEmail) evidence.push(`${bizEmail} ← Instagram business contact (email button)`);
    if (bizPhone) evidence.push(`${bizPhone} ← Instagram business contact (call button)`);

    const row = {
        status: 'ok',
        username: user.username,
        full_name: plain(user.full_name).trim() || null,
        profile_url: `https://www.instagram.com/${user.username}/`,
        user_id: user.id ?? null,
        biography: bio || null,
        followers,
        following: user.edge_follow?.count ?? null,
        posts_count: user.edge_owner_to_timeline_media?.count ?? null,
        is_verified: Boolean(user.is_verified),
        is_business_account: Boolean(user.is_business_account),
        is_professional_account: Boolean(user.is_professional_account),
        is_private: Boolean(user.is_private),
        category: user.category_name || user.overall_category_name || null,
        business_category: user.business_category_name || null,
        business_address: businessAddress(user),
        external_url: user.external_url || null,
        bio_links: bioLinks,
        profile_pic_url: user.profile_pic_url ?? null,
        profile_pic_url_hd: user.profile_pic_url_hd ?? user.profile_pic_url ?? null,
        igtv_count: user.edge_felix_video_timeline?.count ?? null,
        highlight_reel_count: user.highlight_reel_count ?? null,
        has_reels: typeof user.has_clips === 'boolean' ? user.has_clips : null,
        pronouns: Array.isArray(user.pronouns) ? user.pronouns : [],
        business_email: bizEmail,
        business_phone: bizPhone,
        emails_found: emailsFound.map((e) => e.value),
        phones_found: phonesFound.map((p) => p.value),
        emails_from_links: [],
        phones_from_links: [],
        all_emails: [],
        all_phones: [],
        primary_email: null,
        primary_phone: null,
        has_contact: false,
        contact_evidence: evidence,
        ...eng,
        ...act,
        influencer_tier: influencerTier(followers),
        lead_score: null,
        lead_grade: null,
        lead_score_reasons: [],
        keyword_match_evidence: null,
        related_profiles: (user.edge_related_profiles?.edges ?? []).map(({ node: n }) => ({
            username: n.username,
            full_name: n.full_name || null,
            is_verified: Boolean(n.is_verified),
            is_private: Boolean(n.is_private),
            profile_url: `https://www.instagram.com/${n.username}/`,
            profile_pic_url: n.profile_pic_url ?? null,
        })).filter((r) => r.username),
        related_profiles_count: 0,
        recent_posts: meta.includeRecentPosts ? posts.slice(0, meta.recentPostsLimit) : [],
        error: null,
        fix_hint: null,
        source: meta.source,
        input_value: meta.inputValue,
        scraped_at: new Date().toISOString(),
    };
    row.related_profiles_count = row.related_profiles.length;
    finalizeContacts(row);
    return row;
}

/** Merges every contact source into all_* / primary_* (business contact first). */
export function finalizeContacts(row) {
    const emails = [row.business_email, ...row.emails_found, ...row.emails_from_links].filter(Boolean);
    row.all_emails = [...new Set(emails)];
    const phones = [];
    for (const p of [row.business_phone, ...row.phones_found, ...row.phones_from_links].filter(Boolean)) {
        if (!phones.some((x) => phoneKey(x) === phoneKey(p))) phones.push(p);
    }
    row.all_phones = phones;
    row.primary_email = row.all_emails[0] ?? null;
    row.primary_phone = row.all_phones[0] ?? null;
    row.has_contact = Boolean(row.primary_email || row.primary_phone);
    return row;
}
