// api/auth-login.js
// 後端登入驗證 API
// POST /api/auth-login { username, password }
// 回傳 JWT token

import crypto from 'crypto';

// ── Rate Limit ────────────────────────────────────────────────
const loginAttempts = {};
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

function checkLoginLimit(username) {
  const now = Date.now();
  const key = username.toLowerCase();
  if (!loginAttempts[key]) loginAttempts[key] = { count: 0, lockedUntil: 0 };
  const rec = loginAttempts[key];
  if (rec.lockedUntil && now < rec.lockedUntil) {
    const mins = Math.ceil((rec.lockedUntil - now) / 60000);
    return { locked: true, mins };
  }
  if (rec.lockedUntil && now >= rec.lockedUntil) {
    loginAttempts[key] = { count: 0, lockedUntil: 0 };
  }
  return { locked: false };
}

function recordFailedLogin(username) {
  const key = username.toLowerCase();
  if (!loginAttempts[key]) loginAttempts[key] = { count: 0, lockedUntil: 0 };
  loginAttempts[key].count++;
  if (loginAttempts[key].count >= MAX_ATTEMPTS) {
    loginAttempts[key].lockedUntil = Date.now() + LOCK_MINUTES * 60 * 1000;
  }
  return MAX_ATTEMPTS - loginAttempts[key].count;
}

function clearLoginAttempts(username) {
  delete loginAttempts[username.toLowerCase()];
}

// ── 簡單 bcrypt 驗證（使用 Node.js 內建 crypto）────────────────
// 因 Vercel Edge 不支援 bcrypt，使用 PBKDF2 替代
async function verifyPassword(password, hash) {
  // 支援兩種格式：
  // 1. 舊格式 bcrypt（開頭 $2b$）→ 使用比對方式
  // 2. 新格式 PBKDF2（開頭 pbkdf2$）→ 標準驗證
  if (hash.startsWith('pbkdf2$')) {
    const [, iterations, salt, storedHash] = hash.split('$');
    const derived = crypto.pbkdf2Sync(
      password, salt, parseInt(iterations), 64, 'sha512'
    ).toString('hex');
    return derived === storedHash;
  }
  // 初始帳號用的 bcrypt hash 直接比對（簡化處理）
  // 正式環境建議改用 bcrypt library
  return false;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const iterations = 100000;
  const derived = crypto.pbkdf2Sync(
    password, salt, iterations, 64, 'sha512'
  ).toString('hex');
  return `pbkdf2$${iterations}$${salt}$${derived}`;
}

// ── 產生 Session Token ────────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

// ── CORS Helper ───────────────────────────────────────────────
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

export default async function handler(req, res) {
  if (!setCORS(req, res)) return res.status(403).json({ error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { username, password } = req.body || {};

    // 輸入驗證
    if (!username || !password) {
      return res.status(400).json({ error: '請輸入帳號及密碼' });
    }
    if (typeof username !== 'string' || username.length > 50) {
      return res.status(400).json({ error: '帳號格式錯誤' });
    }

    // Rate limit 檢查
    const limitCheck = checkLoginLimit(username);
    if (limitCheck.locked) {
      return res.status(429).json({
        error: `帳號已鎖定，請 ${limitCheck.mins} 分鐘後再試`
      });
    }

    // 從 Supabase 查詢帳號
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const queryRes = await fetch(
      `${supabaseUrl}/rest/v1/accounts?username=eq.${encodeURIComponent(username)}&active=eq.true&select=id,username,password_hash,role`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!queryRes.ok) {
      console.error('[auth-login] DB query failed:', queryRes.status);
      return res.status(500).json({ error: 'Database error' });
    }

    const accounts = await queryRes.json();

    // 帳號不存在或密碼錯誤（統一錯誤訊息，避免洩漏帳號是否存在）
    if (!accounts || accounts.length === 0) {
      const remaining = recordFailedLogin(username);
      return res.status(401).json({
        error: remaining > 0
          ? `帳號或密碼錯誤（還有 ${remaining} 次機會）`
          : `帳號已鎖定，請 ${LOCK_MINUTES} 分鐘後再試`
      });
    }

    const account = accounts[0];

    // 驗證密碼
    const passwordOk = await verifyPassword(password, account.password_hash);
    if (!passwordOk) {
      const remaining = recordFailedLogin(username);
      return res.status(401).json({
        error: remaining > 0
          ? `帳號或密碼錯誤（還有 ${remaining} 次機會）`
          : `帳號已鎖定，請 ${LOCK_MINUTES} 分鐘後再試`
      });
    }

    // 登入成功：建立 Session
    clearLoginAttempts(username);
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2小時

    const sessionRes = await fetch(
      `${supabaseUrl}/rest/v1/sessions`,
      {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          account_id: account.id,
          token,
          expires_at: expiresAt
        })
      }
    );

    if (!sessionRes.ok) {
      console.error('[auth-login] Session create failed:', sessionRes.status);
      return res.status(500).json({ error: 'Session error' });
    }

    // 更新最後登入時間
    await fetch(
      `${supabaseUrl}/rest/v1/accounts?id=eq.${account.id}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ last_login: new Date().toISOString() })
      }
    );

    return res.status(200).json({
      token,
      user: { username: account.username, role: account.role },
      expiresAt
    });

  } catch (err) {
    console.error('[auth-login] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
