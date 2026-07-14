// api/tdx-bus.js
// 後端 Proxy：查詢 TDX 公車到站資料
// 用法：GET /api/tdx-bus?city=Taoyuan&stop=長庚大學

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────
  const allowed = [
    process.env.ALLOWED_ORIGIN,
    'https://cgustbus.vercel.app',
    'https://cgustbus-ilj49maz6-cgust.vercel.app',
  ].filter(Boolean);

  const origin = req.headers.origin || '';
  // 無 Origin（直接瀏覽器/伺服器呼叫）→ 允許；有 Origin → 需在清單內
  const originOk = !origin || allowed.some(o => origin === o);
  if (!originOk) return res.status(403).json({ error: 'Origin not allowed' });
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { city, stop } = req.query;
  if (!city || !stop) {
    return res.status(400).json({ error: 'Missing required params: city, stop' });
  }

  // ── 取得 TDX Token ─────────────────────────────────────────
  let token;
  try {
    const clientId     = process.env.TDX_CLIENT_ID;
    const clientSecret = process.env.TDX_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.status(503).json({ error: 'TDX API not configured' });
    }

    const tokenRes = await fetch(
      'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`
      }
    );
    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      console.error('[tdx-bus] Token error:', t);
      return res.status(502).json({ error: 'TDX auth failed' });
    }
    const tokenData = await tokenRes.json();
    token = tokenData.access_token;
    if (!token) return res.status(502).json({ error: 'Invalid TDX token response' });

  } catch (err) {
    console.error('[tdx-bus] Token fetch error:', err);
    return res.status(500).json({ error: 'Token fetch failed' });
  }

  // ── 查詢到站資料 ──────────────────────────────────────────
  try {
    const stopEncoded = encodeURIComponent(stop);
    const url = `https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/${city}?$filter=StopName/Zh_tw eq '${stopEncoded}'&$format=JSON&$top=100`;

    const dataRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Accept-Encoding': 'gzip'
      }
    });

    if (!dataRes.ok) {
      const t = await dataRes.text();
      console.error('[tdx-bus] Data fetch error:', dataRes.status, t);
      return res.status(502).json({ error: 'TDX data fetch failed', status: dataRes.status });
    }

    const data = await dataRes.json();

    // 快取 30 秒（公車到站資料不需要太頻繁更新）
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({ data });

  } catch (err) {
    console.error('[tdx-bus] Data error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
