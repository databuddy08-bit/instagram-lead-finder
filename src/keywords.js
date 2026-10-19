// Keyword verification against name / bio / category.
// Treated as equal: capitals, accents, fancy unicode fonts, hyphens/dots/underscores,
// joined vs split words (e-commerce = ecommerce = e commerce) and simple plurals (coach = coaches).

export function normalizeText(s) {
    return String(s ?? '')
        .normalize('NFKC')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ');
}

const tokensOf = (s) => normalizeText(s).split(/[^a-z0-9]+/).filter(Boolean);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function stem(tok) {
    if (tok.length > 4 && tok.endsWith('es')) return tok.slice(0, -2);
    if (tok.length > 3 && tok.endsWith('s') && !tok.endsWith('ss')) return tok.slice(0, -1);
    return tok;
}

const wordPattern = (tok) => `${escapeRe(stem(tok))}(?:es|s)?`;
const bounded = (p) => new RegExp(`(?<![a-z0-9])${p}(?![a-z0-9])`);
const SEP = String.raw`[\s\-_./·|]*`;

/** Compiles one keyword for a match mode. Returns null if the keyword has no usable words. */
export function compileKeyword(keyword, mode) {
    const toks = tokensOf(keyword);
    if (!toks.length) return null;
    if (mode === 'exact') {
        const patterns = [bounded(toks.map(wordPattern).join(SEP))];
        if (toks.length > 1) patterns.push(bounded(wordPattern(toks.join(''))));
        return { keyword, test: (text) => patterns.some((re) => re.test(text)), patterns };
    }
    const res = toks.map((t) => bounded(wordPattern(t)));
    const test = mode === 'all' ? (text) => res.every((re) => re.test(text)) : (text) => res.some((re) => re.test(text));
    return { keyword, test, patterns: res };
}

function variants(text) {
    const n = normalizeText(text);
    return [n, n.replace(/[\-_.·]/g, '')];
}

/**
 * @param {Array<{label:string, text:string}>} fields
 * @returns {{matched:boolean, evidence:string|null}}
 */
export function matchKeywords(compiled, fields) {
    for (const kw of compiled) {
        for (const { label, text } of fields) {
            if (!text) continue;
            for (const v of variants(text)) {
                if (!kw.test(v)) continue;
                let snippet = v;
                for (const re of kw.patterns) {
                    const m = v.match(re);
                    if (m) {
                        const start = Math.max(0, m.index - 25);
                        snippet = `${start > 0 ? '…' : ''}${v.slice(start, m.index + m[0].length + 25)}${m.index + m[0].length + 25 < v.length ? '…' : ''}`;
                        break;
                    }
                }
                return { matched: true, evidence: `"${kw.keyword}" in ${label}: "${snippet.replace(/\s+/g, ' ').trim()}"` };
            }
        }
    }
    return { matched: false, evidence: null };
}
