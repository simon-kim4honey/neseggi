import { Hono } from 'hono'

type Bindings = {
  NESEGGI_DB: D1Database
  NESEGGI_KV: KVNamespace
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

// TODO(neseggi): 회원 목록/상세, 결제내역, 생성내역(썸네일), 크레딧 이벤트 로그, 실패 케이스 조회
admin.get('/users', async (c) => {
  return c.json({ error: 'not_implemented' }, 501)
})

// ────────────────────────────────────────────────────
// GET /api/admin/users/:userId/pets — 해당 사용자의 반려동물 목록(사진 풀
// 장수 포함). "오늘의 추억사진" 기능의 재료가 되는 사진 풀은 일반 사용자
// API로는 목록만 보이고(개수 확인용), 실제 이미지 열람은 관리자 전용이다.
// ────────────────────────────────────────────────────
admin.get('/users/:userId/pets', async (c) => {
  const db = c.env.NESEGGI_DB
  const userId = c.req.param('userId')
  const { results } = await db
    .prepare(
      `SELECT p.id, p.name, p.species, p.personality, p.avatar_url, p.created_at,
              (SELECT COUNT(*) FROM pet_photos pp WHERE pp.pet_id = p.id) AS photo_count
       FROM pets p WHERE p.user_id = ? ORDER BY p.created_at DESC`
    )
    .bind(userId)
    .all()
  return c.json({ pets: results ?? [] })
})

// ────────────────────────────────────────────────────
// GET /api/admin/pets/:petId/photos — 반려동물 사진 풀 목록(관리자 전용)
// ────────────────────────────────────────────────────
admin.get('/pets/:petId/photos', async (c) => {
  const db = c.env.NESEGGI_DB
  const petId = c.req.param('petId')
  const { results } = await db
    .prepare('SELECT id, kv_key, created_at FROM pet_photos WHERE pet_id = ? ORDER BY created_at ASC')
    .bind(petId)
    .all()
  return c.json({ photos: results ?? [] })
})

// ────────────────────────────────────────────────────
// GET /api/admin/pets/:petId/photos/:photoId/image — 사진 풀의 원본 이미지를
// 실제로 보여준다(KV에 data URL로 저장돼 있어 그대로 디코딩해서 스트리밍).
// ────────────────────────────────────────────────────
admin.get('/pets/:petId/photos/:photoId/image', async (c) => {
  const db = c.env.NESEGGI_DB
  const petId = c.req.param('petId')
  const photoId = c.req.param('photoId')

  const row: any = await db
    .prepare('SELECT kv_key FROM pet_photos WHERE id = ? AND pet_id = ?')
    .bind(photoId, petId)
    .first()
  if (!row) return c.text('not_found', 404)

  const dataUrl = await c.env.NESEGGI_KV.get(row.kv_key)
  if (!dataUrl) return c.text('not_found', 404)

  const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl)
  if (!match) return c.text('invalid_image', 500)
  const [, mediaType, base64] = match
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))

  return new Response(bytes, {
    headers: { 'Content-Type': mediaType, 'Cache-Control': 'private, max-age=3600' },
  })
})

export { admin }
