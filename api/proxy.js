// api/proxy.js
// Vercel Edge function (runtime: 'edge') — uses Request/Response API and avoids Node incoming-message JSON issues.
// Paste this exact file, commit & push, then re-deploy on Vercel.
//
// Required env vars in Vercel:
// - N8N_WEBHOOK_URL
// - PROXY_SECRET
// Optional: INTERNAL_AUTH_TOKEN, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, FORWARD_TIMEOUT_MS, ALLOWED_ORIGINS

export const config = { runtime: 'edge' };

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const PROXY_SECRET = process.env.PROXY_SECRET;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

let rateMap = {}; // in-memory (edge ephemeral) rate limiter — okay for demo

function getClientIp(req) {
  const forwarded = req.headers.get('x-forwarded-for');
  return forwarded || (req.headers.get('x-vercel-ip-city') ? req.headers.get('x-vercel-ip-city') : 'unknown');
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

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default async function handler(req) {
  try {
    if (!N8N_WEBHOOK_URL) {
      console.error('Missing N8N_WEBHOOK_URL');
      return jsonResponse(500, { error: 'Server misconfigured: missing N8N_WEBHOOK_URL' });
    }
    if (!PROXY_SECRET) {
      console.error('Missing PROXY_SECRET');
      return jsonResponse(500, { error: 'Server misconfigured: missing PROXY_SECRET' });
    }

    // CORS (demo)
    const origin = req.headers.get('origin') || '*';
    const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',');
    const allowOrigin = (allowed.includes('*') || allowed.includes(origin)) ? origin : 'null';

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-proxy-secret, Authorization, x-from-proxy, x-internal-auth',
          'Access-Control-Max-Age': '600'
        }
      });
    }

    // Validate secret (read header)
    const providedSecret = (req.headers.get('x-proxy-secret') || req.headers.get('authorization') || '').toString();
    if (!providedSecret || providedSecret !== PROXY_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized - invalid proxy secret' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowOrigin } });
    }

    // Rate limiting (best-effort)
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowOrigin } });
    }

    // Read raw body as text
    let bodyText = null;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      bodyText = await req.text();
      if (!bodyText) bodyText = '{}';
    }

    // Build forward URL and copy query params
    const forwardUrl = new URL(N8N_WEBHOOK_URL);
    const urlObj = new URL(req.url);
    urlObj.searchParams.forEach((value, key) => forwardUrl.searchParams.append(key, value));

    // Forward headers
    const forwardHeaders = new Headers();
    forwardHeaders.set('Content-Type', req.headers.get('content-type') || 'application/json');
    forwardHeaders.set('x-from-proxy', process.env.N8N_EXPECTED_PROXY_HEADER || 'vercel-proxy');
    if (process.env.INTERNAL_AUTH_TOKEN) forwardHeaders.set('x-internal-auth', process.env.INTERNAL_AUTH_TOKEN);

    // Forward request with timeout
    const timeoutMs = parseInt(process.env.FORWARD_TIMEOUT_MS || '30000', 10);
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    const upstreamResp = await fetch(forwardUrl.toString(), {
      method: req.method,
      headers: forwardHeaders,
      body: bodyText,
      signal: controller.signal
    });

    clearTimeout(id);

    const text = await upstreamResp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }

    // Return upstream response wrapped
    return new Response(JSON.stringify({ forwarded: true, status: upstreamResp.status, response: parsed }), {
      status: upstreamResp.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowOrigin }
    });
  } catch (err) {
    console.error('Proxy exception:', err && (err.stack || err.message || err));
    if (err && err.name === 'AbortError') {
      return jsonResponse(504, { error: 'Upstream request timed out' });
    }
    return jsonResponse(500, { error: 'Proxy failed', details: err && (err.message || String(err)) });
  }
}
