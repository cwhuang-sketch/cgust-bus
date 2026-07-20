// api/auth-setup.js
// 一次性初始化：建立/重設管理員帳號
// 使用後請在 Vercel 環境變數設定 SETUP_DONE=true 停用此端點
// GET /api/auth-setup?secret=YOUR_SETUP_SECRET

import crypto from 'crypto';

async function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const iterations = 100000;
  const derived = crypto.pbkdf2Sync(
    password, salt, iterations, 64, 'sha512'
  ).toString('hex');
  return `pbkdf2$${iterations}$${salt}$${derived}`;
}

export default async function handler(req, res) {
  // 已完成設定則停用
  if (process.env.SETUP_DONE === 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 驗證 setup secret
  const { secret } = req.query;
  const setupSecret = process.env.SETUP_SECRET;
  if (!setupSecret || secret !== setupSecret) {
    return res.status(403).json({ error: 'Invalid setup secret' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const defaultPassword = process.env.ADMIN_DEFAULT_PASSWORD || 'cgust2026';
    const passwordHash = await hashPassword(defaultPassword);

    // 先刪除已存在的 admin 帳號（避免衝突）
    await fetch(`${supabaseUrl}/rest/v1/accounts?username=eq.admin`, {
      method: 'DELETE',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      }
    });

    // 重新建立 admin 帳號（使用 PBKDF2 格式）
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/accounts`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        username: 'admin',
        password_hash: passwordHash,
        role: 'admin',
        active: true
      })
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('[auth-setup] Insert failed:', insertRes.status, errText);
      return res.status(500).json({ error: 'Failed to create admin account', detail: errText });
    }

    const [newAccount] = await insertRes.json();

    return res.status(200).json({
      success: true,
      message: `管理員帳號已初始化完成。帳號: admin，密碼: ${defaultPassword}`,
      accountId: newAccount.id,
      reminder: '請立即到 Vercel 環境變數設定 SETUP_DONE=true 停用此端點，並登入後立即變更密碼！'
    });

  } catch (err) {
    console.error('[auth-setup] Error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
