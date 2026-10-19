// Engagement, posting activity, influencer tier and lead score.

const round = (n, d = 2) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const DAY = 86400000;
const days = (d) => `${d} day${d === 1 ? '' : 's'} ago`;

export function influencerTier(followers) {
    if (followers == null) return null;
    if (followers < 1000) return 'sub-nano';
    if (followers < 10000) return 'nano';
    if (followers < 100000) return 'micro';
    if (followers < 1000000) return 'macro';
    return 'mega';
}

/** Turns Instagram timeline edges into clean post objects. */
export function parsePosts(user) {
    const edges = user.edge_owner_to_timeline_media?.edges ?? [];
    return edges.map(({ node: n }) => {
        if (!n) return null;
        const type = n.product_type === 'clips' ? 'reel'
            : n.is_video ? 'video'
                : n.__typename === 'GraphSidecar' ? 'carousel' : 'image';
        let likes = n.edge_liked_by?.count ?? n.edge_media_preview_like?.count ?? null;
        if (typeof likes !== 'number' || likes < 0) likes = null;
        let comments = n.edge_media_to_comment?.count ?? null;
        if (typeof comments !== 'number' || comments < 0) comments = null;
        const views = typeof n.video_view_count === 'number' && n.video_view_count >= 0 ? n.video_view_count : null;
        const caption = n.edge_media_to_caption?.edges?.[0]?.node?.text ?? '';
        return {
            url: n.shortcode ? `https://www.instagram.com/${type === 'reel' ? 'reel' : 'p'}/${n.shortcode}/` : null,
            shortcode: n.shortcode ?? null,
            type,
            taken_at: n.taken_at_timestamp ? new Date(n.taken_at_timestamp * 1000).toISOString() : null,
            likes,
            comments,
            video_views: views,
            caption: caption.length > 500 ? `${caption.slice(0, 500)}…` : caption,
            is_pinned: Array.isArray(n.pinned_for_users) && n.pinned_for_users.length > 0,
            display_url: n.display_url ?? n.thumbnail_src ?? null,
        };
    }).filter(Boolean);
}

/**
 * Engagement rate = (avg likes + avg comments) / followers × 100 over the latest posts.
 * Returns nulls plus a note explaining why when it cannot be measured (never guessed).
 */
export function engagement(user, posts, { limit, excludePinned }) {
    const followers = user.edge_followed_by?.count ?? null;
    const empty = (note) => ({
        engagement_rate_pct: null, avg_likes: null, avg_comments: null, avg_video_views: null, posts_analyzed: 0, engagement_note: note,
    });
    if (user.is_private) return empty('private account — posts not visible');
    if (!followers) return empty('no followers');
    if (!posts.length) return empty('no public posts');
    if (user.hide_like_and_view_counts) return empty('account hides like counts');

    let pool = excludePinned ? posts.filter((p) => !p.is_pinned) : posts;
    if (!pool.length) pool = posts;
    pool = pool.slice(0, limit);
    const withLikes = pool.filter((p) => p.likes != null);
    if (!withLikes.length) return empty('like counts not available');

    const avgLikes = withLikes.reduce((s, p) => s + p.likes, 0) / withLikes.length;
    const avgComments = withLikes.reduce((s, p) => s + (p.comments ?? 0), 0) / withLikes.length;
    const videos = pool.filter((p) => p.video_views != null);
    const pinnedNote = excludePinned && posts.some((p) => p.is_pinned) ? ', pinned posts excluded' : '';
    return {
        engagement_rate_pct: round(((avgLikes + avgComments) / followers) * 100),
        avg_likes: Math.round(avgLikes),
        avg_comments: Math.round(avgComments),
        avg_video_views: videos.length ? Math.round(videos.reduce((s, p) => s + p.video_views, 0) / videos.length) : null,
        posts_analyzed: withLikes.length,
        engagement_note: `based on last ${withLikes.length} posts${pinnedNote}`,
    };
}

export function activity(posts) {
    const dated = posts.filter((p) => p.taken_at && !p.is_pinned).map((p) => Date.parse(p.taken_at)).sort((a, b) => b - a);
    const all = dated.length ? dated : posts.filter((p) => p.taken_at).map((p) => Date.parse(p.taken_at)).sort((a, b) => b - a);
    if (!all.length) return { last_post_at: null, days_since_last_post: null, avg_days_between_posts: null };
    return {
        last_post_at: new Date(all[0]).toISOString(),
        days_since_last_post: Math.max(0, Math.floor((Date.now() - all[0]) / DAY)),
        avg_days_between_posts: all.length >= 2 ? round((all[0] - all[all.length - 1]) / DAY / (all.length - 1), 1) : null,
    };
}

const GRADES = [
    [75, 'A - Hot Lead'],
    [50, 'B - Warm Lead'],
    [25, 'C - Cool Lead'],
    [0, 'D - Cold Lead'],
];

/** 0–100 lead score with the reason for every point (evidence column). */
export function leadScore(row) {
    let score = 0;
    const reasons = [];
    const add = (pts, why) => {
        score += pts;
        reasons.push(`${pts >= 0 ? '+' : ''}${pts} ${why}`);
    };
    if (row.all_emails.length) add(30, 'email found');
    if (row.all_phones.length) add(15, 'phone found');
    if (row.is_business_account || row.is_professional_account) add(10, 'business/creator account');
    if (row.external_url || row.bio_links.length) add(5, 'website or link in bio');
    if (row.is_verified) add(5, 'verified');
    const er = row.engagement_rate_pct;
    if (er == null) reasons.push('+0 engagement unknown');
    else if (er >= 6) add(20, `excellent engagement (${er}%)`);
    else if (er >= 3) add(15, `strong engagement (${er}%)`);
    else if (er >= 1) add(10, `average engagement (${er}%)`);
    else if (er >= 0.5) add(5, `below-average engagement (${er}%)`);
    else reasons.push(`+0 low engagement (${er}%)`);
    const d = row.days_since_last_post;
    if (d == null) reasons.push('+0 posting activity unknown');
    else if (d <= 14) add(10, `active (last post ${days(d)})`);
    else if (d <= 60) add(5, `semi-active (last post ${days(d)})`);
    else reasons.push(`+0 inactive (last post ${days(d)})`);
    if ((row.followers ?? 0) >= 1000) add(5, 'audience of 1K+');
    if (row.is_private) add(-10, 'private account');
    score = Math.max(0, Math.min(100, score));
    const grade = GRADES.find(([min]) => score >= min)[1];
    return { lead_score: score, lead_grade: grade, lead_score_reasons: reasons };
}

export const gradeLetter = (grade) => grade?.[0] ?? 'D';
