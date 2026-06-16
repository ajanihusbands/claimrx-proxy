const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── Result Cache ──────────────────────────────────────────────────────────────
// In-memory cache that persists across warm Vercel invocations.
// Resets on cold starts, but during active usage provides significant savings.
const cache = new Map();
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHE_SIZE = 500;

function normalizeQuery(text) {
  return text.toLowerCase().trim().replace(/\s+/g, ' ').replace(/['".,!?]+/g, '');
}

function getCacheKey(body) {
  // Only cache fact-check calls (ones with web_search tool)
  if (!body.tools?.some(t => t.name === 'web_search' || t.type?.includes('web_search'))) {
    return null; // Don't cache pre-checks or image extraction
  }

  // Extract the user's query from the messages
  const userMsg = body.messages?.find(m => m.role === 'user');
  if (!userMsg) return null;

  const content = typeof userMsg.content === 'string'
    ? userMsg.content
    : userMsg.content?.filter(c => c.type === 'text').map(c => c.text).join(' ');

  if (!content || content.length < 10) return null;

  const normalized = normalizeQuery(content);
  return crypto.createHash('md5').update(normalized).digest('hex');
}

function cleanCache() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL_MS) cache.delete(key);
  }
  // If still too large, remove oldest entries
  if (cache.size > MAX_CACHE_SIZE) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = sorted.slice(0, cache.size - MAX_CACHE_SIZE);
    toRemove.forEach(([key]) => cache.delete(key));
  }
}

// ─── Rate Limiter ──────────────────────────────────────────────────────────────
const rateLimitMap = new Map();
const WINDOW_MS    = 60 * 1000;
const MAX_REQUESTS = 10;

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count   = 0;
    entry.resetAt = now + WINDOW_MS;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);

  if (rateLimitMap.size > 10000) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }

  return entry.count > MAX_REQUESTS;
}

// ─── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // Auth check
  const authHeader = req.headers['x-app-secret'];
  if (authHeader !== process.env.APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Rate limit check
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
  }

  try {
    // Check cache for fact-check calls
    const cacheKey = getCacheKey(req.body);

    if (cacheKey && cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
        // Cache hit — return cached response without calling Anthropic
        return res.status(200).json(cached.response);
      } else {
        cache.delete(cacheKey);
      }
    }

    // Cache miss — call Anthropic
    const response = await client.messages.create(req.body);

    // Store in cache if this was a cacheable request
    if (cacheKey && response.content?.length > 0) {
      cleanCache();
      cache.set(cacheKey, {
        response,
        timestamp: Date.now(),
      });
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error('Anthropic API error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}