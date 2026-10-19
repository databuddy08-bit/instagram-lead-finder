// Unit tests: `npm test`
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEmails, extractPhones, phonesFromUrl, extractFromPage } from '../src/contacts.js';
import { compileKeyword, matchKeywords } from '../src/keywords.js';
import { influencerTier, leadScore } from '../src/scoring.js';
import { normalizeUsername } from '../src/profile.js';

const values = (arr) => arr.map((x) => x.value);

test('emails: plain, fancy unicode font, obfuscated, junk filtered', () => {
    assert.deepEqual(values(extractEmails('Collabs: hello@brand.co.uk ✨', 'bio')), ['hello@brand.co.uk']);
    assert.deepEqual(values(extractEmails('📧 𝗶𝗻𝗳𝗼＠𝗯𝗿𝗮𝗻𝗱.𝗰𝗼𝗺', 'bio')), ['info@brand.com']);
    assert.deepEqual(values(extractEmails('mail me: jane [at] studio [dot] com', 'bio')), ['jane@studio.com']);
    assert.deepEqual(values(extractEmails('bookings (at) dj-mike.com', 'bio')), ['bookings@dj-mike.com']);
    assert.deepEqual(values(extractEmails('sam at gmail dot com', 'bio')), ['sam@gmail.com']);
    assert.deepEqual(values(extractEmails('logo@2x.png and user@example.com', 'bio')), []);
    assert.deepEqual(values(extractEmails('meet me at the gym today', 'bio')), []);
    assert.match(extractEmails('jane [at] studio [dot] com', 'bio')[0].evidence, /written out.*jane \[at\] studio/);
});

test('phones: only clearly written numbers count', () => {
    assert.deepEqual(values(extractPhones('WhatsApp +91 98765 43210', 'bio')), ['+919876543210']);
    assert.deepEqual(values(extractPhones('📞 (555) 123-4567', 'bio')), ['(555) 123-4567']);
    assert.deepEqual(values(extractPhones('Call: 020 7946 0958', 'bio')), ['020 7946 0958']);
    assert.deepEqual(values(extractPhones('Est. 2010-2020 • 12345678 fans', 'bio')), []);
    assert.deepEqual(values(extractPhones('Born 12/05/1998', 'bio')), []);
    assert.deepEqual(values(extractPhones('00 44 7911 123456', 'bio')), ['+447911123456']);
    assert.deepEqual(values(phonesFromUrl('https://wa.me/14155550123', 'bio link')), ['+14155550123']);
});

test('link page: mailto, JSON-embedded email, tel and WhatsApp links; platform emails ignored', () => {
    const html = `<a href="mailto:Team@Shop.io?subject=hi">mail</a>
      <script id="__NEXT_DATA__" type="application/json">{"email":"owner@shop.io","url":"https://wa.me/447700900123"}</script>
      <a href="tel:+1 415 555 0199">call</a> support@linktr.ee`;
    const r = extractFromPage(html, 'https://linktr.ee/shop');
    assert.deepEqual(values(r.emails).sort(), ['owner@shop.io', 'team@shop.io']);
    assert.deepEqual(values(r.phones).sort(), ['+14155550199', '+447700900123']);
});

test('keywords: exact / all / any with spelling variants', () => {
    const fields = (bio) => [{ label: 'bio', text: bio }];
    const exact = [compileKeyword('e-commerce', 'exact')];
    assert.ok(matchKeywords(exact, fields('We build Ecommerce stores')).matched);
    assert.ok(matchKeywords(exact, fields('E Commerce growth')).matched);
    assert.ok(matchKeywords([compileKeyword('ecommerce', 'exact')], fields('e-commerce consultant')).matched);
    assert.ok(matchKeywords([compileKeyword('fitness coach', 'exact')], fields('Certified FITNESS COACHES')).matched);
    assert.ok(!matchKeywords([compileKeyword('fitness coach', 'exact')], fields('coach for fitness')).matched);
    assert.ok(matchKeywords([compileKeyword('fitness coach', 'all')], fields('coach for fitness')).matched);
    assert.ok(!matchKeywords([compileKeyword('ai engineer', 'exact')], fields('Electrical engineer')).matched);
    assert.ok(!matchKeywords([compileKeyword('art', 'exact')], fields('smart home')).matched);
    assert.ok(matchKeywords([compileKeyword('cafe', 'exact')], fields('Best Café in town')).matched);
    assert.ok(matchKeywords([compileKeyword('real estate', 'any')], fields('estate agent')).matched);
    assert.match(matchKeywords(exact, fields('We build Ecommerce stores')).evidence, /"e-commerce" in bio/);
});

test('tiers, usernames and lead score', () => {
    assert.equal(influencerTier(999), 'sub-nano');
    assert.equal(influencerTier(5000), 'nano');
    assert.equal(influencerTier(50000), 'micro');
    assert.equal(influencerTier(500000), 'macro');
    assert.equal(influencerTier(5000000), 'mega');
    assert.equal(normalizeUsername('@NatGeo'), 'natgeo');
    assert.equal(normalizeUsername('https://www.instagram.com/hubspot/?hl=en'), 'hubspot');
    assert.equal(normalizeUsername('https://instagram.com/p/ABC123/'), null);
    assert.equal(normalizeUsername('bad name!'), null);
    const row = {
        all_emails: ['a@b.com'], all_phones: [], is_business_account: true, external_url: 'https://x.com', bio_links: [],
        is_verified: false, engagement_rate_pct: 3.2, days_since_last_post: 3, followers: 20000, is_private: false,
    };
    const s = leadScore(row);
    assert.equal(s.lead_score, 30 + 10 + 5 + 15 + 10 + 5);
    assert.equal(s.lead_grade, 'A - Hot Lead');
    assert.equal(leadScore({ ...row, all_emails: [], engagement_rate_pct: null, days_since_last_post: null }).lead_grade, 'D - Cold Lead');
});
