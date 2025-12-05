// api/proxy.js (minimal Edge proxy)
// Paste this file exactly at /api/proxy.js, commit & push to GitHub, then let Vercel deploy.
//
// Required env vars in Vercel:
// - N8N_WEBHOOK_URL  (e.g. https://httpbin.org/post for testing)
// - PROXY_SECRET     (e.g. Ashneer)

export const config = { runtime: 'edge' };

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const PROXY_SECRET = process.env.PROXY_SECRET;

const json = (s, o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

export default async function handler(req) {
  try {
    if (!N8N_WEBHOOK_URL || !PROXY_SECRET) return json('err', { error: 'Missing env vars' }, 500);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,x-proxy-secret' } });

    const provided = (req.headers.get('x-proxy-secret') || req.headers.get('authorization') || '').toString();
    if (!provided || provided !== PROXY_SECRET) return json('unauth', { error: 'Unauthorized' }, 401);

    const body = (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') ? await req.text() : undefined;

    const forwardUrl = new URL(N8N_WEBHOOK_URL);
    // copy query params
    new URL(req.url).searchParams.forEach((v, k) => forwardUrl.searchParams.append(k, v));

    const upstream = await fetch(forwardUrl.toString(), {
      method: req.method,
      headers: { 'Content-Type': req.headers.get('content-type') || 'application/json', 'x-from-proxy': 'vercel-proxy' },
      body,
    });

    const text = await upstream.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return json('ok', { forwarded: true, status: upstream.status, response: parsed }, upstream.status);
  } catch (err) {
    return json('err', { error: 'Proxy failed', details: err?.message || String(err) }, 500);
  }
}
