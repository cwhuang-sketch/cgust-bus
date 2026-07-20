// api/auth-logout.js
// 登出：刪除 Session Token
// POST /api/auth-logout
// Header: Authorization: Bearer <token>

function setCORS(req, res) {
  const allowed = [
    process.env.ALLOWED_ORIGIN,
    'https://cgustbus.vercel.app',
  ].filter(Boolean);
  const origin = req.headers.origin || '';
  const ok = !origin || allowed.some(o => o === origin);
  if (!ok) return false;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return true;
}

export default async function handler(req, res) {
  if (!setCORS(req, res)) return res.status(403).json({ error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(200).json({ success: true }); // 已登出

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    await fetch(
      `${supabaseUrl}/rest/v1/sessions?token=eq.${encodeURIComponent(token)}`,
      {
        method: 'DELETE',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      }
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[auth-logout] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
