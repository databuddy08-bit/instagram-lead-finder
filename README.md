# 📸 Instagram Lead Finder — Email, Phone & Influencer Scraper

Turn a list of Instagram usernames into an outreach-ready lead list. For every profile you get the full public profile, **every public email and phone number** (bio, business contact buttons and link-in-bio pages), **engagement rate**, **influencer tier**, a **0–100 lead score with A–D grade**, posting activity, recent posts and similar accounts for discovery.

No login. No cookies. Export to CSV, Excel, JSON or connect through the API.

**Keywords:** instagram scraper · instagram email scraper · instagram phone number scraper · instagram profile scraper · instagram lead generation · influencer finder · engagement rate calculator · link in bio email extractor · linktree email scraper · B2B leads · influencer marketing

---

## ✨ Why this one

| | This actor | Typical Instagram scrapers |
|---|---|---|
| Emails from bio + business button | ✅ | ✅ |
| Emails & phones from **Linktree / Beacons / Stan / websites** | ✅ (optional) | ❌ |
| Obfuscated emails (`name [at] brand [dot] com`) and fancy-font bios | ✅ | ❌ |
| **Evidence column** — the exact phrase every contact came from | ✅ | ❌ |
| Engagement rate that ignores pinned posts | ✅ | ❌ |
| Posting activity (last post, days between posts) | ✅ | ❌ |
| Lead score **with the reason for every point** | ✅ | ❌ |
| Bio keyword filter (exact phrase / all words / any word) | ✅ | ❌ |
| Skip profiles you already paid for in earlier runs | ✅ | ❌ |
| Only charged for profiles you keep — filtered profiles are free | ✅ | ❌ |

## 🎯 Use cases

- **Influencer marketing** — find creators by tier and real engagement, get their contact.
- **B2B & agency lead generation** — collect business emails and phones of brands, shops, coaches, agents.
- **Discovery** — start from a few accounts and pull Instagram's "similar accounts" automatically.
- **Scheduled prospecting** — run daily and only pay for new leads.

## 🔧 Input

