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

// ────────────────────────────────────────────────────
// GET /api/admin/claude-usage — 사용자별 Claude API 사용량 + 추정 비용(USD).
// chat.ts의 모든 anthropic.messages.create() 호출마다 claude_usage_logs에
// 남겨둔 토큰 사용량을 사용자별로 합산한다. 비용은 토큰 단가로 계산한
// 추정치 — 캐시 쓰기/읽기는 Anthropic 표준 비율(입력 단가의 1.25배/0.1배)로
// 환산하므로 실제 청구서와 소폭 오차가 있을 수 있다.
// query: from?, to? (YYYY-MM-DD, created_at 기준 필터, to는 그 날짜까지 포함)
// ────────────────────────────────────────────────────
const MODEL_PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}
const DEFAULT_PRICING = MODEL_PRICING_PER_MTOK['claude-opus-5'] // 모르는 모델이면 가장 비싼 단가로 보수적으로 추정

function estimateCostUsd(row: {
  model: string
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}): number {
  const pricing = MODEL_PRICING_PER_MTOK[row.model] ?? DEFAULT_PRICING
  const inputCost = (row.input_tokens / 1_000_000) * pricing.input
  const outputCost = (row.output_tokens / 1_000_000) * pricing.output
  const cacheWriteCost = (row.cache_creation_input_tokens / 1_000_000) * pricing.input * 1.25
  const cacheReadCost = (row.cache_read_input_tokens / 1_000_000) * pricing.input * 0.1
  return inputCost + outputCost + cacheWriteCost + cacheReadCost
}

admin.get('/claude-usage', async (c) => {
  const db = c.env.NESEGGI_DB
  const from = c.req.query('from')
  const to = c.req.query('to')

  const conditions: string[] = []
  const params: any[] = []
  if (from) {
    conditions.push('l.created_at >= ?')
    params.push(from)
  }
  if (to) {
    conditions.push(`l.created_at < date(?, '+1 day')`)
    params.push(to)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const { results } = await db
    .prepare(
      `SELECT l.user_id, u.email AS user_email, u.name AS user_name, l.model, l.purpose,
              SUM(l.input_tokens) AS input_tokens,
              SUM(l.output_tokens) AS output_tokens,
              SUM(l.cache_creation_input_tokens) AS cache_creation_input_tokens,
              SUM(l.cache_read_input_tokens) AS cache_read_input_tokens,
              COUNT(*) AS call_count
       FROM claude_usage_logs l
       LEFT JOIN users u ON u.id = l.user_id
       ${where}
       GROUP BY l.user_id, l.model, l.purpose
       ORDER BY l.user_id`
    )
    .bind(...params)
    .all()

  const byUser = new Map<string, any>()
  for (const row of (results ?? []) as any[]) {
    const cost = estimateCostUsd(row)
    if (!byUser.has(row.user_id)) {
      byUser.set(row.user_id, {
        userId: row.user_id,
        userEmail: row.user_email,
        userName: row.user_name,
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        estimatedCostUsd: 0,
        byPurpose: [] as any[],
      })
    }
    const entry = byUser.get(row.user_id)
    entry.callCount += row.call_count
    entry.inputTokens += row.input_tokens
    entry.outputTokens += row.output_tokens
    entry.cacheCreationInputTokens += row.cache_creation_input_tokens
    entry.cacheReadInputTokens += row.cache_read_input_tokens
    entry.estimatedCostUsd += cost
    entry.byPurpose.push({
      model: row.model,
      purpose: row.purpose,
      callCount: row.call_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationInputTokens: row.cache_creation_input_tokens,
      cacheReadInputTokens: row.cache_read_input_tokens,
      estimatedCostUsd: cost,
    })
  }

  const users = Array.from(byUser.values()).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)
  const totalCostUsd = users.reduce((sum, u) => sum + u.estimatedCostUsd, 0)

  return c.json({ users, totalCostUsd })
})

export { admin }
