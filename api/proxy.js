// api/proxy.js
// Safer Vercel serverless proxy (no node-fetch dependency)
// Replace existing content with this, then commit & push.

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const PROXY_SECRET = process.env.PROXY_SECRET;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

let rateMap = {};

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
    // Quick sanity checks
    if (!N8N_WEBHOOK_URL) {
      console.error('Missing N8N_WEBHOOK_URL env var');
      return sendJson(res, 500, { error: 'Server misconfigured: missing N8N_WEBHOOK_URL' });
    }
    if (!PROXY_SECRET) {
      console.error('Missing PROXY_SECRET env var');
      return sendJson(res, 500, { error: 'Server misconfigured: missing PROXY_SECRET' });
    }

    // CORS (for demo)
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',');
    const origin = req.headers.origin || '*';
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-proxy-secret, Authorization, x-from-proxy');
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    // Validate secret header
    const providedSecret = req.headers['x-proxy-secret'] || req.headers['authorization'];
    if (!providedSecret || providedSecret !== PROXY_SECRET) {
      return sendJson(res, 401, { error: 'Unauthorized - invalid proxy secret' });
    }

    // Rate limit
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      return sendJson(res, 429, { error: 'Rate limit exceeded' });
    }

    // Body size guard
    if (req.headers['content-length'] && parseInt(req.headers['content-length'], 10) > 200000) {
      return sendJson(res, 413, { error: 'Payload too large' });
    }

    // Build forward request
    const url = new URL(N8N_WEBHOOK_URL);
    // forward query params if provided
    if (req.query) {
      Object.keys(req.query).forEach(k => url.searchParams.append(k, req.query[k]));
    }

    const forwardHeaders = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'x-from-proxy': process.env.N8N_EXPECTED_PROXY_HEADER || 'vercel-proxy'
    };
    if (process.env.INTERNAL_AUTH_TOKEN) {
      forwardHeaders['x-internal-auth'] = process.env.INTERNAL_AUTH_TOKEN;
    }

    // Build body string
    let body = null;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      // Some frameworks parse body for you; ensure string
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    }

    // Use global fetch (Vercel Node 18+ supports it)
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

    const text = await n8nResp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }

    res.statusCode = n8nResp.status;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ forwarded: true, status: n8nResp.status, response: parsed }));
  } catch (err) {
    console.error('Proxy exception:', err && (err.stack || err.message || err));
    if (err.name === 'AbortError') {
      return sendJson(res, 504, { error: 'Upstream request timed out' });
    }
    return sendJson(res, 500, { error: 'Proxy failed', details: err.message || String(err) });
  }
};

