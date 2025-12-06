// /api/debug-proxy.js - serverless Node function (Vercel will use Serverless runtime)
export default async function handler(req, res) {
  try {
    // raw body
    let raw = '';
    try {
      raw = await new Promise((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data || ''));
        req.on('error', () => resolve(''));
      });
    } catch (e) { raw = ''; }

    // collect headers
    const headers = {};
    for (const k in req.headers) headers[k] = req.headers[k];

    // env presence and values (do NOT print secret values)
    const envInfo = {
      PROXY_SECRET_SET: !!process.env.PROXY_SECRET,
      N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || null,
      INTERNAL_AUTH_TOKEN_SET: !!process.env.INTERNAL_AUTH_TOKEN
    };

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({
      debug: true,
      envInfo,
      requestUrl: req.url,
      method: req.method,
      headers,
      rawBody: raw
    }, null, 2));
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).send(JSON.stringify({ error: String(err) }));
  }
}
