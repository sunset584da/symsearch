/**
 * SYM RESEARCH API
 * Bridges Pro360 ↔ SearXNG + Groq synthesis
 * 
 * POST /api/research
 * Body: { query: string, mode?: string, role?: string }
 * Response: { answer: string, sources: [...], confidence: number, relatedQueries: string[] }
 * 
 * Auth: X-Research-Key header required (same key as Symsearch proxy)
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Groq from 'groq-sdk';
import crypto from 'crypto';
import Stripe from 'stripe';
import { pathToFileURL } from 'node:url';

// ─── Phase 2 modules (compiled from TypeScript) ───────────────────────────────
import { classifyIntent as classifyIntentV2 } from './dist/intent-classifier.js';
import { maybeChain } from './dist/query-chainer.js';
import { trackSearch } from './dist/analytics.js';
import { runtimeConfig, getStartupWarnings } from './lib/runtime-config.js';
import { getLaneConfig, getLaneSearchEngines, resolveSearchLane } from './lib/request-lane.js';
import { buildSearchCacheKey, dedupeSearchRequest, getCachedSearchResponse, setCachedSearchResponse } from './lib/search-cache.js';
import { rankAndDiversifyResults } from './lib/source-policy.js';
import { attachSearchHeaders, getTelemetrySnapshot, recordSearchTelemetry } from './lib/telemetry.js';

const app = express();
const PORT = runtimeConfig.port;
const RESEARCH_KEY = runtimeConfig.researchInternalKey;
const SEARXNG_URL = runtimeConfig.searxngUrl;
const SEARXNG_KEY = runtimeConfig.searxngAuthKey;
const SUPABASE_URL = runtimeConfig.supabaseUrl;
const SUPABASE_KEY = runtimeConfig.supabaseAnonKey;
const stripe = runtimeConfig.stripeSecretKey ? new Stripe(runtimeConfig.stripeSecretKey) : null;
const groq = runtimeConfig.groqApiKey ? new Groq({ apiKey: runtimeConfig.groqApiKey }) : null;
const startupWarnings = getStartupWarnings();

app.use(cors({ origin: '*' }));
app.use(express.json());

for (const warning of startupWarnings) {
  console.warn(`[startup] ${warning}`);
}

// ─── Supabase Key Lookup ──────────────────────────────────────────────────────
async function supabaseFetch(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return null;
  }

  const { headers: extraHeaders = {}, ...restOptions } = options;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    ...restOptions,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[supabase] ${options.method || 'GET'} ${path} → ${res.status}: ${text.substring(0, 100)}`);
    return null;
  }
  if (res.status === 204 || res.status === 201) {
    const text = await res.text().catch(() => '');
    if (!text) return { ok: true };
    try { return JSON.parse(text); } catch { return { ok: true }; }
  }
  return res.json();
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

async function lookupApiKey(rawKey) {
  const keyHash = sha256(rawKey);
  // Get key + tier info
  const rows = await supabaseFetch(
    `api_keys?key_hash=eq.${keyHash}&active=eq.true&select=id,tier_id,tiers(name,queries_per_month)`
  );
  if (!rows || rows.length === 0) return null;

  const keyRow = rows[0];
  const tier = keyRow.tiers;

  // Get monthly usage
  const usage = await supabaseFetch(
    `api_usage_monthly?key_id=eq.${keyRow.id}&select=queries_this_month`
  );
  const queriesThisMonth = usage?.[0]?.queries_this_month || 0;
  const allowed = queriesThisMonth < tier.queries_per_month;
  const remaining = Math.max(0, tier.queries_per_month - queriesThisMonth);

  return { keyId: keyRow.id, tier: tier.name, allowed, remaining, queriesThisMonth };
}

async function logApiUsage(keyId, endpoint, queryText) {
  const queryHash = queryText ? sha256(queryText) : null;
  // Fire and forget — don't await
  supabaseFetch('api_usage', {
    method: 'POST',
    body: JSON.stringify({ key_id: keyId, endpoint, query_hash: queryHash }),
  }).catch(() => {});
  // Update last_used_at
  supabaseFetch(`api_keys?id=eq.${keyId}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => {});
}

// ─── Internal Auth Key (Pro360 / team use) ────────────────────────────────────
const INTERNAL_KEY = RESEARCH_KEY;

// ─── Rate Limit Store (in-memory, per key, resets hourly) ─────────────────────
const rateLimitStore = new Map(); // key → { count, windowStart }
const RATE_LIMITS = {
  internal: { perHour: 500, perDay: 5000 },
  free:     { perHour: 10,  perDay: 100 },
  starter:  { perHour: 100, perDay: 1000 },
  pro:      { perHour: 500, perDay: 5000 },
  unlimited:{ perHour: Infinity, perDay: Infinity },
};

function checkRateLimit(key, tier = 'internal') {
  const limits = RATE_LIMITS[tier] || RATE_LIMITS.free;
  const now = Date.now();
  const hourMs = 3600000;

  if (!rateLimitStore.has(key)) {
    rateLimitStore.set(key, { count: 0, windowStart: now });
  }

  const entry = rateLimitStore.get(key);
  if (now - entry.windowStart > hourMs) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count++;

  if (entry.count > limits.perHour) {
    const retryAfter = Math.ceil((entry.windowStart + hourMs - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true, remaining: limits.perHour - entry.count };
}

// ─── Auth + Rate Limit Middleware ─────────────────────────────────────────────
app.use('/api/research', async (req, res, next) => {
  const key = req.headers['x-research-key'] || req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  const requestedLane = req.headers['x-symsearch-lane'] || req.body?.lane;

  if (!key) {
    return res.status(403).json({ error: 'Missing API key. Include X-Research-Key header.' });
  }

  // Internal/team key — full access
  if (INTERNAL_KEY && key === INTERNAL_KEY) {
    req.apiTier = 'internal';
    req.searchLane = resolveSearchLane('internal', requestedLane);
    return next();
  }

  // External key — look up in Supabase
  try {
    const keyInfo = await lookupApiKey(key);
    if (!keyInfo) {
      // Unknown key — fall back to in-memory rate limiting as free tier
      const { allowed, retryAfter, remaining } = checkRateLimit(key, 'free');
      if (!allowed) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfter,
          message: 'Free tier: 10 requests/hour. Get an API key at https://symsearch.pro'
        });
      }
      res.setHeader('X-RateLimit-Remaining', remaining);
      req.apiTier = 'free';
      req.apiKey = key;
      req.searchLane = resolveSearchLane('free', requestedLane);
      return next();
    }

    if (!keyInfo.allowed) {
      return res.status(429).json({
        error: 'Monthly quota exceeded',
        tier: keyInfo.tier,
        used: keyInfo.queriesThisMonth,
        message: `Upgrade your plan at https://symsearch.pro`
      });
    }

    res.setHeader('X-RateLimit-Remaining', keyInfo.remaining);
    req.apiTier = keyInfo.tier;
    req.apiKey = key;
    req.apiKeyId = keyInfo.keyId;
    req.searchLane = resolveSearchLane(keyInfo.tier, requestedLane);

    // Log usage async (non-blocking)
    const query = req.body?.query || null;
    logApiUsage(keyInfo.keyId, req.path, query);

    next();
  } catch (err) {
    // DB lookup failed — degrade gracefully to in-memory limit
    console.error('[auth] Supabase lookup failed:', err.message);
    const { allowed, retryAfter, remaining } = checkRateLimit(key, 'free');
    if (!allowed) {
      return res.status(429).json({ error: 'Rate limit exceeded', retryAfter });
    }
    res.setHeader('X-RateLimit-Remaining', remaining);
    req.apiTier = 'free';
    req.apiKey = key;
    req.searchLane = resolveSearchLane('free', requestedLane);
    next();
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'sym-research-api',
    port: PORT,
    warnings: startupWarnings,
    config: {
      internalKeyConfigured: Boolean(INTERNAL_KEY),
      groqConfigured: Boolean(groq),
      stripeConfigured: Boolean(stripe),
      supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_KEY),
      searxngUrl: SEARXNG_URL,
    },
  });
});

// ─── Key List (by email — no auth needed, email-scoped) ──────────────────────
app.get('/api/keys', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email query param required' });

  try {
    const keys = await supabaseFetch(
      `api_keys?email=eq.${encodeURIComponent(email)}&select=id,label,active,created_at,last_used_at,tier_id,tiers(name,queries_per_hour,queries_per_month)`
    );

    if (!keys) return res.json([]);

    // Get monthly usage for each key
    const keysWithUsage = await Promise.all(keys.map(async (k) => {
      const usage = await supabaseFetch(`api_usage_monthly?key_id=eq.${k.id}&select=queries_this_month`);
      return {
        id: k.id,
        label: k.label,
        active: k.active,
        created_at: k.created_at,
        last_used_at: k.last_used_at,
        tier: k.tiers?.name || 'free',
        queries_per_month: k.tiers?.queries_per_month || 1000,
        queries_this_month: usage?.[0]?.queries_this_month || 0,
      };
    }));

    res.json(keysWithUsage);
  } catch (err) {
    console.error('[keys/list] error:', err.message);
    res.status(500).json({ error: 'Failed to list keys' });
  }
});

// ─── Key Revoke ───────────────────────────────────────────────────────────────
app.delete('/api/keys/:id', async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  try {
    const result = await supabaseFetch(`api_keys?id=eq.${id}&email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ active: false }),
    });
    res.json({ revoked: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke key' });
  }
});

// ─── Feedback Loop ────────────────────────────────────────────────────────────
app.post('/api/research/feedback', async (req, res) => {
  const { query_hash, result_url, signal, role, mode } = req.body;

  if (!query_hash || !result_url || !['up', 'down'].includes(signal)) {
    return res.status(400).json({ error: 'query_hash, result_url, and signal (up|down) required' });
  }

  try {
    await supabaseFetch('research_feedback', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ query_hash, result_url, signal, role, mode }),
    });
    res.json({ ok: true });
    console.log(`[feedback] ${signal} for ${result_url.substring(0, 60)} (query: ${query_hash.substring(0, 8)}...)`);
  } catch (err) {
    console.error('[feedback] error:', err.message);
    res.status(500).json({ error: 'Failed to log feedback' });
  }
});

async function getFeedbackBoosts(queryHash) {
  try {
    const rows = await supabaseFetch(
      `research_feedback?query_hash=eq.${queryHash}&select=result_url,signal`
    );
    if (!rows || rows.length === 0) return {};
    const boosts = {};
    for (const row of rows) {
      boosts[row.result_url] = (boosts[row.result_url] || 0) + (row.signal === 'up' ? 1 : -1);
    }
    return boosts;
  } catch {
    return {};
  }
}

// ─── Stripe Checkout Session ──────────────────────────────────────────────────
app.post('/api/stripe/checkout', async (req, res) => {
  const { price_id, email, key_id, success_url, cancel_url } = req.body;

  if (!stripe) {
    return res.status(503).json({
      error: 'Stripe not configured',
      message: 'Set STRIPE_SECRET_KEY env var on the VPS to enable billing',
    });
  }

  if (!price_id || !email) {
    return res.status(400).json({ error: 'price_id and email required' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: price_id, quantity: 1 }],
      success_url: success_url || 'https://pro360.app/developer?tab=symsearch&upgraded=true',
      cancel_url: cancel_url || 'https://pro360.app/developer?tab=symsearch&cancelled=true',
      metadata: { email, key_id: key_id || '' },
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('[stripe] checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session', details: err.message });
  }
});

// ─── Stripe Webhook (upgrades key tier on payment success) ────────────────────
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
      : JSON.parse(req.body);
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { email, key_id } = session.metadata;

    // Determine tier from subscription line item
    const subscription = await stripe.subscriptions.retrieve(session.subscription);
    const priceId = subscription.items.data[0]?.price.id;

    // Map price ID to tier name
    const tierMap = {
      [process.env.PRICE_STARTER]: 'starter',
      [process.env.PRICE_PRO]: 'pro',
      [process.env.PRICE_ENTERPRISE]: 'enterprise',
    };
    const tierName = tierMap[priceId] || 'starter';

    // Get tier_id from Supabase
    const tiers = await supabaseFetch(`tiers?name=eq.${tierName}&select=id`);
    if (tiers && tiers.length > 0 && key_id) {
      await supabaseFetch(`api_keys?id=eq.${key_id}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ tier_id: tiers[0].id }),
      });
      console.log(`[stripe] upgraded key ${key_id} to ${tierName}`);
    }
  }

  res.json({ received: true });
});

// ─── Key Generation (no auth required for free tier) ─────────────────────────
app.post('/api/keys/generate', async (req, res) => {
  const { email, label, tier_name = 'free' } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  try {
    // Check for existing key by email
    const existing = await supabaseFetch(`api_keys?email=eq.${encodeURIComponent(email)}&select=id`);
    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'An API key already exists for this email. Contact support to manage your keys.' });
    }

    // Get tier_id
    const tiers = await supabaseFetch(`tiers?name=eq.${tier_name}&select=id,name,queries_per_hour,queries_per_month,price_cents`);
    if (!tiers || tiers.length === 0) {
      return res.status(400).json({ error: `Unknown tier: ${tier_name}` });
    }
    const tier = tiers[0];

    // Generate key
    const rawKey = `SYM_${crypto.randomBytes(24).toString('base64url')}`;
    const keyHash = sha256(rawKey);

    // Insert into Supabase
    const insertRes = await supabaseFetch('api_keys', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        key_hash: keyHash,
        email,
        label: label || `${email} (${tier_name})`,
        tier_id: tier.id,
        active: true,
      }),
    });

    if (!insertRes || insertRes.length === 0) {
      return res.status(500).json({ error: 'Failed to create API key' });
    }

    // Return raw key ONCE — never stored
    res.json({
      key: rawKey,
      tier: { name: tier.name, queries_per_hour: tier.queries_per_hour, queries_per_month: tier.queries_per_month },
      label: insertRes[0].label,
      created_at: insertRes[0].created_at,
      note: 'Save this key — it will not be shown again.',
    });

    console.log(`[keys] generated ${tier_name} key for ${email}`);

  } catch (err) {
    console.error('[keys] error:', err.message);
    res.status(500).json({ error: 'Key generation failed', details: err.message });
  }
});

// ─── SearXNG Query ────────────────────────────────────────────────────────────
async function searchSearXNG(query, options = {}) {
  const params = new URLSearchParams({ q: query, format: 'json' });
  if (options.engines) {
    params.set('engines', options.engines);
  }

  const headers = {};
  if (SEARXNG_KEY) {
    headers['X-Search-Key'] = SEARXNG_KEY;
  }

  const res = await fetch(`${SEARXNG_URL}/search?${params.toString()}`, {
    headers,
    signal: AbortSignal.timeout(options.timeoutMs || 8000),
  });

  if (!res.ok) {
    throw new Error(`SearXNG returned ${res.status}`);
  }

  const data = await res.json();
  return {
    ...data,
    results: Array.isArray(data.results) ? data.results : [],
  };
}

// ─── Role-Based Context ───────────────────────────────────────────────────────
function getRoleContext(role, mode) {
  const contexts = {
    owner: 'You are helping an HVAC business owner. Focus on competitor pricing, market intel, business strategy, profit margins, and operational insights.',
    dispatcher: 'You are helping an HVAC dispatcher. Focus on scheduling, job pricing, customer communication, equipment availability, and field team coordination.',
    tech: 'You are helping an HVAC technician. Focus on troubleshooting, equipment manuals, refrigerant handling, diagnostic procedures, and technical specifications.',
  };
  return contexts[role] || contexts['owner'];
}

// ─── Groq Synthesis ───────────────────────────────────────────────────────────
function buildFallbackAnswer(results) {
  return results
    .slice(0, 5)
    .map((r, index) => `[${index + 1}] ${r.title}\n${r.content || r.snippet || ''}`)
    .join('\n\n') || 'No synthesis available.';
}

function formatSources(results, maxSources, boosts, intent) {
  return results.slice(0, maxSources).map((r, i) => ({
    title: r.title || 'Untitled',
    url: r.url,
    snippet: r.content || r.snippet || '',
    relevance: Math.max(0.1, 1 - (i * 0.12)),
    feedback: boosts?.[r.url] || 0,
    intent,
  }));
}

async function synthesizeWithGroq(query, results, role, mode, laneConfig) {
  if (!groq) {
    return buildFallbackAnswer(results);
  }

  const roleContext = getRoleContext(role, mode);
  
  const topResults = results.slice(0, 8).map((r, i) => 
    `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content || r.snippet || ''}`
  ).join('\n\n');

  const prompt = `${roleContext}

The user asked: "${query}"

Here are the top search results:

${topResults}

Provide a clear, actionable answer based on these results. Format your response as:
- A direct answer to the question (2-4 paragraphs)
- Be specific with numbers, dates, and actionable details where available
- Cite sources as [1], [2], etc.
- Stay focused on what's most relevant for the user's role

Keep it practical and HVAC-business focused.`;

  const completion = await groq.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: 'llama-3.3-70b-versatile',
    temperature: 0.3,
    max_tokens: laneConfig.synthesisMaxTokens,
  });

  return completion.choices[0]?.message?.content || 'No synthesis available.';
}

// ─── Related Queries ──────────────────────────────────────────────────────────
async function generateRelatedQueries(query, role) {
  if (!groq) {
    return [];
  }

  const roleContext = getRoleContext(role);
  
  const completion = await groq.chat.completions.create({
    messages: [{
      role: 'user',
      content: `${roleContext}\n\nGenerate 3 related follow-up search queries for an HVAC professional who searched: "${query}"\n\nReturn ONLY a JSON array of 3 strings, nothing else. Example: ["query 1", "query 2", "query 3"]`
    }],
    model: 'llama-3.1-8b-instant',
    temperature: 0.5,
    max_tokens: 200,
  });

  try {
    const text = completion.choices[0]?.message?.content || '[]';
    const match = text.match(/\[.*\]/s);
    return match ? JSON.parse(match[0]) : [];
  } catch {
    return [];
  }
}

// ─── Intent Classifier ────────────────────────────────────────────────────────
// Legacy mode classifier (keeps backward-compat for role-context and stream endpoints)
function classifyIntent(query) {
  const q = query.toLowerCase();
  if (/not cool|not heat|blower|error code|fault|refrigerant|capacitor|contactor|diagnostic|troubleshoot|tonnage|cfm|seer/.test(q)) return 'technical';
  if (/competitor|pricing|how much|market|revenue|charge|rate|invoice|profit|margin|bid|quote/.test(q)) return 'business';
  if (/permit|code|regulation|epa|certification|license|legal|compliance|nate|ahri/.test(q)) return 'compliance';
  return 'general';
}

// Phase 2 typed intent — wraps classifyIntentV2, used to tag search results
function getTypedIntent(query) {
  return classifyIntentV2(query); // { intent: IntentType, confidence: number }
}

// ─── Analytics (in-memory) ────────────────────────────────────────────────────
const analytics = {
  requests: [],
  log(query, mode, role, confidence, processingMs) {
    this.requests.push({ query, mode, role, confidence, processingMs, ts: Date.now() });
    if (this.requests.length > 1000) this.requests.shift(); // cap at 1k
  },
  summary() {
    const total = this.requests.length;
    const avgConf = total ? (this.requests.reduce((s, r) => s + r.confidence, 0) / total).toFixed(2) : 0;
    const avgMs = total ? Math.round(this.requests.reduce((s, r) => s + r.processingMs, 0) / total) : 0;
    const byMode = this.requests.reduce((acc, r) => { acc[r.mode] = (acc[r.mode] || 0) + 1; return acc; }, {});
    return { total, avgConf, avgMs, byMode };
  }
};

app.get('/api/analytics', (req, res) => {
  const key = req.headers['x-research-key'];
  if (!key || key !== RESEARCH_KEY) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    analytics: analytics.summary(),
    telemetry: getTelemetrySnapshot(),
  });
});

app.get('/api/telemetry', (req, res) => {
  const key = req.headers['x-research-key'];
  if (!key || key !== RESEARCH_KEY) return res.status(403).json({ error: 'Forbidden' });
  res.json(getTelemetrySnapshot());
});

// ─── Main Research Endpoint ───────────────────────────────────────────────────
app.post('/api/research', async (req, res) => {
  const startTime = Date.now();
  let { query, mode, role = 'owner' } = req.body;
  if (!mode) mode = classifyIntent(query);

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'query is required' });
  }

  // Phase 2: typed intent classification
  const intentResult = getTypedIntent(query);
  const lane = req.searchLane || 'customer';
  const laneConfig = getLaneConfig(lane);
  const cacheKey = buildSearchCacheKey({
    lane,
    query,
    role,
    mode,
    intent: intentResult.intent,
  });

  console.log(`[research] lane=${lane} query="${query}" role=${role} mode=${mode} intent=${intentResult.intent}(${intentResult.confidence})`);

  try {
    const cached = getCachedSearchResponse(cacheKey);
    if (cached) {
      const latencyMs = Date.now() - startTime;
      attachSearchHeaders(res, {
        lane,
        intent: intentResult.intent,
        cacheHit: true,
        deduped: false,
        chained: Boolean(cached.chained),
      });
      recordSearchTelemetry({
        lane,
        intent: intentResult.intent,
        cacheHit: true,
        deduped: false,
        chained: Boolean(cached.chained),
        latencyMs,
        resultCount: cached.sources?.length || 0,
      });
      return res.json(cached);
    }

    const { value: payload, deduped } = await dedupeSearchRequest(cacheKey, async () => {
      // 1. Fetch from SearXNG
      const searchData = await searchSearXNG(query.trim(), {
        engines: getLaneSearchEngines(lane, intentResult.intent),
      });
      const rawResults = rankAndDiversifyResults(searchData.results || [], {
        intent: intentResult.intent,
        query,
        limit: laneConfig.resultLimit,
      });

      if (rawResults.length === 0) {
        return {
          answer: 'No results found for that query. Try rephrasing or use more specific terms.',
          sources: [],
          confidence: 0,
          relatedQueries: [],
          intent: intentResult.intent,
          lane,
          chained: false,
        };
      }

      // 2. Query chaining with ranked follow-up searches
      const runSearch = async (q) => {
        const data = await searchSearXNG(q, {
          engines: getLaneSearchEngines(lane, intentResult.intent),
        });
        return rankAndDiversifyResults(data.results || [], {
          intent: intentResult.intent,
          query: q,
          limit: laneConfig.resultLimit,
        });
      };
      const preChainLen = rawResults.length;
      const chainedResults = await maybeChain(query.trim(), rawResults, runSearch);
      const finalResults = rankAndDiversifyResults(chainedResults, {
        intent: intentResult.intent,
        query,
        limit: laneConfig.resultLimit,
      });
      const chained = finalResults.length > preChainLen;

      // 3. Synthesize in parallel with related queries
      const [answer, relatedQueries] = await Promise.all([
        synthesizeWithGroq(query, finalResults, role, mode, laneConfig),
        laneConfig.enableRelatedQueries ? generateRelatedQueries(query, role) : Promise.resolve([]),
      ]);

      // 4. Apply feedback boosts + format sources
      const queryHash = sha256(query.trim());
      const boosts = await getFeedbackBoosts(queryHash);
      const boostedResults = [...finalResults].sort((a, b) => (boosts[b.url] || 0) - (boosts[a.url] || 0));
      const sources = formatSources(boostedResults, laneConfig.maxSources, boosts, intentResult.intent);

      // 5. Confidence based on result count and quality
      const confidence = Math.min(0.95, 0.4 + (finalResults.length / 20) * 0.55);
      const response = { answer, sources, confidence, relatedQueries, chained, intent: intentResult.intent, lane };
      setCachedSearchResponse(cacheKey, response, laneConfig.cacheTtlMs);
      return response;
    });

    const latencyMs = Date.now() - startTime;
    attachSearchHeaders(res, {
      lane,
      intent: intentResult.intent,
      cacheHit: false,
      deduped,
      chained: Boolean(payload.chained),
    });
    res.json(payload);

    trackSearch({
      query: query.trim(),
      intent: intentResult.intent,
      result_count: payload.sources.length,
      latency_ms: latencyMs,
      cache_hit: false,
    }).catch(() => {});

    analytics.log(query, mode, role, payload.confidence, latencyMs);
    recordSearchTelemetry({
      lane,
      intent: intentResult.intent,
      cacheHit: false,
      deduped,
      chained: Boolean(payload.chained),
      latencyMs,
      resultCount: payload.sources.length,
    });

  } catch (err) {
    console.error('[research] error:', err.message);
    recordSearchTelemetry({
      lane,
      intent: intentResult.intent,
      cacheHit: false,
      deduped: false,
      chained: false,
      latencyMs: Date.now() - startTime,
      resultCount: 0,
      status: 'error',
    });
    res.status(500).json({
      error: 'Research engine error',
      details: err.message,
    });
  }
});

// ─── Streaming Research Endpoint (SSE) ───────────────────────────────────────
app.post('/api/research/stream', async (req, res) => {
  const startTime = Date.now();
  let { query, role = 'owner' } = req.body;
  let mode = req.body.mode || classifyIntent(query);
  const intentResult = getTypedIntent(query);
  const lane = req.searchLane || 'customer';
  const laneConfig = getLaneConfig(lane);

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'query is required' });
  }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  console.log(`[stream] lane=${lane} query="${query}" role=${role} mode=${mode}`);

  try {
    // 1. Signal: searching
    send('status', { stage: 'searching', message: 'Searching across engines...' });

    const searchData = await searchSearXNG(query.trim(), {
      engines: getLaneSearchEngines(lane, intentResult.intent),
    });
    const rawResults = rankAndDiversifyResults(searchData.results || [], {
      intent: intentResult.intent,
      query,
      limit: laneConfig.resultLimit,
    });

    if (rawResults.length === 0) {
      send('error', { message: 'No results found. Try rephrasing.' });
      return res.end();
    }

    // 2. Query chaining — auto-refine weak results
    let finalResults = rawResults;
    const initialConf = Math.min(0.95, 0.4 + (rawResults.length / 20) * 0.55);
    if (initialConf < 0.6 && rawResults.length < 5) {
      send('status', { stage: 'refining', message: 'Refining search for better results...' });
      const refinedQuery = `${query.trim()} HVAC ${mode === 'technical' ? 'troubleshooting' : mode === 'business' ? 'pricing' : mode === 'compliance' ? 'regulations' : 'explained'}`;
      try {
        const refined = await searchSearXNG(refinedQuery, {
          engines: getLaneSearchEngines(lane, intentResult.intent),
        });
        if (refined.results?.length) {
          const seen = new Set(rawResults.map(r => r.url));
          const extra = refined.results.filter(r => !seen.has(r.url));
          finalResults = rankAndDiversifyResults([...rawResults, ...extra], {
            intent: intentResult.intent,
            query,
            limit: laneConfig.resultLimit,
          });
        }
      } catch { /* use original */ }
    }

    // 3. Signal: synthesizing
    send('status', { stage: 'synthesizing', message: 'Synthesizing results...' });

    // Format sources early — send them while streaming the answer
    const sources = formatSources(finalResults, laneConfig.maxSources, null, intentResult.intent);
    send('sources', { sources });

    // Stream the Groq answer token by token
    if (!groq) {
      send('token', { token: buildFallbackAnswer(finalResults) });
      send('done', { confidence: Math.min(0.95, 0.4 + (finalResults.length / 20) * 0.55), relatedQueries: [] });
      analytics.log(query, mode, role, Math.min(0.95, 0.4 + (finalResults.length / 20) * 0.55), Date.now() - startTime);
      return res.end();
    }

    const roleContext = getRoleContext(role, mode);
    const topResults = finalResults.slice(0, 8).map((r, i) =>
      `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content || r.snippet || ''}`
    ).join('\n\n');

    const prompt = `${roleContext}

The user asked: "${query}"

Here are the top search results:

${topResults}

Provide a clear, actionable answer based on these results. Be specific with numbers, dates, and actionable details. Cite sources as [1], [2], etc. Keep it practical and HVAC-business focused.`;

    const stream = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: laneConfig.synthesisMaxTokens,
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content || '';
      if (token) {
        send('token', { token });
      }
    }

    // 4. Send related queries (fire-and-forget parallel)
    const relatedQueries = laneConfig.enableRelatedQueries ? await generateRelatedQueries(query, role) : [];
    const confidence = Math.min(0.95, 0.4 + (finalResults.length / 20) * 0.55);

    send('done', { confidence, relatedQueries });

    analytics.log(query, mode, role, confidence, Date.now() - startTime);
    res.end();

  } catch (err) {
    console.error('[stream] error:', err.message);
    send('error', { message: err.message });
    res.end();
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Sym Research API running on port ${PORT}`);
    console.log(`   POST /api/research — SearXNG + Groq synthesis`);
    console.log(`   GET  /health       — health check`);
  });
}

export { app };
