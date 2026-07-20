// api/auth-accounts.js
// 帳號管理 API（僅限管理員）
// GET    /api/auth-accounts           → 列出所有帳號
// POST   /api/auth-accounts           → 新增帳號
// PATCH  /api/auth-accounts?id=xxx    → 修改帳號（停用/啟用/改密碼）
// DELETE /api/auth-accounts?id=xxx    → 刪除帳號

import crypto from 'crypto';

async function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const iterations = 100000;
  const derived = crypto.pbkdf2Sync(
    password, salt, iterations, 64, 'sha512'
  ).toString('hex');
  return `pbkdf2$${iterations}$${salt}$${derived}`;
}

function setCORS(req, res) {
  const allowed = [
    process.env.ALLOWED_ORIGIN,
    'https://cgustbus.vercel.app',
  ].filter(Boolean);
  const origin = req.headers.origin || '';
  const ok = !origin || allowed.some(o => o === origin);
  if (!ok) return false;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return true;
}

// 驗證 Token 並確認為管理員
async function verifyAdmin(req, supabaseUrl, supabaseKey) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;

  const sessionRes = await fetch(
    `${supabaseUrl}/rest/v1/sessions?token=eq.${encodeURIComponent(token)}&select=expires_at,accounts(id,username,role,active)`,
    {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    }
  );
  if (!sessionRes.ok) return null;
  const sessions = await sessionRes.json();
  if (!sessions?.length) return null;
  const session = sessions[0];
  if (new Date(session.expires_at) < new Date()) return null;
  const account = session.accounts;
  if (!account?.active || account.role !== 'admin') return null;
  return account;
}

export default async function handler(req, res) {
  if (!setCORS(req, res)) return res.status(403).json({ error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  // 所有操作都需要管理員權限
  const admin = await verifyAdmin(req, supabaseUrl, supabaseKey);
  if (!admin) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  try {
    // GET：列出所有帳號
    if (req.method === 'GET') {
      const r = await fetch(
        `${supabaseUrl}/rest/v1/accounts?select=id,username,role,active,created_at,last_login&order=created_at.asc`,
        {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          }
        }
      );
      const accounts = await r.json();
      // 不回傳密碼 hash
      return res.status(200).json({ accounts });
    }

    // POST：新增帳號
    if (req.method === 'POST') {
      const { username, password, role } = req.body || {};

      if (!username || !password || !role) {
        return res.status(400).json({ error: '請填寫帳號、密碼及角色' });
      }
      if (!/^[a-zA-Z0-9_]{4,30}$/.test(username)) {
        return res.status(400).json({ error: '帳號只能使用英文、數字、底線，長度 4~30' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: '密碼至少需要 8 個字元' });
      }
      if (!['admin', 'editor'].includes(role)) {
        return res.status(400).json({ error: '角色必須為 admin 或 editor' });
      }

      const passwordHash = await hashPassword(password);
      const r = await fetch(
        `${supabaseUrl}/rest/v1/accounts`,
        {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({ username, password_hash: passwordHash, role, active: true })
        }
      );
      if (r.status === 409) {
        return res.status(409).json({ error: '此帳號名稱已存在' });
      }
      if (!r.ok) {
        return res.status(500).json({ error: 'Failed to create account' });
      }
      const [newAccount] = await r.json();
      return res.status(201).json({
        account: {
          id: newAccount.id,
          username: newAccount.username,
          role: newAccount.role,
          active: newAccount.active,
          created_at: newAccount.created_at
        }
      });
    }

    // PATCH：修改帳號（停用/啟用/改密碼/改角色）
    if (req.method === 'PATCH') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing account id' });

      const { active, password, role } = req.body || {};
      const updates = {};

      if (active !== undefined) updates.active = Boolean(active);
      if (role !== undefined) {
        if (!['admin', 'editor'].includes(role)) {
          return res.status(400).json({ error: '角色必須為 admin 或 editor' });
        }
        updates.role = role;
      }
      if (password !== undefined) {
        if (password.length < 8) {
          return res.status(400).json({ error: '密碼至少需要 8 個字元' });
        }
        updates.password_hash = await hashPassword(password);
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      const r = await fetch(
        `${supabaseUrl}/rest/v1/accounts?id=eq.${id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updates)
        }
      );
      if (!r.ok) return res.status(500).json({ error: 'Update failed' });
      return res.status(200).json({ success: true });
    }

    // DELETE：刪除帳號
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing account id' });

      // 不允許刪除自己
      if (id === admin.id) {
        return res.status(400).json({ error: '不能刪除自己的帳號' });
      }

      // 先刪除相關 sessions
      await fetch(
        `${supabaseUrl}/rest/v1/sessions?account_id=eq.${id}`,
        {
          method: 'DELETE',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          }
        }
      );

      const r = await fetch(
        `${supabaseUrl}/rest/v1/accounts?id=eq.${id}`,
        {
          method: 'DELETE',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          }
        }
      );
      if (!r.ok) return res.status(500).json({ error: 'Delete failed' });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[auth-accounts] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
