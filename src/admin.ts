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

// ────────────────────────────────────────────────────
// GET /api/admin/generations — 사진 합성 job 목록. AtlasCloud에 실제로
// 전달된 프롬프트 전문(prompt 컬럼, 2026-09-10 추가)을 포함한다 — 프롬프트
// 문구가 리팩터링 중 조용히 깨지는 사고(CLAUDE.md 경고 참고)를 코드 리뷰가
// 아니라 실제 런타임 값으로 확인할 수 있게 하는 용도.
// query: limit(기본 50, 최대 200), petId?, userId?
// ────────────────────────────────────────────────────
admin.get('/generations', async (c) => {
  const db = c.env.NESEGGI_DB
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 200)
  const petId = c.req.query('petId')
  const userId = c.req.query('userId')

  const conditions: string[] = []
  const params: any[] = []
  if (petId) {
    conditions.push('g.pet_id = ?')
    params.push(petId)
  }
  if (userId) {
    conditions.push('g.user_id = ?')
    params.push(userId)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const { results } = await db
    .prepare(
      `SELECT g.id, g.status, g.source, g.concept, g.prompt, g.error_message, g.atlas_job_id,
              g.created_at, g.completed_at, g.pet_id, g.user_id,
              p.name AS pet_name, u.email AS user_email
       FROM generation_logs g
       LEFT JOIN pets p ON p.id = g.pet_id
       LEFT JOIN users u ON u.id = g.user_id
       ${where}
       ORDER BY g.created_at DESC
       LIMIT ?`
    )
    .bind(...params, limit)
    .all()

  return c.json({ generations: results ?? [] })
})

// ────────────────────────────────────────────────────
// GET /api/admin/generations/:jobId/image — 합성 결과 이미지를 관리자
// 페이지에서 볼 수 있도록 스트리밍한다(chat.ts의 avatar-proxy와 같은 이유 —
// AtlasCloud OSS 호스트를 <img src>가 직접 가리키면 일부 환경에서 깨진다).
// ────────────────────────────────────────────────────
admin.get('/generations/:jobId/image', async (c) => {
  const db = c.env.NESEGGI_DB
  const jobId = c.req.param('jobId')
  const job: any = await db.prepare('SELECT result_url FROM generation_logs WHERE id = ?').bind(jobId).first()
  if (!job?.result_url) return c.text('not_found', 404)

  const upstream = await fetch(job.result_url)
  if (!upstream.ok || !upstream.body) return c.text('upstream_error', 502)

  return new Response(upstream.body, {
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': 'private, max-age=3600',
    },
  })
})

export { admin }
