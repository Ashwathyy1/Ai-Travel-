// api/proxy.js
// Vercel serverless proxy (safe raw-body reading, no external deps)
// Paste this file at /api/proxy.js, commit & push, then redeploy on Vercel.
//
// Required env vars (set in Vercel Settings):
// - N8N_WEBHOOK_URL  (e.g. https://your-n8n.example/webhook/xxx)
// - PROXY_SECRET     (the secret your client sends in x-proxy-secret header)
// Optional:
// - INTERNAL_AUTH_TOKEN
// - RATE_LIMIT_MAX (default 20)
// - RATE_LIMIT_WINDOW_MS (default 60000)
// - FORWARD_TIMEOUT_MS (default 30000)
// - ALLOWED_ORIGINS (comma-separated, default '*')

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const PROXY_SECRET = process.env.PROXY_SECRET;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

let rateMap = {}; // in-memory rate limiter (demo only)

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
}
function isRateLimited(ip) {
  const now = Date.now();
  const e = rateMap[ip];
  if (!e) {
    rateMap[ip] = { count: 1, windowStart: now };
    return false;
  }
  if (now - e.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateMap[ip] = { count: 1, windowStart: now };
    return false;
  }
  e.count += 1;
  return e.count > RATE_LIMIT_MAX;
}
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

module.exports = async (req, res) => {
  try {
    // Basic server-side validation
    if (!N8N_WEBHOOK_URL) {
      console.error('Missing N8N_WEBHOOK_URL env var');
      return sendJson(res, 500, { error: 'Server misconfigured: missing N8N_WEBHOOK_URL' });
    }
    if (!PROXY_SECRET) {
      console.error('Missing PROXY_SECRET env var');
      return sendJson(res, 500, { error: 'Server misconfigured: missing PROXY_SECRET' });
    }

    // CORS (demo). For production, set exact origins in ALLOWED_ORIGINS.
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',');
    const origin = req.headers.origin || '*';
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-proxy-secret, Authorization, x-from-proxy, x-internal-auth');
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    // 1) verify proxy secret
    const providedSecret = (req.headers['x-proxy-secret'] || req.headers['authorization'] || '').toString();
    if (!providedSecret || providedSecret !== PROXY_SECRET) {
      return sendJson(res, 401, { error: 'Unauthorized - invalid proxy secret' });
    }

    // 2) rate limit
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      return sendJson(res, 429, { error: 'Rate limit exceeded' });
    }

    // 3) payload size guard
    if (req.headers['content-length'] && parseInt(req.headers['content-length'], 10) > 200000) {
      return sendJson(res, 413, { error: 'Payload too large' });
    }

    // 4) safely read raw request body for POST/PUT/PATCH
    let body = null;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      try {
        body = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', chunk => { data += chunk; });
          req.on('end', () => resolve(data));
          req.on('error', err => reject(err));
        });
        if (!body) body = '{}';
      } catch (e) {
        console.warn('Failed to read raw body, defaulting to {}', e && e.message);
        body = '{}';
      }
    }

    // 5) prepare forward URL (append query params if present)
    const url = new URL(N8N_WEBHOOK_URL);
    if (req.query) {
      Object.keys(req.query).forEach(k => url.searchParams.append(k, req.query[k]));
    }

    // 6) forward headers (include a proxy marker header that n8n can validate)
    const forwardHeaders = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'x-from-proxy': process.env.N8N_EXPECTED_PROXY_HEADER || 'vercel-proxy'
    };
    if (process.env.INTERNAL_AUTH_TOKEN) {
      forwardHeaders['x-internal-auth'] = process.env.INTERNAL_AUTH_TOKEN;
    }

    // 7) forward request to upstream (global fetch available on Vercel)
    const timeoutMs = parseInt(process.env.FORWARD_TIMEOUT_MS || '30000', 10);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const n8nResp = await fetch(url.toString(), {
      method: req.method,
      headers: forwardHeaders,
      body: body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Read upstream response
    const text = await n8nResp.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = { raw: text };
    }

    res.statusCode = n8nResp.status;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ forwarded: true, status: n8nResp.status, response: parsed }));
  } catch (err) {
    // log the stack trace for Vercel function logs
    console.error('Proxy exception:', err && (err.stack || err.message || err));
    if (err && err.name === 'AbortError') {
      return sendJson(res, 504, { error: 'Upstream request timed out' });
    }
    return sendJson(res, 500, { error: 'Proxy failed', details: err && (err.message || String(err)) });
  }
};

