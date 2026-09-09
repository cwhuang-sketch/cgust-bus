// api/tdx-bus.js
// 後端 Proxy：查詢 TDX 公車到站資料
// 包含：輸入驗證、Rate Limit、Token 快取、雙 TDX 帳號自動切換（第一組額滿自動換第二組）

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

// ── 雙 TDX 帳號設定：第一組（primary）額滿時自動切到第二組（secondary）──
// TDX_CLIENT_ID_2 / TDX_CLIENT_SECRET_2 沒設定時，系統只會用第一組，行為跟原本一樣。
const TDX_ACCOUNTS = [
  { label: 'primary',   id: process.env.TDX_CLIENT_ID,   secret: process.env.TDX_CLIENT_SECRET },
  { label: 'secondary', id: process.env.TDX_CLIENT_ID_2, secret: process.env.TDX_CLIENT_SECRET_2 },
].filter(a => a.id && a.secret);

const tokenCache = {}; // { primary: {token, expiry}, secondary: {token, expiry} }

async function getTDXToken(account) {
  const cached = tokenCache[account.label];
  if (cached && Date.now() < cached.expiry) return cached.token;

  const res = await fetch(
    'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(account.id)}&client_secret=${encodeURIComponent(account.secret)}`
    }
  );
  if (res.status === 429) {
    const err = new Error('TDX auth quota exceeded');
    err.quotaExceeded = true;
    throw err;
  }
  if (!res.ok) throw new Error('TDX auth failed: ' + res.status);
  const data = await res.json();
  if (!data.access_token) throw new Error('No token in TDX response');
  tokenCache[account.label] = { token: data.access_token, expiry: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

// 記錄「某組帳號額滿」事件到資料庫，供後台查詢歷史。這裡失敗也不能影響主要查詢功能，只記 log。
async function logQuotaEvent(account, endpoint) {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return;
    await fetch(`${url}/rest/v1/tdx_quota_events`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ account, endpoint })
    });
  } catch (e) {
    console.error('[logQuotaEvent] 記錄額度事件失敗（不影響主要功能）:', e.message);
  }
}

// 用某一組帳號查詢一次公車即時到站資料；額滿會丟出 quotaExceeded 錯誤，由外層決定要不要換下一組帳號
async function fetchArrivalWith(account, city, stopEncoded) {
  let token = await getTDXToken(account);
  const url = `https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/${city}?$filter=StopName/Zh_tw eq '${stopEncoded}'&$format=JSON&$top=100`;

  let dataRes = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' } });

  // Token 可能已經失效（快取到期時間跟 TDX 實際狀態不一致），收到 401 就清快取、換新 token 後重試一次
  if (dataRes.status === 401) {
    delete tokenCache[account.label];
    token = await getTDXToken(account);
    dataRes = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' } });
  }

  if (dataRes.status === 429) {
    const err = new Error(`TDX quota exceeded (${account.label})`);
    err.quotaExceeded = true;
    throw err;
  }
  if (!dataRes.ok) {
    throw new Error('TDX data fetch failed: ' + dataRes.status);
  }
  return dataRes.json();
}

// ── 允許的縣市白名單 ──────────────────────────────────────
const ALLOWED_CITIES = new Set(['Taoyuan', 'NewTaipei', 'Taipei', 'Keelung']);

function sanitizeText(str) {
  // 只允許中文、英文、數字、空白，且長度合理（1~50字），防止注入或濫用查詢
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
    return res.status(429).json({ error: 'quota_exceeded', message: '查詢量過高，請稍後再試' });
  }

  // ── 輸入驗證 ─────────────────────────────────────────────
  const { city, stop } = req.query;

  if (!city || !stop) {
    return res.status(400).json({ error: 'Missing required params: city, stop' });
  }
  if (!ALLOWED_CITIES.has(city)) {
    return res.status(400).json({ error: 'Invalid city parameter' });
  }
  if (!sanitizeText(stop)) {
    return res.status(400).json({ error: 'Invalid stop name format' });
  }

  if (!TDX_ACCOUNTS.length) {
    return res.status(503).json({ error: 'TDX not configured' });
  }

  const stopEncoded = encodeURIComponent(stop);

  // ── 依序嘗試每一組帳號：不管是額滿還是其他暫時性錯誤，都會換下一組帳號再試，
  //    確保兩組帳號真的能互為備援，不會因為某一組偶發性錯誤就直接判定整個查詢失敗。
  let lastNonQuotaError = null;
  for (const account of TDX_ACCOUNTS) {
    try {
      const data = await fetchArrivalWith(account, city, stopEncoded);
      // Cache-Control 由 vercel.json 統一設定（讓 Vercel 邊緣網路可以在尖峰時段合併不同使用者的相同查詢，降低對 TDX 額度的衝擊）
      return res.status(200).json({ data });
    } catch (err) {
      if (err.quotaExceeded) {
        console.error(`[tdx-bus] TDX 額度已達上限 (${account.label})`);
        await logQuotaEvent(account.label, 'tdx-bus');
        continue; // 換下一組帳號再試
      }
      console.error(`[tdx-bus] 帳號 ${account.label} 查詢失敗:`, err.message);
      lastNonQuotaError = err;
      continue; // 這組帳號本身可能只是暫時性問題，仍然試試看下一組
    }
  }

  // 所有帳號都試過了：如果最後一個錯誤不是額度問題，回傳一般查詢失敗；否則才是真的全部額滿
  if (lastNonQuotaError) {
    return res.status(502).json({ error: 'TDX data fetch failed' });
  }
  return res.status(429).json({ error: 'quota_exceeded', message: 'TDX 查詢量已達上限，請稍後再試' });
}
