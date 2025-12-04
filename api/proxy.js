// api/plan.js
// Vercel serverless proxy to forward requests from the browser to your n8n webhook securely.
// Usage: browser calls GET/POST /api/plan with header "x-proxy-secret" set to PROXY_SECRET (or from server-side).
//
// Environment variables (set in Vercel):
// - N8N_WEBHOOK_URL  : full n8n webhook URL (production webhook, NOT test)
// - PROXY_SECRET     : a strong random secret that the client must present
// - RATE_LIMIT_MAX   : (optional) max requests per window (default 20)
// - RATE_LIMIT_WINDOW_MS : (optional) window ms (default 60_000 ms)

// NOTE: This is a simple implementation for MVP / demo. For production use a persistent rate limiter, better logging, and monitoring.

const fetch = require('node-fetch');

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const PROXY_SECRET = process.env.PROXY_SECRET;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10); // 60s

if (!N8N_WEBHOOK_URL) {
  console.error('Missing N8N_WEBHOOK_URL env var');
}

let rateMap = {}; // { ip: { count, windowStart } } -- in-memory only

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateMap[ip];
  if (!entry) {
    rateMap[ip] = { count: 1, windowStart: now };
    return false;
  }
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // reset window
    rateMap[ip] = { count: 1, windowStart: now };
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

module.exports = async (req, res) => {
  // Basic CORS for demo - only allow your deployed origin(s) in production
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',');
  const origin = req.headers.origin || '*';
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-proxy-secret, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  // 1) verify proxy secret
  const providedSecret = req.headers['x-proxy-secret'] || req.headers['authorization'];
  if (!PROXY_SECRET || !providedSecret || providedSecret !== PROXY_SECRET) {
    return sendJson(res, 401, { error: 'Unauthorized - invalid proxy secret' });
  }

  // 2) rate limit per IP (simple demo)
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return sendJson(res, 429, { error: 'Rate limit exceeded. Slow down.' });
  }

  // 3) basic input validation / size limits
  try {
    if (req.headers['content-length'] && parseInt(req.headers['content-length'], 10) > 200000) {
      return sendJson(res, 413, { error: 'Payload too large' });
    }
  } catch (e) {
    // ignore
  }

  // 4) prepare forwarded request to n8n
  const forwardHeaders = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    // Add a custom header that n8n will validate to ensure the request came from your proxy
    'x-from-proxy': 'vercel-proxy',
  };

  // Optionally forward an "Authorization" header from your backend (not the browser). We don't forward browser tokens by default.
  if (process.env.INTERNAL_AUTH_TOKEN) {
    forwardHeaders['x-internal-auth'] = process.env.INTERNAL_AUTH_TOKEN;
  }

  // For GET, just proxy querystring
  const url = new URL(N8N_WEBHOOK_URL);
  // If your UI sends query params, append them:
  Object.keys(req.query || {}).forEach(k => url.searchParams.append(k, req.query[k]));

  // Build body
  let body = null;
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    // Read raw body (Vercel will have parsed req.body for us if using frameworks; when using node fetch, ensure JSON body)
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  }

  // 5) Forward to n8n
  try {
    const controller = new AbortController();
    const timeoutMs = parseInt(process.env.FORWARD_TIMEOUT_MS || '30000', 10); // 30s default
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const n8nResp = await fetch(url.toString(), {
      method: req.method,
      headers: forwardHeaders,
      body: body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await n8nResp.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = { raw: text };
    }

    // Mirror n8n status
    res.statusCode = n8nResp.status;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ forwarded: true, status: n8nResp.status, response: parsed }));
  } catch (err) {
    console.error('Proxy error:', err && err.message ? err.message : err);
    if (err.name === 'AbortError') {
      return sendJson(res, 504, { error: 'Upstream request timed out' });
    }
    return sendJson(res, 500, { error: 'Proxy failed', details: err.message || String(err) });
  }
};

