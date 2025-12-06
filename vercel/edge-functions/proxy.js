export const config = { runtime: 'edge' };

export default async function handler(request) {
  try {
    const SECRET = process.env.PROXY_SECRET;
    const TARGET = process.env.N8N_WEBHOOK_URL;
    const INTERNAL = process.env.INTERNAL_AUTH_TOKEN;

    if (!SECRET || !TARGET) {
      return new Response(JSON.stringify({ error: "Missing env vars" }), { status: 500, headers: { "Content-Type": "application/json" }});
    }

    if (request.headers.get("x-proxy-secret") !== SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized - bad secret" }), { status: 401, headers: { "Content-Type": "application/json" }});
    }

    const body = await request.text().catch(()=>"{}");

    // build forward URL + probe token
    const forwardUrl = new URL(TARGET);
    const incomingUrl = new URL(request.url);
    incomingUrl.searchParams.forEach((v,k)=> forwardUrl.searchParams.append(k,v));
    if (INTERNAL) forwardUrl.searchParams.set('_proxy_token', INTERNAL);

    const forwardHeaders = new Headers();
    forwardHeaders.set('Content-Type', request.headers.get('content-type') || 'application/json');
    forwardHeaders.set('x-from-proxy','vercel-proxy');

    // Do the fetch and capture everything (no parsing)
    let upstream;
    let upstreamStatus = null;
    let upstreamHeaders = {};
    let upstreamBody = "";
    try {
      upstream = await fetch(forwardUrl.toString(), {
        method: request.method,
        headers: forwardHeaders,
        body: body || "{}",
      });
      upstreamStatus = upstream.status;
      upstream.headers.forEach((v,k)=> { upstreamHeaders[k]=v; });
      upstreamBody = await upstream.text();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Upstream fetch failed", details: String(e), forwardUrl: forwardUrl.toString() }), { status: 502, headers: { "Content-Type":"application/json" }});
    }

    return new Response(JSON.stringify({
      debug: true,
      forwardUrl: forwardUrl.toString(),
      upstreamStatus,
      upstreamHeaders,
      upstreamBody
    }), { status: 200, headers: { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" }});
  } catch (err) {
    return new Response(JSON.stringify({ error: "Proxy crashed", details: String(err) }), { status: 500, headers:{ "Content-Type":"application/json" }});
  }
}
