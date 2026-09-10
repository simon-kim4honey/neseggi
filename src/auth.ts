import { Hono } from 'hono'

type Bindings = {
  NESEGGI_DB: D1Database
  NESEGGI_KV: KVNamespace
  KAKAO_CLIENT_ID: string
  KAKAO_CLIENT_SECRET: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

const auth = new Hono<{ Bindings: Bindings }>()

const SESSION_TTL_DAYS = 30
const SIGNUP_BONUS_CREDITS = 5
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Workers 런타임엔 bcrypt 네이티브 모듈이 없어서 crypto.subtle로 SHA-256(salt+password) 해시 사용
async function hashPassword(password: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(salt + password)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const hashHex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${salt}:${hashHex}`
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt] = stored.split(':')
  const recomputed = await hashPassword(password, salt)
  return recomputed === stored
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}

function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function createSession(db: D1Database, userId: string): Promise<{ token: string; expiresAt: string }> {
  const token = newSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
  await db
    .prepare('INSERT INTO user_sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expiresAt)
    .run()
  return { token, expiresAt }
}

function publicUser(u: any) {
  return { id: u.id, email: u.email, name: u.name, credits: u.credits, role: u.role, provider: u.provider }
}

auth.post('/signup', async (c) => {
  const body = await c.req.json().catch(() => null)
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : ''

  if (!EMAIL_RE.test(email)) return c.json({ error: '올바른 이메일을 입력해 주세요.', code: 'INVALID_EMAIL' }, 400)
  if (password.length < 8) return c.json({ error: '비밀번호는 8자 이상이어야 합니다.', code: 'WEAK_PASSWORD' }, 400)

  const db = c.env.NESEGGI_DB
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (existing) return c.json({ error: '이미 가입된 이메일입니다.', code: 'EMAIL_TAKEN' }, 409)

  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const passwordHash = await hashPassword(password, salt)
  const userId = newId('u')

  await db
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, provider, credits, role, status)
       VALUES (?, ?, ?, ?, 'email', ?, 'user', 'active')`
    )
    .bind(userId, email, name, passwordHash, SIGNUP_BONUS_CREDITS)
    .run()

  await db
    .prepare(
      `INSERT INTO credit_logs (user_id, type, amount, balance, reason, ref_id)
       VALUES (?, 'signup', ?, ?, 'signup_bonus', ?)`
    )
    .bind(userId, SIGNUP_BONUS_CREDITS, SIGNUP_BONUS_CREDITS, userId)
    .run()

  const { token, expiresAt } = await createSession(db, userId)
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()
  return c.json({ token, expiresAt, user: publicUser(user) }, 201)
})

auth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null)
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  const db = c.env.NESEGGI_DB
  const user: any = await db
    .prepare(`SELECT * FROM users WHERE email = ? AND provider = 'email'`)
    .bind(email)
    .first()

  if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.', code: 'INVALID_CREDENTIALS' }, 401)
  }
  if (user.status !== 'active') {
    return c.json({ error: '이용이 제한된 계정입니다.', code: 'ACCOUNT_SUSPENDED' }, 403)
  }

  await db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).bind(user.id).run()

  const { token, expiresAt } = await createSession(db, user.id)
  return c.json({ token, expiresAt, user: publicUser(user) })
})

auth.get('/me', async (c) => {
  const token = c.req.header('X-Session-Token')
  const user = await getSessionUser(c.env.NESEGGI_DB, token)
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  return c.json({ user: publicUser(user) })
})

// ── origin 헬퍼: Host 헤더 기반으로 추출 (Cloudflare Workers 호환)
function getOrigin(c: any): string {
  const host = c.req.header('host') || c.req.header('x-forwarded-host') || ''
  const proto = host.startsWith('localhost') ? 'http' : 'https'
  return `${proto}://${host}`
}

// lookbook-ai(EZlook)와 동일한 카카오/구글 OAuth 앱을 재사용한다 — 로그인 입구를
// 통일하기 위해 client id/secret은 EZlook과 같은 값을 쓰고, 카카오/구글 콘솔의
// 허용 Redirect URI 목록에 이 서비스의 콜백 주소만 추가로 등록한다.
// 엔드포인트 경로(/api/auth/kakao(/callback), /api/auth/google(/callback))도
// lookbook-ai와 동일하게 맞춰서 두 서비스의 프런트엔드 로그인 연동 코드를 그대로
// 재사용할 수 있게 한다.

