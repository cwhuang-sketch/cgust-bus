// api/schedule-admin.js
// 後台管理 API：維護班表資料（需登入驗證）
// 支援：stops, school_routes, school_trips, bus_routes, bus_directions

function setCORS(req, res) {
  const allowed = [
    process.env.ALLOWED_ORIGIN,
    'https://cgustbus.vercel.app',
  ].filter(Boolean);
  const origin = req.headers.origin || '';
  const ok = !origin || allowed.some(o => o === origin);
  if (!ok) return false;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return true;
}

async function verifySession(req, url, key) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  const r = await fetch(
    `${url}/rest/v1/sessions?token=eq.${encodeURIComponent(token)}&select=expires_at,accounts(username,role,active)`,
    { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } }
  );
  if (!r.ok) return null;
  const sessions = await r.json();
  if (!sessions?.length) return null;
  const s = sessions[0];
  if (new Date(s.expires_at) < new Date()) return null;
  if (!s.accounts?.active) return null;
  return s.accounts;
}

async function dbGet(url, key, table, query = '') {
  const r = await fetch(`${url}/rest/v1/${table}${query}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
  });
  if (!r.ok) throw new Error(`DB GET ${table} failed: ${r.status}`);
  return r.json();
}

async function dbPost(url, key, table, body) {
  const r = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.message || `DB POST ${table} failed: ${r.status}`);
  return Array.isArray(data) ? data[0] : data;
}

async function dbPut(url, key, table, id, body) {
  const r = await fetch(`${url}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error(`DB PATCH ${table} failed: ${r.status}`);
  return { success: true };
}

async function dbDel(url, key, table, id) {
  const r = await fetch(`${url}/rest/v1/${table}?id=eq.${id}`, {
    method: 'DELETE',
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
  });
  if (!r.ok) throw new Error(`DB DELETE ${table} failed: ${r.status}`);
  return { success: true };
}

export default async function handler(req, res) {
  if (!setCORS(req, res)) return res.status(403).json({ error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return res.status(503).json({ error: 'Database not configured' });

  // 驗證登入
  const user = await verifySession(req, url, key);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const { resource, id } = req.query;
  // resource: stops | school_routes | school_trips | trip_stops | bus_routes | bus_directions | site_settings

  const ALLOWED_RESOURCES = ['stops','school_routes','school_trips','trip_stops','bus_routes','bus_directions','site_settings'];
  if (!resource || !ALLOWED_RESOURCES.includes(resource)) {
    return res.status(400).json({ error: 'Invalid resource. Use: ' + ALLOWED_RESOURCES.join(', ') });
  }

  // 編輯者只能操作班次，不能操作站點設定或公告／備註設定（僅 admin 可編輯）
  if (user.role === 'editor' && ['stops','site_settings'].includes(resource)) {
    return res.status(403).json({ error: '編輯者無權限操作此設定' });
  }

  // site_settings 是單一列設定（id 固定為 1），只支援讀取與更新
  if (resource === 'site_settings' && (req.method === 'POST' || req.method === 'DELETE')) {
    return res.status(405).json({ error: 'site_settings 僅支援 GET / PUT' });
  }

  try {
    // ── GET：讀取資料 ─────────────────────────────────────────
    if (req.method === 'GET') {
      // 各資料表的排序欄位不同（trip_stops / bus_directions 用 seq，沒有 sort_order/created_at），
      // 沒有另外指定條件時，依資料表挑正確的排序欄位，避免對不存在的欄位排序而查詢失敗。
      const DEFAULT_ORDER = {
        trip_stops: 'seq.asc',
        bus_directions: 'direction.asc,seq.asc',
        site_settings: 'id.asc',
      };
      let query = `?order=${DEFAULT_ORDER[resource] || 'sort_order.asc,created_at.asc'}`;
      if (id) query = `?id=eq.${id}`;

      // 特殊查詢：取得特定 route 的所有 trips
      if (resource === 'school_trips' && req.query.route_id) {
        query = `?route_id=eq.${req.query.route_id}&order=sort_order.asc`;
      }
      if (resource === 'trip_stops' && req.query.trip_id) {
        query = `?trip_id=eq.${req.query.trip_id}&order=seq.asc`;
      }
      if (resource === 'bus_directions' && req.query.route_id) {
        query = `?route_id=eq.${req.query.route_id}&order=direction.asc,seq.asc`;
      }
      // site_settings 是單一列設定，固定讀取 id=1（沒有 sort_order/created_at 欄位）
      if (resource === 'site_settings') {
        query = '?id=eq.1';
      }

      const data = await dbGet(url, key, resource, query);
      return res.status(200).json({ data });
    }

    // ── POST：新增資料 ────────────────────────────────────────
    if (req.method === 'POST') {
      const body = req.body;
      if (!body) return res.status(400).json({ error: 'Request body required' });

      // 驗證必填欄位
      const required = {
        stops:          ['id','name_zh','name_en'],
        school_routes:  ['name_zh','name_en'],
        school_trips:   ['route_id','days'],
        trip_stops:     ['trip_id','stop_id','arrive_time','seq'],
        bus_routes:     ['route_no','operator_zh','operator_en','tdx_city','tdx_route_name'],
        bus_directions: ['route_id','direction','desc_zh','desc_en','seq','stop_id','tdx_stop_name'],
      };
      const missing = (required[resource] || []).filter(f => !body[f]);
      if (missing.length) return res.status(400).json({ error: `缺少必填欄位: ${missing.join(', ')}` });

      // 驗證縣市代碼
      if (resource === 'bus_routes') {
        const VALID_CITIES = ['Taoyuan','NewTaipei','Taipei','Keelung'];
        if (!VALID_CITIES.includes(body.tdx_city)) {
          return res.status(400).json({ error: `tdx_city 必須是: ${VALID_CITIES.join(', ')}` });
        }
      }

      // 驗證時間格式
      if (resource === 'trip_stops' && !/^\d{2}:\d{2}$/.test(body.arrive_time)) {
        return res.status(400).json({ error: '時刻格式錯誤，應為 HH:MM' });
      }

      const newRecord = await dbPost(url, key, resource, body);
      return res.status(201).json({ data: newRecord });
    }

    // ── PUT：更新資料 ─────────────────────────────────────────
    if (req.method === 'PUT') {
      const targetId = resource === 'site_settings' ? 1 : id;
      if (!targetId) return res.status(400).json({ error: 'Missing id parameter' });
      const body = req.body;
      if (!body) return res.status(400).json({ error: 'Request body required' });

      // 縣市驗證
      if (resource === 'bus_routes' && body.tdx_city) {
        const VALID_CITIES = ['Taoyuan','NewTaipei','Taipei','Keelung'];
        if (!VALID_CITIES.includes(body.tdx_city)) {
          return res.status(400).json({ error: `tdx_city 必須是: ${VALID_CITIES.join(', ')}` });
        }
      }

      await dbPut(url, key, resource, targetId, body);
      return res.status(200).json({ success: true });
    }

    // ── DELETE：刪除資料 ──────────────────────────────────────
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Missing id parameter' });
      await dbDel(url, key, resource, id);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[schedule-admin] Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
