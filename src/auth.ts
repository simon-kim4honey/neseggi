import { Hono } from 'hono'

type Bindings = {
  NESEGGI_DB: D1Database
  NESEGGI_KV: KVNamespace
}

const auth = new Hono<{ Bindings: Bindings }>()

const SESSION_TTL_DAYS = 30

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

// TODO(neseggi): 회원가입 — 이메일/비밀번호, 가입 보너스 크레딧 지급까지 확정 후 구현
auth.post('/signup', async (c) => {
  return c.json({ error: 'not_implemented' }, 501)
})

// TODO(neseggi): 로그인 — 세션 생성(user_sessions), X-Session-Token 발급
auth.post('/login', async (c) => {
  return c.json({ error: 'not_implemented' }, 501)
})

// TODO(neseggi): 카카오/구글 OAuth 콜백
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
