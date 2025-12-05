export default async function handler(request) {
  const SECRET = process.env.PROXY_SECRET;
  const TARGET = process.env.N8N_WEBHOOK_URL;

  if (!SECRET || !TARGET) {
    return new Response(JSON.stringify({ error: "Missing env vars" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  if (request.headers.get("x-proxy-secret") !== SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const body = await request.text();
  const url = new URL(request.url);
  const forward = new URL(TARGET);
  url.searchParams.forEach((v, k) => forward.searchParams.append(k, v));

  const upstream = await fetch(forward.toString(), {
    method: request.method,
    headers: { "Content-Type": request.headers.get("content-type") || "application/json", "x-from-proxy": "vercel-proxy" },
    body: body || "{}",
  });

  const text = await upstream.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

  return new Response(JSON.stringify(parsed), {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
