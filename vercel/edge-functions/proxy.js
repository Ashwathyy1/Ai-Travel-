export const config = { runtime: 'edge' };

export default async function handler(request) {
  try {
    const SECRET = process.env.PROXY_SECRET || null;
    const TARGET = process.env.N8N_WEBHOOK_URL || null;
    const INTERNAL = process.env.INTERNAL_AUTH_TOKEN || null;

    // Read incoming raw body & headers
    const rawBody = await request.text().catch(()=>"");
    const headers = {};
    request.headers.forEach((v,k)=> headers[k]=v);

    // Return everything right away (no upstream fetch) so we can inspect
    return new Response(JSON.stringify({
      debug: true,
      env: { PROXY_SECRET: !!SECRET, N8N_WEBHOOK_URL: TARGET ? TARGET : null, INTERNAL_AUTH_TOKEN: !!INTERNAL },
      receivedHeaders: headers,
      rawBody,
      requestUrl: request.url
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "proxy-debug-crash", details: String(err) }), { status: 500, headers: { "Content-Type":"application/json" }});
  }
}
