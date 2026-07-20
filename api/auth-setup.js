// api/auth-setup.js
// 一次性初始化：設定預設管理員密碼
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

  // 需要提供 setup secret（設定在 Vercel 環境變數）
  const { secret } = req.query;
  const setupSecret = process.env.SETUP_SECRET;
  if (!setupSecret || secret !== setupSecret) {
    return res.status(403).json({ error: 'Invalid setup secret' });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const defaultPassword = process.env.ADMIN_DEFAULT_PASSWORD || 'cgust2026';
    const passwordHash = await hashPassword(defaultPassword);

    // 更新 admin 帳號密碼
    const r = await fetch(
      `${supabaseUrl}/rest/v1/accounts?username=eq.admin`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password_hash: passwordHash })
      }
    );

    if (!r.ok) {
      return res.status(500).json({ error: 'Failed to update password' });
    }

    return res.status(200).json({
      success: true,
      message: '管理員密碼已初始化。請到 Vercel 環境變數設定 SETUP_DONE=true 停用此端點。'
    });

  } catch (err) {
    console.error('[auth-setup] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
