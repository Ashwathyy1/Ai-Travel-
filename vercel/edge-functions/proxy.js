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
// Build forward URL and append proxy token as a query param
const forwardUrl = new URL(TARGET);
const incomingUrl = new URL(request.url);
incomingUrl.searchParams.forEach((v, k) => forwardUrl.searchParams.append(k, v));

// Append token in query so n8n always receives it (safer vs custom headers)
if (process.env.INTERNAL_AUTH_TOKEN) {
  forwardUrl.searchParams.set('_proxy_token', process.env.INTERNAL_AUTH_TOKEN);
}

// Prepare headers (marker optional)
const forwardHeaders = new Headers();
forwardHeaders.set('Content-Type', request.headers.get('content-type') || 'application/json');
forwardHeaders.set('x-from-proxy', 'vercel-proxy');

// Forward request
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