```json
{
  "usernames": ["natgeo", "@garyvee", "https://www.instagram.com/hubspot/"],
  "scanBioLinks": true,
  "scrapeRelatedProfiles": true,
  "onlyWithContact": true,
  "influencerTiers": ["micro", "macro"],
  "bioKeywords": ["fitness coach", "ecommerce"],
  "keywordMatchMode": "exact",
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

| Option | What it does |
|---|---|
| `usernames` | Handles, @handles or profile URLs. Duplicates removed. |
| `maxResults` | Stop after N saved profiles (0 = no limit). |
| `scrapeRelatedProfiles` / `maxRelatedPerProfile` | Also scrape the "similar accounts" Instagram shows (one level deep). |
| `scanBioLinks` | Open the external URL / bio links and collect public emails and phones there. |
| `includeRecentPosts`, `recentPostsLimit`, `excludePinnedPosts` | Recent posts in the output and how engagement is calculated. |
| `minFollowers`, `maxFollowers`, `influencerTiers` | Audience size filters. |
| `onlyWithContact`, `onlyBusinessAccounts`, `minLeadGrade` | Lead quality filters. |
| `minEngagementRate`, `includeUnclearEngagement` | Engagement filter, and what to do when engagement can't be measured. |
| `includePrivateAccounts` | Keep or skip private accounts. |
| `bioKeywords`, `keywordMatchMode` | Match name/bio/category: exact phrase, all words, any word or off. Capitals, accents, hyphens and plurals are treated as equal (e-commerce = ecommerce, coach = coaches). |
| `skipPreviouslyScraped`, `dedupeStoreName` | Remember saved usernames across runs and skip them next time. |
| `proxyConfiguration` | **Use Apify Residential.** Instagram blocks datacenter IPs. |

## 📤 Output (55 fields per profile)

**Profile:** username, full name, profile URL, user ID, biography, followers, following, posts, verified, business account, professional account, private, category, business category, business address, external URL, bio links, profile picture (HD), IGTV count, highlight reels, reels, pronouns.

**Contacts:** business email, business phone, emails found in bio, phones found in bio, emails from bio links, phones from bio links, all emails, all phones, primary email, primary phone, has contact, **contact evidence**.

**Influencer metrics:** engagement rate %, average likes, average comments, average video views, posts analysed, engagement note, last post date, days since last post, average days between posts, influencer tier.

**Lead scoring:** lead score (0–100), lead grade (A–D), lead score reasons, keyword match evidence.

**Discovery:** related profiles, related profile count, recent posts (URL, type, date, likes, comments, views, caption, pinned).

```json
{
  "username": "acme.fitness",
  "full_name": "Acme Fitness",
  "followers": 106192,
  "influencer_tier": "macro",
  "engagement_rate_pct": 2.87,
  "lead_score": 75,
  "lead_grade": "A - Hot Lead",
  "primary_email": "team@acmefitness.com",
  "primary_phone": "+14155550123",
  "contact_evidence": [
    "team@acmefitness.com ← link page linktr.ee/acme.fitness: mailto link",
    "+14155550123 ← bio: \"📞 +1 415 555 0123\""
  ],
  "lead_score_reasons": ["+30 email found", "+15 phone found", "+10 average engagement (2.87%)", "+10 active (last post 1 day ago)"]
}
```

**Every input gets a row.** Profiles that can't be scraped appear with `status` = `blocked`, `not_found` or `invalid_input`, the exact `error` and a `fix_hint` telling you what to change. These rows are never charged (turn them off with `includeFailedProfiles: false`). Successful rows have `status` = `ok`.

The dataset has three views: **Overview** (all fields), **Contacts only** and **Influencer metrics**.

### Lead score

| Points | Signal |
|---|---|
| +30 | Email found |
| +15 | Phone found |
| +10 | Business or creator account |
| +5 | Website or link in bio |
| +5 | Verified |
| +5 to +20 | Engagement (0.5% / 1% / 3% / 6%+) |
| +5 / +10 | Posted in the last 60 / 14 days |
| +5 | 1K+ followers |
| −10 | Private account |

**A - Hot Lead** 75–100 · **B - Warm Lead** 50–74 · **C - Cool Lead** 25–49 · **D - Cold Lead** 0–24

### Influencer tiers

sub-nano < 1K · nano 1K–10K · micro 10K–100K · macro 100K–1M · mega 1M+

## 📊 Run summary

Every run writes a `RUN_SUMMARY` record (Storage → Key-value store): profiles saved, saved with contact, charged events, results per input profile, request and block counts, field fill rates and **every skip reason with examples** — so you always know why a profile is missing.

## 💰 Pricing

Pay per result. You are charged only for profiles that are saved to your dataset:

| Event | When |
|---|---|
| `profile-lead` | Profile saved, no public email or phone found |
| `profile-lead-with-contact` | Profile saved with at least one email or phone |

Profiles that are not found, blocked, duplicated, already seen in a previous run, or removed by your filters are **never charged**. Set "Max cost per run" and the actor stops cleanly at your budget.

## ❓ FAQ

**Why are some emails missing?** Many accounts don't publish one. Turn on `scanBioLinks` — link-in-bio pages often list an email that isn't in the bio.

**Why is engagement empty for some profiles?** Private accounts, accounts with no posts and accounts that hide like counts can't be measured. The field stays empty (never estimated) and `engagement_note` says why.

**Why are related profiles empty?** Instagram doesn't show similar accounts for every profile to logged-out visitors. The summary counts how often this happened.

**My run finished with no profiles.** Open the Output tab: each profile has a `status` and `fix_hint`. `blocked` almost always means the run wasn't on the RESIDENTIAL proxy group, or Instagram was rate-limiting at that moment — run again.

**I'm getting blocked.** Use the Apify **RESIDENTIAL** proxy group. Blocked requests are retried on a new IP automatically.

## ⚖️ Notes

This actor reads public Instagram profile data only. Contact details are those the account owner chose to publish. You are responsible for using the data in line with Instagram's terms and privacy laws in your market (GDPR, CAN-SPAM, etc.), including how you contact people.
