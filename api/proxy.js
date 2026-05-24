const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Simple in-memory rate limiter — resets when server restarts
// Acts as a backstop against abuse beyond the app-level limits
const rateLimitMap = new Map();
const WINDOW_MS    = 60 * 1000; // 1 minute window
const MAX_REQUESTS = 10;        // max 10 requests per IP per minute

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > entry.resetAt) {
    // Window expired — reset
    entry.count   = 0;
    entry.resetAt = now + WINDOW_MS;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);

  // Clean up old entries periodically
  if (rateLimitMap.size > 10000) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }

  return entry.count > MAX_REQUESTS;
}

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
    const response = await client.messages.create(req.body);
    return res.status(200).json(response);
  } catch (error) {
    console.error('Anthropic API error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}