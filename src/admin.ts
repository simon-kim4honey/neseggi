import { Hono } from 'hono'

type Bindings = {
  PETLOOK_DB: D1Database
  ADMIN_PASSWORD: string
}

const admin = new Hono<{ Bindings: Bindings }>()

admin.use('/*', async (c, next) => {
  const pw = c.req.header('X-Admin-Password')
  if (!pw || pw !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
})

// TODO(petlook): 회원 목록/상세, 결제내역, 생성내역(썸네일), 크레딧 이벤트 로그, 실패 케이스 조회
admin.get('/users', async (c) => {
  return c.json({ error: 'not_implemented' }, 501)
})

export { admin }
