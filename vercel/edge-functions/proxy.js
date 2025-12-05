// Use the Edge runtime
export const config = { runtime: 'edge' };

// Main proxy handler
export default async function handler(request) {
  try {
    const SECRET = process.env.PROXY_SECRET;
    const TARGET = process.env.N8N_WEBHOOK_URL;
    const INTERNAL = process.env.INTERNAL_AUTH_TOKEN;

    // Validate env variables
    if (!SECRET || !TARGET) {
      return new Response(JSON.stringify({ error: "Missing env vars" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate proxy secret (header from client/your UI)
    if (request.headers.get("x-proxy-secret") !== SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized - bad secret" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Read incoming body
    let body = "{}";
    try {
      body = await request.text();
    } catch (e) {
      body = "{}";
    }

    // Build forward URL
    const forwardUrl = new URL(TARGET);

    // -------------------------
    // Build headers for n8n
    // -------------------------
    const forwardHeaders = new Headers();
    forwardHeaders.set("Content-Type", request.headers.get("content-type") || "application/json");

    // Proxy marker used by n8n
    forwardHeaders.set("x-from-proxy", "vercel-proxy");

    // ★ IMPORTANT: send Authorization: Bearer <token>
    if (INTERNAL) {
      forwardHeaders.set("Authorization", `Bearer ${INTERNAL}`);
    }

    // -------------------------
    // Forward the request to n8n
    // -------------------------
    const upstream = await fetch(forwardUrl.toString(), {
      method: request.method,
      headers: forwardHeaders,
      body: body || "{}",
    });

    // Read upstream response
    const txt = await upstream.text();
    let parsed;
    try {
      parsed = JSON.parse(txt);
    } catch {
      parsed = { raw: txt };
    }

    // Return structured response
    return new Response(
      JSON.stringify({
        forwarded: true,
        status: upstream.status,
        response: parsed,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, x-proxy-secret, Authorization, x-from-proxy",
        },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Proxy crashed", details: err.toString() }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