function oauthPopupSuccessHtml(provider: 'kakao' | 'google', token: string, user: any, isNewUser: boolean) {
  const payload = JSON.stringify({ type: 'oauth_success', provider, token, user, isNewUser })
  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"><title>로그인 성공</title></head>
<body>
<p style="font-family:sans-serif;text-align:center;padding:40px;color:#333;">✅ 로그인 성공! 잠시 후 창이 닫힙니다...</p>
<script>
(function() {
  var payload = ${payload};
  function tryClose() { try { window.close(); } catch(e) {} }
  function sendMsg() {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, '*');
        setTimeout(tryClose, 800);
      } else {
        try { localStorage.setItem('oauth_result', JSON.stringify(payload)); } catch(e) {}
        setTimeout(tryClose, 500);
      }
    } catch(e) {
      setTimeout(tryClose, 500);
    }
  }
  if (document.readyState === 'complete') { sendMsg(); }
  else { window.addEventListener('load', sendMsg); }
})();
</script>
</body></html>`
}

function oauthRedirectSuccessHtml(provider: 'kakao' | 'google', token: string, user: any, isNewUser: boolean) {
  const payload = JSON.stringify({ type: 'oauth_success', provider, token, user, isNewUser })
  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"><title>로그인 성공</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body>
<p style="font-family:sans-serif;text-align:center;padding:40px;color:#333;">✅ 로그인 성공! 잠시 이동합니다...</p>
<script>
(function(){
  var payload = ${payload};
  try { localStorage.setItem('oauth_result', JSON.stringify(payload)); } catch(e) {}
  var pending = {};
  try { pending = JSON.parse(localStorage.getItem('oauth_redirect_pending') || '{}'); } catch(e) {}
  var dest = (pending.returnPath && pending.returnPath !== '/') ? pending.returnPath : '/';
  window.location.replace(dest);
})();
</script>
</body></html>`
}

function oauthErrorResponse(c: any, provider: 'kakao' | 'google', mode: string, msg: string) {
  if (mode === 'redirect') return c.redirect(`/?oauth_error=${encodeURIComponent(msg)}`)
  return c.html(
    `<script>window.opener?.postMessage({type:'oauth_error',provider:'${provider}',error:'${msg}'},'*');window.close();</script>`
  )
}

// ────────────────────────────────────────────────────
// GET /api/auth/kakao — 카카오 OAuth 시작
// ────────────────────────────────────────────────────
auth.get('/kakao', (c) => {
  const origin = getOrigin(c)
  const mode = c.req.query('mode') || 'popup' // popup | redirect
  const redirectUri = `${origin}/api/auth/kakao/callback`
  const clientId = c.env.KAKAO_CLIENT_ID || ''
  if (!clientId) {
    if (mode === 'redirect') return c.redirect(`/?oauth_error=kakao_no_key`)
    return c.html(`<script>window.opener?.postMessage({type:'oauth_error',provider:'kakao',error:'카카오 앱 키가 설정되지 않았습니다.'},'*');window.close();</script>`)
  }
  const url = `https://kauth.kakao.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${mode}`
  return c.redirect(url)
})

// ────────────────────────────────────────────────────
// GET /api/auth/kakao/callback — 카카오 OAuth 콜백
// ────────────────────────────────────────────────────
auth.get('/kakao/callback', async (c) => {
  const db = c.env.NESEGGI_DB
  const origin = getOrigin(c)
  const code = c.req.query('code')
  const error = c.req.query('error')
  const mode = c.req.query('state') || 'popup'

  if (error || !code) return oauthErrorResponse(c, 'kakao', mode, error || 'cancelled')

  try {
    const redirectUri = `${origin}/api/auth/kakao/callback`
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: c.env.KAKAO_CLIENT_ID || '',
        client_secret: c.env.KAKAO_CLIENT_SECRET || '',
        redirect_uri: redirectUri,
      }),
    })
    const tokenData: any = await tokenRes.json()
    if (!tokenData.access_token) throw new Error('카카오 토큰 발급 실패')

    const profileRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    const profile: any = await profileRes.json()
    const providerId = String(profile.id)
    const kakaoEmail = profile.kakao_account?.email || `kakao_${providerId}@kakao.local`
    const kakaoName = profile.kakao_account?.profile?.nickname || '카카오 사용자'
    const kakaoAvatar = profile.kakao_account?.profile?.profile_image_url || null

    let isNewUser = false
    let user: any = await db.prepare(`SELECT * FROM users WHERE provider = 'kakao' AND provider_id = ?`).bind(providerId).first()
    if (!user) {
      user = await db.prepare(`SELECT * FROM users WHERE email = ?`).bind(kakaoEmail).first()
      if (user) {
        await db.prepare(`UPDATE users SET provider_id = ?, avatar_url = ? WHERE id = ?`).bind(providerId, kakaoAvatar, user.id).run()
      } else {
        const id = newId('u')
        await db
          .prepare(
            `INSERT INTO users (id, email, name, provider, provider_id, avatar_url, status, credits, role)
             VALUES (?, ?, ?, 'kakao', ?, ?, 'active', ?, 'user')`
          )
          .bind(id, kakaoEmail, kakaoName, providerId, kakaoAvatar, SIGNUP_BONUS_CREDITS)
          .run()
        await db
          .prepare(
            `INSERT INTO credit_logs (user_id, type, amount, balance, reason, ref_id)
             VALUES (?, 'signup', ?, ?, 'signup_bonus', ?)`
          )
          .bind(id, SIGNUP_BONUS_CREDITS, SIGNUP_BONUS_CREDITS, id)
          .run()
        user = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first()
        isNewUser = true
      }
    }
    if (!user || user.status !== 'active') throw new Error('계정이 정지 상태입니다.')

    await db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).bind(user.id).run()
    const { token } = await createSession(db, user.id)
    const publicUserData = publicUser(user)

    return c.html(
      mode === 'redirect'
        ? oauthRedirectSuccessHtml('kakao', token, publicUserData, isNewUser)
        : oauthPopupSuccessHtml('kakao', token, publicUserData, isNewUser)
    )
  } catch (err: any) {
    console.error('kakao callback error:', err)
    return oauthErrorResponse(c, 'kakao', mode, err.message || '로그인 오류')
  }
})

