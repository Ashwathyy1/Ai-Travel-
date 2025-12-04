// api/proxy.js
// Vercel serverless proxy - avoids accessing req.body or req.query (reads raw request + URL manually)
// Paste this file at /api/proxy.js, commit & push, then redeploy on Vercel.
//
// Required env vars:
// - N8N_WEBHOOK_URL
// - PROXY_SECRET
// Optional:
// - INTERNAL_AUTH_TOKEN
// - RATE_LIMIT_MAX (default 20)
// - RATE_LIMIT_WINDOW_MS (default 60000)
// - FORWARD_TIMEOUT_MS (default 30000)
// - ALLOWED_ORIGINS (comma-separated)

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

// helper: parse query params from req.url manually (avoid req.query)
function parseQueryParams(req) {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const obj = {};
    for (const [k, v] of url.searchParams.entries()) obj[k] = v;
    return obj;
  } catch (e) {
    return {};
  }
}

module.exports = async (req, res) => {
  try {
    if (!N8N_WEBHOOK_URL) {
      console.error('Missing N8N_WEBHOOK_URL');
      return sendJson(res, 500, { error: 'Server misconfigured: missing N8N_WEBHOOK_URL' });
    }
    if (!PROXY_SECRET) {
      console.error('Missing PROXY_SECRET');
      return sendJson(res, 500, { error: 'Server misconfigured: missing PROXY_SECRET' });
    }

    // CORS (demo)
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

    // validate secret (read header only)
    const providedSecret = (req.headers['x-proxy-secret'] || req.headers['authorization'] || '').toString();
    if (!providedSecret || providedSecret !== PROXY_SECRET) {
      return sendJson(res, 401, { error: 'Unauthorized - invalid proxy secret' });
    }

    // rate limit
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      return sendJson(res, 429, { error: 'Rate limit exceeded' });
    }

    // size guard using header only
    if (req.headers['content-length'] && parseInt(req.headers['content-length'], 10) > 200000) {
      return sendJson(res, 413, { error: 'Payload too large' });
    }

    // read raw request body (do NOT reference req.body)
    let body = null;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => resolve(data));
        req.on('error', err => reject(err));
      }).catch(err => {
        console.warn('raw body read failed', err && err.message);
        return '{}';
      });
      if (!body) body = '{}';
    }

    // Build forward URL and append query params parsed manually
    const forwardUrl = new URL(N8N_WEBHOOK_URL);
    const q = parseQueryParams(req);
    Object.keys(q).forEach(k => forwardUrl.searchParams.append(k, q[k]));

    // Prepare forward headers
    const forwardHeaders = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'x-from-proxy': process.env.N8N_EXPECTED_PROXY_HEADER || 'vercel-proxy'
    };
    if (process.env.INTERNAL_AUTH_TOKEN) {
      forwardHeaders['x-internal-auth'] = process.env.INTERNAL_AUTH_TOKEN;
    }

    // Forward request using global fetch
    const timeoutMs = parseInt(process.env.FORWARD_TIMEOUT_MS || '30000', 10);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const upstream = await fetch(forwardUrl.toString(), {
      method: req.method,
      headers: forwardHeaders,
      body: body,
      signal: controller.signal,
    }).catch(err => { throw err; });

    clearTimeout(timeout);

    const text = await upstream.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }

    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ forwarded: true, status: upstream.status, response: parsed }));
  } catch (err) {
    console.error('Proxy exception:', err && (err.stack || err.message || err));
    if (err && err.name === 'AbortError') {
      return sendJson(res, 504, { error: 'Upstream request timed out' });
    }
    return sendJson(res, 500, { error: 'Proxy failed', details: err && (err.message || String(err)) });
  }
};
