// api/tdx-stops.js
// 後台專用：依縣市＋關鍵字查詢 TDX 官方公車站牌名稱清單。
// 用途：後台設定「公車路線 → 停靠校內站點」時，讓管理員能查到「完全正確」的官方站牌名稱，
// 不用自己手動輸入猜測，避免打錯字導致即時到站查詢對不起來。
// 這支 API 需要登入（跟 schedule-admin.js 用同一套 session 驗證方式），避免被當成公開的 TDX 查詢代理濫用。

function setCORS(req, res) {
  const allowed = [
    process.env.ALLOWED_ORIGIN,
    'https://cgustbus.vercel.app',
  ].filter(Boolean);
  const origin = req.headers.origin || '';
  const ok = !origin || allowed.some(o => o === origin);
  if (!ok) return false;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return true;
}

async function verifySession(req, url, key) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  const r = await fetch(
    `${url}/rest/v1/sessions?token=eq.${encodeURIComponent(token)}&select=expires_at,accounts(username,role,active)`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!r.ok) return null;
  const sessions = await r.json();
  if (!sessions?.length) return null;
  const s = sessions[0];
  if (new Date(s.expires_at) < new Date()) return null;
  if (!s.accounts?.active) return null;
  return s.accounts;
}

// ── 雙 TDX 帳號設定：第一組（primary）額滿時自動切到第二組（secondary）──
const TDX_ACCOUNTS = [
  { label: 'primary',   id: process.env.TDX_CLIENT_ID,   secret: process.env.TDX_CLIENT_SECRET },
  { label: 'secondary', id: process.env.TDX_CLIENT_ID_2, secret: process.env.TDX_CLIENT_SECRET_2 },
].filter(a => a.id && a.secret);

const tokenCache = {};

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

async function fetchStopsWith(account, city, escapedKeyword) {
  const token = await getTDXToken(account);
  const tdxUrl = `https://tdx.transportdata.tw/api/basic/v2/Bus/Stop/City/${city}` +
    `?$filter=contains(StopName/Zh_tw,'${encodeURIComponent(escapedKeyword)}')` +
    `&$select=StopName&$top=20&$format=JSON`;

  const dataRes = await fetch(tdxUrl, {
    headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' }
  });
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

const ALLOWED_CITIES = new Set(['Taoyuan', 'NewTaipei', 'Taipei', 'Keelung']);

function sanitizeKeyword(str) {
  // 只允許中文、英文、數字、空白，長度合理，避免注入 OData $filter 字串
  return /^[一-龥a-zA-Z0-9\s]{1,30}$/.test(str);
}

export default async function handler(req, res) {
  if (!setCORS(req, res)) return res.status(403).json({ error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return res.status(503).json({ error: 'Database not configured' });

  // 這支 API 會直接向 TDX 查詢，需要登入才能使用
  const user = await verifySession(req, url, key);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const { city, keyword } = req.query;
  if (!city || !keyword) {
    return res.status(400).json({ error: 'Missing required params: city, keyword' });
  }
  if (!ALLOWED_CITIES.has(city)) {
    return res.status(400).json({ error: 'Invalid city parameter' });
  }
  if (!sanitizeKeyword(keyword)) {
    return res.status(400).json({ error: 'Invalid keyword format' });
  }

  if (!TDX_ACCOUNTS.length) {
    return res.status(503).json({ error: 'TDX not configured' });
  }

  // OData 單引號需要用兩個單引號跳脫
  const escapedKeyword = keyword.replace(/'/g, "''");

  let lastNonQuotaError = null;
  for (const account of TDX_ACCOUNTS) {
    try {
      const data = await fetchStopsWith(account, city, escapedKeyword);
      // 同一個站牌可能因為多路線經過而重複出現，這裡去掉重複的站名
      const names = [...new Set((data || []).map(s => s.StopName?.Zh_tw).filter(Boolean))];
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ data: names.map(name => ({ name })) });
    } catch (err) {
      if (err.quotaExceeded) {
        console.error(`[tdx-stops] TDX 額度已達上限 (${account.label})`);
        await logQuotaEvent(account.label, 'tdx-stops');
        continue;
      }
      console.error(`[tdx-stops] 帳號 ${account.label} 查詢失敗:`, err.message);
      lastNonQuotaError = err;
      continue;
    }
  }

  if (lastNonQuotaError) {
    return res.status(502).json({ error: 'TDX data fetch failed' });
  }
  return res.status(429).json({ error: 'quota_exceeded', message: 'TDX 查詢量已達上限，請稍後再試' });
}
