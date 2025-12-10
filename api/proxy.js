export const config = { runtime: 'edge' };

export default async function handler(request) {
  try {
    const SECRET = process.env.PROXY_SECRET;
    const TARGET = process.env.N8N_WEBHOOK_URL;

    // Validate secret
    const incomingSecret = request.headers.get("x-proxy-secret");
    if (!incomingSecret || incomingSecret !== SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized - invalid proxy secret" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Read body
    const rawBody = await request.text();
    
    // Forward request to Make.com webhook
    const makeResp = await fetch(TARGET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody
    });

    const makeData = await makeResp.text();

    return new Response(makeData, {
      status: makeResp.status,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "proxy-forward-error", details: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
