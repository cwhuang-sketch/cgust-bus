// api/tdx-route-directions.js
// 後台專用：查詢某條公車路線在 TDX 裡「Direction 0／1」實際的完整停靠站序（依序），
// 讓管理員可以核對自己在後台設定的「去程 (Direction 0)」「返程 (Direction 1)」
// 是不是真的跟 TDX 那邊的方向定義一致（TDX 的 0/1 不保證一定對應「去程/返程」的直覺）。
// 這支 API 需要登入，避免被當成公開的 TDX 查詢代理濫用。

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

let cachedToken = null;
let tokenExpiry = 0;

async function getTDXToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const clientId = process.env.TDX_CLIENT_ID;
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

const ALLOWED_CITIES = new Set(['Taoyuan', 'NewTaipei', 'Taipei', 'Keelung']);

function sanitizeRouteName(str) {
  // 路線名稱可能包含數字、英文字母、中文與少數符號（例如 "9005A"、"綠1"）
  return /^[一-龥a-zA-Z0-9\s\-]{1,20}$/.test(str);
}

export default async function handler(req, res) {
  if (!setCORS(req, res)) return res.status(403).json({ error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return res.status(503).json({ error: 'Database not configured' });

  const user = await verifySession(req, url, key);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const { city, routeName } = req.query;
  if (!city || !routeName) {
    return res.status(400).json({ error: 'Missing required params: city, routeName' });
  }
  if (!ALLOWED_CITIES.has(city)) {
    return res.status(400).json({ error: 'Invalid city parameter' });
  }
  if (!sanitizeRouteName(routeName)) {
    return res.status(400).json({ error: 'Invalid routeName format' });
  }

  try {
    const token = await getTDXToken();
    const escapedName = routeName.replace(/'/g, "''");
    const tdxUrl = `https://tdx.transportdata.tw/api/basic/v2/Bus/StopOfRoute/City/${city}` +
      `?$filter=RouteName/Zh_tw eq '${encodeURIComponent(escapedName)}'` +
      `&$select=RouteName,Direction,Stops&$format=JSON`;

    const dataRes = await fetch(tdxUrl, {
      headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' }
    });
    if (!dataRes.ok) {
      console.error('[tdx-route-directions] Data fetch error:', dataRes.status);
      return res.status(502).json({ error: 'TDX data fetch failed' });
    }

    const data = await dataRes.json();
    if (!Array.isArray(data) || !data.length) {
      return res.status(200).json({ data: [] });
    }

    // 同一個 Direction 可能因為子路線（分支）出現多筆，取停靠站數最多的那一筆代表該方向
    const byDirection = {};
    for (const entry of data) {
      const dir = entry.Direction;
      if (dir === undefined || dir === null) continue;
      const stops = (entry.Stops || [])
        .slice()
        .sort((a, b) => (a.StopSequence || 0) - (b.StopSequence || 0))
        .map(s => ({ name: s.StopName?.Zh_tw || '', en: s.StopName?.En || '' }));
      if (!byDirection[dir] || stops.length > byDirection[dir].stops.length) {
        byDirection[dir] = {
          direction: dir,
          routeName: entry.RouteName?.Zh_tw || routeName,
          stops
        };
      }
    }

    const result = Object.values(byDirection).sort((a, b) => a.direction - b.direction);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ data: result });
  } catch (err) {
    console.error('[tdx-route-directions] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
