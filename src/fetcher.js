// HTTP layer: rate limiting, proxy sessions, block detection and retries.
import { gotScraping } from 'got-scraping';
import { log } from 'apify';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const IG_APP_ID = '936619743392459';
const MOBILE_UA = 'Instagram 337.0.0.0.77 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 609412000)';
// IG_API_BASE is only used by the local test suite (mock Instagram server).
const WWW = process.env.IG_API_BASE ?? 'https://www.instagram.com';
const API = process.env.IG_API_BASE ?? 'https://i.instagram.com';
// Each retry uses a new IP and the next request style, so one blocked style doesn't sink the profile.
const VARIANTS = [
    { base: WWW, mobile: false },
    { base: API, mobile: false },
    { base: WWW, mobile: true },
    { base: API, mobile: true },
];

const BLOCK_STATUSES = new Set([401, 403, 429, 999]);
const SESSION_MAX_USES = 15; // rotate IP after this many successful requests

export class NotFoundError extends Error {}
export class BlockedError extends Error {
    constructor(message, details) {
        super(message);
        this.details = details;
    }
}
export class StoppedError extends Error {}

/** Spaces requests evenly so we never exceed N requests per minute (shared by all workers). */
export class RateLimiter {
    constructor(perMinute) {
        this.interval = 60000 / perMinute;
        this.next = 0;
    }

    async wait() {
        const now = Date.now();
        const slot = Math.max(now, this.next);
        this.next = slot + this.interval;
        if (slot > now) await sleep(slot - now);
    }
}

const newSessionId = () => `s${Math.random().toString(36).slice(2, 12)}`;

/** Per-worker proxy session: sticky IP until it is blocked or used SESSION_MAX_USES times. */
export class Session {
    constructor() {
        this.rotate();
    }

    rotate() {
        this.id = newSessionId();
        this.uses = 0;
    }

    used() {
        this.uses += 1;
        if (this.uses >= SESSION_MAX_USES) this.rotate();
    }
}

export class InstagramClient {
    /**
     * @param {object} p
     * @param {import('apify').ProxyConfiguration|undefined} p.proxyConfiguration
     * @param {object} p.stats  shared request counters (written into RUN_SUMMARY)
     * @param {() => boolean} p.shouldStop
     * @param {() => number} p.msLeft  milliseconds until the clean-stop deadline
     */
    constructor({ proxyConfiguration, stats, shouldStop, msLeft }) {
        this.proxy = proxyConfiguration;
        this.useProxy = Boolean(proxyConfiguration);
        this.limiter = new RateLimiter(this.useProxy ? 400 : 60);
        this.linkLimiter = new RateLimiter(this.useProxy ? 600 : 120);
        this.maxRetries = this.useProxy ? 11 : 5; // 12 attempts with a proxy
        this.stats = stats;
        this.shouldStop = shouldStop;
        this.msLeft = msLeft;
    }

    async proxyUrl(session) {
        return this.proxy ? this.proxy.newUrl(session.id) : undefined;
    }

    /** Waits before a retry: ~1 s on a fresh IP with a proxy, exponential backoff without one. */
    async retryDelay(attempt) {
        const ms = this.useProxy
            ? 800 + Math.random() * 400
            : Math.min(60000, 2000 * 2 ** attempt) + Math.random() * 1000;
        await sleep(Math.max(0, Math.min(ms, this.msLeft() - 1000)));
    }

    /** Returns Instagram's raw `user` object, or throws NotFoundError / BlockedError / StoppedError. */
    async fetchProfile(username, session) {
        let lastProblem = 'unknown';
        const problems = {};
        const note = (p) => {
            lastProblem = p;
            problems[p] = (problems[p] ?? 0) + 1;
        };
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (this.shouldStop()) throw new StoppedError('stopping');
            await this.limiter.wait();
            const variant = VARIANTS[attempt % VARIANTS.length];
            const url = `${variant.base}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
            this.stats.requests += 1;
            if (attempt > 0) this.stats.retries += 1;

            let response;
            try {
                const style = variant.mobile
                    ? {
                        useHeaderGenerator: false,
                        headers: { 'user-agent': MOBILE_UA, 'x-ig-app-id': IG_APP_ID, accept: '*/*', 'accept-language': 'en-US' },
                    }
                    : {
                        headers: {
                            'x-ig-app-id': IG_APP_ID,
                            'x-requested-with': 'XMLHttpRequest',
                            accept: '*/*',
                            referer: `https://www.instagram.com/${username}/`,
                        },
                        headerGeneratorOptions: {
                            browsers: [{ name: 'chrome', minVersion: 120 }],
                            devices: ['desktop'],
                            operatingSystems: ['windows', 'macos'],
                        },
                    };
                response = await gotScraping({
                    url,
                    proxyUrl: await this.proxyUrl(session),
                    ...style,
                    followRedirect: false,
                    throwHttpErrors: false,
                    retry: { limit: 0 },
                    timeout: { request: 20000 },
                });
            } catch (err) {
                note(`network error ${err.code || err.message}`);
                this.stats.networkErrors += 1;
                session.rotate();
                await this.retryDelay(attempt);
                continue;
            }

            const { statusCode } = response;
            let json = null;
            try {
                json = JSON.parse(response.body);
            } catch {
                /* not JSON = login page or error page */
            }

            if (statusCode === 404) throw new NotFoundError('404');
            if (statusCode === 200 && json?.data && 'user' in json.data) {
                if (!json.data.user) throw new NotFoundError('user is null');
                session.used();
                this.stats.successes += 1;
                return json.data.user;
            }

            const blocked = BLOCK_STATUSES.has(statusCode)
                || (statusCode >= 300 && statusCode < 400)
                || json?.require_login === true
                || (statusCode === 200 && !json);
            const igMessage = json?.message ? ` "${String(json.message).slice(0, 80)}"` : '';
            if (blocked) {
                this.stats.blocked += 1;
                note(statusCode >= 300 && statusCode < 400 ? `HTTP ${statusCode} redirect to login` : `HTTP ${statusCode}${igMessage}`);
            } else {
                this.stats.serverErrors += 1;
                note(`HTTP ${statusCode}${igMessage}`);
            }
            session.rotate(); // retire session -> next attempt gets a new IP
            if (attempt < this.maxRetries) await this.retryDelay(attempt);
        }
        const breakdown = Object.entries(problems).map(([p, n]) => `${n}× ${p}`).join('; ');
        throw new BlockedError(`all ${this.maxRetries + 1} attempts failed (${breakdown})`, { lastProblem, problems });
    }

    /** Fetches a link-in-bio / website page as text. Returns null on any failure (never throws). */
    async fetchPage(url, session) {
        for (let attempt = 0; attempt < 2; attempt++) {
            if (this.shouldStop()) return null;
            await this.linkLimiter.wait();
            this.stats.linkRequests += 1;
            try {
                const res = await gotScraping({
                    url,
                    proxyUrl: await this.proxyUrl(session),
                    followRedirect: true,
                    maxRedirects: 5,
                    throwHttpErrors: false,
                    retry: { limit: 0 },
                    timeout: { request: 12000 },
                    headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'] },
                });
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    return { finalUrl: res.url, body: String(res.body).slice(0, 2_000_000) };
                }
                if (!BLOCK_STATUSES.has(res.statusCode)) return null;
            } catch (err) {
                log.debug(`Link fetch failed ${url}: ${err.message}`);
            }
            session.rotate();
            await sleep(1000);
        }
        return null;
    }
}
