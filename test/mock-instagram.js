// Local mock of Instagram's web_profile_info API + link-in-bio pages + a forward proxy.
// Used only by test/integration.js — mimics the real response shape and Instagram's blocking behaviour.
import http from 'node:http';

let seed = 42;
const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const BIOS = [
    (u) => `Fitness coach 💪 Online programs\n📧 ${u}@gmail.com`,
    () => 'Travel | Photography 📸 Based in Lisbon',
    (u, r) => `Bookings: hello [at] ${u.replace(/[._]/g, '')} [dot] com\nWhatsApp +44 7700 900${Math.floor(100 + r() * 899)}`,
    () => 'E-commerce brand for sustainable home goods 🌿 Free shipping',
    () => 'Est. 2012-2024 • 12345678 happy customers', // looks numeric, must NOT become a phone
    () => '📞 (555) 201-3344 | Real estate agent in Austin TX',
    () => 'Just vibes ✨',
    (u) => `𝗖𝗼𝗹𝗹𝗮𝗯𝘀: ${u}@creator.co`,
];

function makeUser(username, opts = {}) {
    // Deterministic per username, so filtered and unfiltered runs see identical profiles.
    let h = 0;
    for (const ch of username) h = (h * 31 + ch.charCodeAt(0)) % 2147483647;
    let s = h || 1;
    const rand = () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
    };
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const followers = opts.followers ?? Math.floor(10 ** (2.5 + rand() * 4.5));
    const isPrivate = opts.private ?? rand() < 0.08;
    const isBiz = rand() < 0.55;
    const hasLinkPage = rand() < 0.4;
    const now = Math.floor(Date.now() / 1000);
    const posts = isPrivate ? [] : Array.from({ length: 12 }, (_, i) => {
        const isReel = rand() < 0.4;
        return {
            node: {
                __typename: isReel ? 'GraphVideo' : pick(['GraphImage', 'GraphSidecar']),
                id: `${username}${i}`,
                shortcode: `C${username.slice(0, 4)}${i}x`,
                is_video: isReel,
                product_type: isReel ? 'clips' : 'feed',
                video_view_count: isReel ? Math.floor(followers * (0.2 + rand())) : undefined,
                edge_liked_by: { count: Math.floor(followers * (0.005 + rand() * 0.06)) },
                edge_media_preview_like: { count: 0 },
                edge_media_to_comment: { count: Math.floor(followers * rand() * 0.004) },
                edge_media_to_caption: { edges: [{ node: { text: `Post ${i} by ${username} #lead` } }] },
                taken_at_timestamp: now - (i * 3 + Math.floor(rand() * 4) + (opts.inactive ? 200 : 0)) * 86400,
                display_url: `https://cdn.example/${username}/${i}.jpg`,
                pinned_for_users: i === 0 && rand() < 0.3 ? [{ id: '1' }] : [],
            },
        };
    });
    return {
        id: String(Math.floor(rand() * 1e10)),
        username,
        full_name: username.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        biography: opts.bio ?? pick(BIOS)(username, rand),
        bio_links: hasLinkPage ? [{ title: 'My links', url: `${opts.base}/links/${username}`, link_type: 'external' }] : [],
        external_url: hasLinkPage ? `${opts.base}/links/${username}` : (rand() < 0.3 ? `https://${username}.com` : null),
        edge_followed_by: { count: followers },
        edge_follow: { count: Math.floor(rand() * 2000) },
        is_private: isPrivate,
        is_verified: followers > 500000 && rand() < 0.6,
        is_business_account: isBiz,
        is_professional_account: isBiz || rand() < 0.3,
        business_email: isBiz && rand() < 0.35 ? `contact@${username.replace(/[._]/g, '')}.com` : null,
        business_phone_number: isBiz && rand() < 0.2 ? `+1415555${Math.floor(1000 + rand() * 8999)}` : null,
        business_category_name: isBiz ? pick(['Creators & Celebrities', 'Local Business', 'Shopping & Retail', null]) : null,
        category_name: isBiz ? pick(['Fitness Trainer', 'Photographer', 'Real Estate Agent', 'Shopping & retail', 'Digital creator']) : null,
        business_address_json: isBiz && rand() < 0.3 ? JSON.stringify({ city_name: 'Austin', street_address: '100 Congress Ave', zip_code: '78701', region_name: '', country_code: 'US' }) : null,
        hide_like_and_view_counts: opts.hideLikes ?? false,
        highlight_reel_count: Math.floor(rand() * 12),
        has_clips: true,
        pronouns: rand() < 0.2 ? ['she', 'her'] : [],
        profile_pic_url: `https://cdn.example/${username}/pic_s.jpg`,
        profile_pic_url_hd: `https://cdn.example/${username}/pic_hd.jpg`,
        edge_felix_video_timeline: { count: Math.floor(rand() * 5), edges: [] },
        edge_owner_to_timeline_media: { count: isPrivate ? Math.floor(rand() * 300) : 12 + Math.floor(rand() * 2000), edges: posts },
        edge_related_profiles: { edges: (opts.related ?? []).map((r) => ({ node: { id: '1', username: r, full_name: r, is_verified: false, is_private: false, profile_pic_url: 'x' } })) },
    };
}

