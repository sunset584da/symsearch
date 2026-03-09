const TRUSTED_DOMAIN_SCORES = {
  troubleshooting: [
    ['carrier.com', 30],
    ['trane.com', 30],
    ['lennox.com', 30],
    ['daikincomfort.com', 28],
    ['manualslib.com', 24],
    ['hvac-talk.com', 18],
    ['reddit.com', 10],
    ['youtube.com', 8],
  ],
  competitor_intel: [
    ['servicetitan.com', 28],
    ['housecallpro.com', 26],
    ['getjobber.com', 24],
    ['fieldroutes.com', 22],
    ['capterra.com', 18],
    ['g2.com', 18],
  ],
  pricing: [
    ['angi.com', 18],
    ['homeadvisor.com', 16],
    ['forbes.com', 14],
    ['thisoldhouse.com', 14],
    ['carrier.com', 12],
    ['lennox.com', 12],
  ],
  code_docs: [
    ['docs.', 28],
    ['github.com', 24],
    ['developer.', 24],
    ['ashrae.org', 22],
    ['epa.gov', 22],
    ['energy.gov', 20],
    ['supabase.com', 24],
  ],
  compliance: [
    ['.gov', 28],
    ['houstontx.gov', 30],
    ['tdlr.texas.gov', 30],
    ['osha.gov', 26],
    ['epa.gov', 26],
    ['ashrae.org', 18],
  ],
};

function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    const normalizedPath = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.protocol}//${url.hostname}${normalizedPath}`;
  } catch {
    return rawUrl || '';
  }
}

function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function queryTerms(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function domainBoost(intent, hostname) {
  const weights = TRUSTED_DOMAIN_SCORES[intent] || [];
  for (const [pattern, score] of weights) {
    if (hostname.includes(pattern)) return score;
  }
  return 0;
}

function matchBoost(query, title, snippet) {
  const haystack = `${title || ''} ${snippet || ''}`.toLowerCase();
  return queryTerms(query).reduce((total, term) => total + (haystack.includes(term) ? 4 : 0), 0);
}

function snippetBoost(snippet) {
  const words = String(snippet || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.min(18, Math.floor(words / 6));
}

function baseScore(result) {
  return typeof result.score === 'number' ? result.score * 35 : 20;
}

function scoreResult(result, { intent, query }) {
  const hostname = hostnameOf(result.url);
  return (
    baseScore(result) +
    domainBoost(intent, hostname) +
    matchBoost(query, result.title, result.content || result.snippet) +
    snippetBoost(result.content || result.snippet)
  );
}

export function rankAndDiversifyResults(results, options) {
  const seenUrls = new Set();
  const perDomain = new Map();
  const ranked = [];

  for (const result of results || []) {
    const normalizedUrl = normalizeUrl(result.url);
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) continue;
    seenUrls.add(normalizedUrl);

    const hostname = hostnameOf(normalizedUrl);
    ranked.push({
      ...result,
      url: normalizedUrl,
      score: scoreResult(result, options),
      hostname,
    });
  }

  ranked.sort((a, b) => (b.score || 0) - (a.score || 0));

  const diversified = [];
  const maxPerDomain = options.maxPerDomain || 2;
  for (const result of ranked) {
    const count = perDomain.get(result.hostname) || 0;
    if (count >= maxPerDomain) continue;
    perDomain.set(result.hostname, count + 1);
    diversified.push(result);
    if (diversified.length >= (options.limit || 10)) break;
  }

  return diversified;
}