// ────────────────────────────────────────────────────
// GET /api/auth/google — 구글 OAuth 시작
// ────────────────────────────────────────────────────
auth.get('/google', (c) => {
  const origin = getOrigin(c)
  const mode = c.req.query('mode') || 'popup'
  const redirectUri = `${origin}/api/auth/google/callback`
  const clientId = c.env.GOOGLE_CLIENT_ID || ''
  if (!clientId) {
    if (mode === 'redirect') return c.redirect(`/?oauth_error=google_no_key`)
    return c.html(`<script>window.opener?.postMessage({type:'oauth_error',provider:'google',error:'구글 클라이언트 ID가 설정되지 않았습니다.'},'*');window.close();</script>`)
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
    state: mode,
  })
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

// ────────────────────────────────────────────────────
// GET /api/auth/google/callback — 구글 OAuth 콜백
// ────────────────────────────────────────────────────
auth.get('/google/callback', async (c) => {
  const db = c.env.NESEGGI_DB
  const origin = getOrigin(c)
  const code = c.req.query('code')
  const error = c.req.query('error')
  const mode = c.req.query('state') || 'popup'

  if (error || !code) return oauthErrorResponse(c, 'google', mode, error || 'cancelled')

  try {
    const redirectUri = `${origin}/api/auth/google/callback`
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: c.env.GOOGLE_CLIENT_ID || '',
        client_secret: c.env.GOOGLE_CLIENT_SECRET || '',
        redirect_uri: redirectUri,
      }),
    })
    const tokenData: any = await tokenRes.json()
    if (!tokenData.access_token) throw new Error('구글 토큰 발급 실패')

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    const profile: any = await profileRes.json()
    const providerId = profile.id
    const googleEmail = profile.email
    const googleName = profile.name || '구글 사용자'
    const googleAvatar = profile.picture || null

    let isNewUser = false
    let user: any = await db.prepare(`SELECT * FROM users WHERE provider = 'google' AND provider_id = ?`).bind(providerId).first()
    if (!user) {
      user = await db.prepare(`SELECT * FROM users WHERE email = ?`).bind(googleEmail).first()
      if (user) {
        await db.prepare(`UPDATE users SET provider_id = ?, avatar_url = ? WHERE id = ?`).bind(providerId, googleAvatar, user.id).run()
      } else {
        const id = newId('u')
        await db
          .prepare(
            `INSERT INTO users (id, email, name, provider, provider_id, avatar_url, status, credits, role)
             VALUES (?, ?, ?, 'google', ?, ?, 'active', ?, 'user')`
          )
          .bind(id, googleEmail, googleName, providerId, googleAvatar, SIGNUP_BONUS_CREDITS)
          .run()
        await db
          .prepare(
            `INSERT INTO credit_logs (user_id, type, amount, balance, reason, ref_id)
             VALUES (?, 'signup', ?, ?, 'signup_bonus', ?)`
          )
          .bind(id, SIGNUP_BONUS_CREDITS, SIGNUP_BONUS_CREDITS, id)
          .run()
        user = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first()
        isNewUser = true
      }
    }
    if (!user || user.status !== 'active') throw new Error('계정이 정지 상태입니다.')

    await db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).bind(user.id).run()
    const { token } = await createSession(db, user.id)
    const publicUserData = publicUser(user)

    return c.html(
      mode === 'redirect'
        ? oauthRedirectSuccessHtml('google', token, publicUserData, isNewUser)
        : oauthPopupSuccessHtml('google', token, publicUserData, isNewUser)
    )
  } catch (err: any) {
    console.error('google callback error:', err)
    return oauthErrorResponse(c, 'google', mode, err.message || '로그인 오류')
  }
})

auth.post('/logout', async (c) => {
  const token = c.req.header('X-Session-Token')
  if (token) {
    await c.env.NESEGGI_DB.prepare('DELETE FROM user_sessions WHERE token = ?').bind(token).run()
  }
  return c.json({ ok: true })
})

// 세션 토큰 검증 — 다른 라우터에서 재사용할 미들웨어용 헬퍼
export async function getSessionUser(db: D1Database, token: string | undefined) {
  if (!token) return null
  const row = await db
    .prepare(
      `SELECT u.* FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    )
    .bind(token)
    .first()
  return row ?? null
}

export { auth, hashPassword, verifyPassword, newId, newSessionToken, SESSION_TTL_DAYS }
