// api/tdx-bus.js
// 後端 Proxy：查詢 TDX 公車到站資料
// 包含：輸入驗證、Rate Limit、Token 快取

// ── Rate Limit（每 IP 每分鐘最多 60 次）──────────────────────
const rateMap = {};
const RATE_LIMIT = 60;
const RATE_WINDOW = 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  if (!rateMap[ip]) rateMap[ip] = { count: 0, reset: now + RATE_WINDOW };
  if (now > rateMap[ip].reset) {
    rateMap[ip] = { count: 0, reset: now + RATE_WINDOW };
  }
  rateMap[ip].count++;
  return rateMap[ip].count <= RATE_LIMIT;
}

// ── TDX Token 快取──────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getTDXToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const clientId     = process.env.TDX_CLIENT_ID;
  const clientSecret = process.env.TDX_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('TDX not configured');

  const res = await fetch(
    'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`
    }
  );
  if (!res.ok) throw new Error('TDX auth failed: ' + res.status);
  const data = await res.json();
  if (!data.access_token) throw new Error('No token in TDX response');
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── 允許的縣市白名單 ──────────────────────────────────────
const ALLOWED_CITIES = new Set(['Taoyuan', 'NewTaipei', 'Taipei', 'Keelung']);

// ── 站名清單（允許查詢的站牌）────────────────────────────
const ALLOWED_STOPS = new Set([
  '長庚轉運站', '長庚醫院', '體育大學', 'A7長庚',
  '長庚科技大學', '長庚大學',
]);

function sanitizeText(str) {
  // 只允許中文、英文、數字、空白
  return /^[一-龥a-zA-Z0-9\s]{1,50}$/.test(str);
}

export default async function handler(req, res) {
  // ── CORS ─────────────────────────────────────────────────
  const allowed = [
    process.env.ALLOWED_ORIGIN,
    'https://cgustbus.vercel.app',
    'https://cgustbus-ilj49maz6-cgust.vercel.app',
  ].filter(Boolean);

  const origin = req.headers.origin || '';
  const originOk = !origin || allowed.some(o => origin === o);
  if (!originOk) return res.status(403).json({ error: 'Origin not allowed' });
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  // ── Rate Limit ────────────────────────────────────────────
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests, please try again later' });
  }

  // ── 輸入驗證 ─────────────────────────────────────────────
  const { city, stop } = req.query;

  if (!city || !stop) {
    return res.status(400).json({ error: 'Missing required params: city, stop' });
  }
  if (!ALLOWED_CITIES.has(city)) {
    return res.status(400).json({ error: 'Invalid city parameter' });
  }
  if (!ALLOWED_STOPS.has(stop)) {
    return res.status(400).json({ error: 'Invalid stop parameter' });
  }
  if (!sanitizeText(stop)) {
    return res.status(400).json({ error: 'Invalid stop name format' });
  }

  // ── 取得 Token 並查詢資料 ─────────────────────────────────
  try {
    const token = await getTDXToken();
    const stopEncoded = encodeURIComponent(stop);
    const url = `https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/${city}?$filter=StopName/Zh_tw eq '${stopEncoded}'&$format=JSON&$top=100`;

    const dataRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Accept-Encoding': 'gzip'
      }
    });

    if (!dataRes.ok) {
      console.error('[tdx-bus] Data fetch error:', dataRes.status);
      return res.status(502).json({ error: 'TDX data fetch failed' });
    }

    const data = await dataRes.json();
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({ data });

  } catch (err) {
    console.error('[tdx-bus] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
