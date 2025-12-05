export const config = { runtime: 'edge' };

// Minimal safe Edge proxy

const SECRET = process.env.PROXY_SECRET;
const TARGET = process.env.N8N_WEBHOOK_URL;

export default async function handler(req) {
  if (!SECRET || !TARGET) {
    return new Response(JSON.stringify({ error: "Missing env vars" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,x-proxy-secret'
      }
    });
  }

  const provided = (req.headers.get("x-proxy-secret") || req.headers.get("authorization") || '').toString();
  if (provided !== SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const body = await req.text();
  const url = new URL(req.url);
  const forwardUrl = new URL(TARGET);

  // copy query params
  url.searchParams.forEach((v, k) => forwardUrl.searchParams.append(k, v));

  const upstream = await fetch(forwardUrl, {
    method: req.method,
    headers: { "Content-Type": req.headers.get("content-type") ?? "application/json", "x-from-proxy": "vercel-proxy" },
    body: body || "{}",
  });

  const text = await upstream.text();
  let parsed = null;

  try { parsed = JSON.parse(text); }
  catch { parsed = { raw: text }; }

  return new Response(JSON.stringify(parsed), {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