export function startMock({ blockRate = 0.15, delayMs = 0 } = {}) {
    const users = new Map();
    const hits = { api: 0, blocked: 0, links: 0, proxied: 0, perUser: {} };
    const alwaysBlocked = new Set(['blocked_forever']);
    const missing = new Set(['ghost_account_404', 'deleted_user_null']);
    let base = '';

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (url.pathname === '/api/v1/users/web_profile_info/') {
            hits.api += 1;
            const u = url.searchParams.get('username');
            hits.perUser[u] = (hits.perUser[u] ?? 0) + 1;
            if (!req.headers['x-ig-app-id']) {
                res.writeHead(400).end('{"message":"useragent mismatch","status":"fail"}');
                return;
            }
            if (alwaysBlocked.has(u) || rand() < blockRate) {
                hits.blocked += 1;
                const kind = rand();
                if (kind < 0.5) res.writeHead(429, { 'content-type': 'application/json' }).end('{"message":"Please wait a few minutes before you try again.","require_login":true,"status":"fail"}');
                else if (kind < 0.8) res.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"Please wait a few minutes before you try again.","require_login":true,"status":"fail"}');
                else res.writeHead(302, { location: 'https://www.instagram.com/accounts/login/' }).end();
                return;
            }
            if (u === 'ghost_account_404') {
                res.writeHead(404).end('');
                return;
            }
            if (u === 'deleted_user_null') {
                res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{"user":null},"status":"ok"}');
                return;
            }
            if (!users.has(u)) {
                const special = {
                    hidden_likes_creator: { hideLikes: true },
                    private_person: { private: true },
                    sleepy_brand: { inactive: true },
                };
                const related = u.startsWith('seed_') ? Array.from({ length: 6 }, (_, i) => `${u.replace('seed_', 'rel_')}_${i}`) : [];
                users.set(u, makeUser(u, { base, related, ...(special[u] ?? {}) }));
            }
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { user: users.get(u) }, status: 'ok' }));
            return;
        }
        if (url.pathname.startsWith('/links/')) {
            hits.links += 1;
            const u = url.pathname.split('/')[2];
            const n = u.length;
            res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><body>
              <a href="mailto:${u.replace(/[._]/g, '')}.team@outlook.com?subject=Collab">Email me</a>
              ${n % 2 ? `<a href="https://wa.me/9198765${String(10000 + n * 37).slice(0, 5)}">WhatsApp</a>` : ''}
              <script id="__NEXT_DATA__" type="application/json">{"props":{"account":{"contactEmail":"press@${u.replace(/[._]/g, '')}.studio"}}}</script>
              <footer>Questions? support@linktr.ee</footer></body></html>`);
            return;
        }
        res.writeHead(404).end('not found');
    });

    // Minimal forward proxy (absolute-form HTTP requests) so the actor runs in "with proxy" mode.
    const proxy = http.createServer((req, res) => {
        hits.proxied += 1;
        const target = new URL(req.url);
        const up = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers }, (r) => {
            res.writeHead(r.statusCode, r.headers);
            r.pipe(res);
        });
        up.on('error', () => res.writeHead(502).end());
        req.pipe(up);
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            base = `http://127.0.0.1:${server.address().port}`;
            proxy.listen(0, '127.0.0.1', () => {
                resolve({
                    base,
                    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
                    hits,
                    close: () => {
                        server.close();
                        proxy.close();
                    },
                });
            });
        });
    });
}
