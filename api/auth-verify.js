// api/auth-verify.js
// 驗證 Session Token
// GET /api/auth-verify
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return true;
}

export default async function handler(req, res) {
  if (!setCORS(req, res)) return res.status(403).json({ error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    // 查詢 Session
    const sessionRes = await fetch(
      `${supabaseUrl}/rest/v1/sessions?token=eq.${encodeURIComponent(token)}&select=id,account_id,expires_at,accounts(username,role,active)`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!sessionRes.ok) {
      return res.status(500).json({ error: 'Database error' });
    }

    const sessions = await sessionRes.json();

    if (!sessions || sessions.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const session = sessions[0];

    // 檢查是否過期
    if (new Date(session.expires_at) < new Date()) {
      // 清除過期 session
      await fetch(
        `${supabaseUrl}/rest/v1/sessions?id=eq.${session.id}`,
        {
          method: 'DELETE',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          }
        }
      );
      return res.status(401).json({ error: 'Token expired' });
    }

    // 檢查帳號是否仍為啟用狀態
    const account = session.accounts;
    if (!account || !account.active) {
      return res.status(401).json({ error: 'Account disabled' });
    }

    return res.status(200).json({
      valid: true,
      user: { username: account.username, role: account.role },
      expiresAt: session.expires_at
    });

  } catch (err) {
    console.error('[auth-verify] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
