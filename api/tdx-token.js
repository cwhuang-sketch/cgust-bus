// api/tdx-token.js
// 後端 Proxy：向 TDX 取得 Token，金鑰完全隱藏在伺服器端

let cachedToken = null;
let tokenExpiry = 0;

export default async function handler(req, res) {
  // ── CORS：只允許同網域或指定來源 ──────────────────────────
  const allowed = [
    process.env.ALLOWED_ORIGIN,       // 環境變數設定（例如學校網域）
    'https://cgust-bus.vercel.app',   // Vercel 部署網址
  ].filter(Boolean);

  const origin = req.headers.origin || '';
  const originOk = allowed.length === 0 || allowed.some(o => origin === o);
  if (!originOk) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Token 尚未過期則直接回傳快取
    if (cachedToken && Date.now() < tokenExpiry) {
      return res.status(200).json({ token: cachedToken });
    }

    const clientId     = process.env.TDX_CLIENT_ID;
    const clientSecret = process.env.TDX_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.status(503).json({ error: 'TDX API not configured — please set environment variables' });
    }

    const response = await fetch(
      'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error('[tdx-token] Auth failed:', response.status, text);
      return res.status(502).json({ error: 'TDX authentication failed' });
    }

    const data = await response.json();
    if (!data.access_token) {
      console.error('[tdx-token] No access_token in response:', data);
      return res.status(502).json({ error: 'Invalid TDX response' });
    }

    cachedToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;

    return res.status(200).json({ token: cachedToken });

  } catch (err) {
    console.error('[tdx-token] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
