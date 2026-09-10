import { Hono } from 'hono'

type Bindings = {
  NESEGGI_DB: D1Database
  NESEGGI_KV: KVNamespace
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

// TODO(neseggi): 카카오/구글 OAuth 콜백 — 각 provider 개발자센터에서 앱 등록 후 client id/secret 확정되면 구현
auth.get('/oauth/:provider/callback', async (c) => {
  return c.json({ error: 'not_implemented' }, 501)
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
