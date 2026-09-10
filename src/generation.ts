import { Hono } from 'hono'
import { getSessionUser } from './auth'

type Bindings = {
  NESEGGI_DB: D1Database
  NESEGGI_KV: KVNamespace
  ATLAS_API_KEY: string
}

const generation = new Hono<{ Bindings: Bindings }>()

const ATLAS_API_BASE = 'https://api.atlascloud.ai'
const GENERATION_CREDIT_COST = 5
const POLL_INTERVAL_MS = 3000
const POLL_MAX_ATTEMPTS = 40 // waitUntil 백그라운드라 클라이언트 요청 타임아웃과 무관 — 최대 2분

function atlasHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
}

function newJobId(): string {
  return `g_${crypto.randomUUID().replace(/-/g, '')}`
}

function isDataUrl(v: unknown): v is string {
  return typeof v === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(v)
}

// ── 배경/컨셉 프리셋 ──
const CONCEPTS: Record<string, { label: string; promptFragment: string }> = {
  studio: {
    label: '스튜디오',
    promptFragment:
      "Place the subject(s) against a clean, softly lit professional studio background — a seamless neutral light-gray backdrop with gentle, even studio lighting and a subtle soft shadow beneath the subject(s). No props, no text, no other background elements.",
  },
  park: {
    label: '공원',
    promptFragment:
      'Place the subject(s) in a sunny outdoor park scene — green grass, scattered trees, soft natural daylight, a gently blurred park background (shallow depth of field). No text, no signage, no other people or animals in the background.',
  },
  christmas: {
    label: '크리스마스',
    promptFragment:
      'Place the subject(s) in a cozy indoor Christmas scene — a warmly lit room with a decorated Christmas tree, string lights, and soft golden ambient lighting in the background. No text, no visible gift tags or brand names.',
  },
}
const DEFAULT_CONCEPT = 'studio'

// ────────────────────────────────────────────────────
// ⚠️ 이 함수의 프롬프트 문구는 scripts/verify-critical-prompts.mjs의 GUARDS와
// 짝을 이룬다. 여기서 문구를 고치면 GUARDS도 함께 업데이트할 것 — 하나라도
// 빠지면 npm run build가 실패한다(의도적 변경임을 증명하는 절차).
//
// 반려동물/보호자의 실제 생김새를 그대로 유지하라는 지시문이 핵심이다 —
// 이게 조용히 사라지거나 약해지면, 사용자가 보낸 반려동물과 다르게 생긴
// "일반적인 동물"이 나와도 빌드/배포/로그 어디에도 안 남고 사용자 리포트로만
// 발견된다(lookbook-ai에서 실제로 겪은 사고와 동일 패턴).
// ────────────────────────────────────────────────────
function buildPrompt(conceptId: string, hasOwnerImage: boolean): string {
  const concept = CONCEPTS[conceptId] || CONCEPTS[DEFAULT_CONCEPT]

  const subjects = hasOwnerImage
    ? "Image 1 shows a pet, Image 2 shows the pet's owner (a person). Combine BOTH into a single natural photo of the owner together with their pet."
    : 'Image 1 shows a pet. Create a single natural photo of this pet.'

  const petFidelity =
    'ABSOLUTE RULE — NEVER VIOLATE: the pet in the output must be the exact same animal as shown in Image 1 — identical breed, fur color, fur pattern and markings, ear shape, face, and eye color. Do not substitute a different breed, change its coat color or pattern, or generate a generic-looking animal. Every physical detail of the pet must be reproduced exactly as in the source photo — only its pose may adapt naturally to the new scene.'

  const ownerFidelity = hasOwnerImage
    ? "ABSOLUTE RULE — NEVER VIOLATE: the person in the output must be the exact same person as shown in Image 2 — identical face, facial features, hair, and skin tone. Do not alter their identity, age, or appearance. Only their pose and clothing may adapt naturally to the new scene; their face must remain clearly recognizable as the same person."
    : ''

  const sceneInstruction = `SCENE: ${concept.promptFragment}`

  const finalReminder = `FINAL OUTPUT: one single photorealistic image${
    hasOwnerImage ? ' of the owner and their pet together' : ' of the pet'
  }, naturally composited into the described scene. The pet's exact appearance${
    hasOwnerImage ? " and the owner's exact face" : ''
  } must be preserved with zero deviation from the source photo — this is the single most important requirement. No text, no watermark, no logos anywhere in the image.`

  return [subjects, petFidelity, ownerFidelity, sceneInstruction, finalReminder].filter(Boolean).join(' ')
}

async function updateJob(
  db: D1Database,
  jobId: string,
  fields: { status: string; result_url?: string; error_message?: string }
) {
  await db
    .prepare(
      `UPDATE generation_logs
       SET status = ?, result_url = COALESCE(?, result_url), error_message = COALESCE(?, error_message),
           completed_at = CASE WHEN ? IN ('done', 'failed') THEN datetime('now') ELSE completed_at END
       WHERE id = ?`
    )
    .bind(fields.status, fields.result_url ?? null, fields.error_message ?? null, fields.status, jobId)
    .run()
}

async function refundCredits(db: D1Database, userId: string, jobId: string, amount: number) {
  const user: any = await db.prepare('SELECT credits FROM users WHERE id = ?').bind(userId).first()
  if (!user) return
  const balance = user.credits + amount
  await db.prepare('UPDATE users SET credits = ? WHERE id = ?').bind(balance, userId).run()
  await db
    .prepare(
      `INSERT INTO credit_logs (user_id, type, amount, balance, reason, ref_id)
       VALUES (?, 'revoke', ?, ?, 'refund', ?)`
    )
    .bind(userId, amount, balance, jobId)
    .run()
}

// AtlasCloud 생성 요청 → 폴링 → generation_logs 업데이트 (waitUntil로 백그라운드 실행)
async function runGenerationJob(
  db: D1Database,
  apiKey: string,
  jobId: string,
  userId: string,
  prompt: string,
  images: string[]
) {
  try {
    await updateJob(db, jobId, { status: 'processing' })

    const startRes = await fetch(`${ATLAS_API_BASE}/api/v1/model/generateImage`, {
      method: 'POST',
      headers: atlasHeaders(apiKey),
      body: JSON.stringify({
        model: 'google/nano-banana-2/edit',
        prompt,
        aspect_ratio: '1:1',
        resolution: '2k',
        thinking_level: 'default',
        output_format: 'jpeg',
        images,
      }),
    })
    const startData: any = await startRes.json()
    const atlasJobId = startData?.data?.id
    if (startData?.code !== 200 || !atlasJobId) {
      console.error('generation start failed:', jobId, startData)
      await updateJob(db, jobId, { status: 'failed', error_message: 'AI 생성 요청 실패' })
      await refundCredits(db, userId, jobId, GENERATION_CREDIT_COST)
      return
    }

    const terminalFailStatuses = new Set(['failed', 'timeout', 'canceled', 'error'])
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const pollRes: any = await fetch(`${ATLAS_API_BASE}/api/v1/model/prediction/${atlasJobId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      }).then((r) => r.json())

      const status = pollRes?.data?.status
      if (status === 'completed' || status === 'succeeded') {
        const rawOut = pollRes.data?.outputs ?? pollRes.data?.output ?? pollRes.data?.images ?? null
        const url: string | null = Array.isArray(rawOut)
          ? rawOut.find((u: any) => typeof u === 'string' && u.startsWith('http')) ?? null
          : typeof rawOut === 'string' && rawOut.startsWith('http')
            ? rawOut
            : null

        if (url) {
          await updateJob(db, jobId, { status: 'done', result_url: url })
        } else {
          console.error('generation completed but no output url:', jobId, pollRes)
          await updateJob(db, jobId, { status: 'failed', error_message: '생성 결과를 받지 못했습니다.' })
          await refundCredits(db, userId, jobId, GENERATION_CREDIT_COST)
        }
        return
      }

      if (terminalFailStatuses.has(status)) {
        console.error('generation failed status:', jobId, status)
        await updateJob(db, jobId, { status: 'failed', error_message: `AI 생성 실패 (${status})` })
        await refundCredits(db, userId, jobId, GENERATION_CREDIT_COST)
        return
      }
    }

    console.error('generation polling timeout:', jobId)
    await updateJob(db, jobId, { status: 'failed', error_message: '생성 시간 초과' })
    await refundCredits(db, userId, jobId, GENERATION_CREDIT_COST)
  } catch (err: any) {
    console.error('generation job error:', jobId, err)
    await updateJob(db, jobId, { status: 'failed', error_message: err?.message || '서버 오류' })
    await refundCredits(db, userId, jobId, GENERATION_CREDIT_COST)
  }
}

// ────────────────────────────────────────────────────
// POST /api/generate/start — 생성 시작 (크레딧 차감 + job 생성 + 비동기 큐잉)
// body: { petImage: dataUrl, ownerImage?: dataUrl, concept?: 'studio'|'park'|'christmas' }
// ────────────────────────────────────────────────────
generation.post('/start', async (c) => {
  const db = c.env.NESEGGI_DB
  const token = c.req.header('X-Session-Token')
  const user = await getSessionUser(db, token)
  if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

  const body = await c.req.json().catch(() => null)
  const petImage = body?.petImage
  const ownerImage = body?.ownerImage
  const conceptId = typeof body?.concept === 'string' && CONCEPTS[body.concept] ? body.concept : DEFAULT_CONCEPT

  if (!isDataUrl(petImage)) {
    return c.json({ error: '반려동물 사진이 필요합니다.', code: 'PET_IMAGE_REQUIRED' }, 400)
  }
  const hasOwnerImage = isDataUrl(ownerImage)

  if ((user as any).credits < GENERATION_CREDIT_COST) {
    return c.json({ error: '크레딧이 부족합니다.', code: 'INSUFFICIENT_CREDITS' }, 402)
  }

  const jobId = newJobId()

  // 차감은 잔액 조건을 다시 걸어 동시 요청으로 인한 이중 차감을 방지
  const deduct = await db
    .prepare('UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?')
    .bind(GENERATION_CREDIT_COST, (user as any).id, GENERATION_CREDIT_COST)
    .run()
  if (!deduct.meta.changes) {
    return c.json({ error: '크레딧이 부족합니다.', code: 'INSUFFICIENT_CREDITS' }, 402)
  }

  const balanceRow: any = await db.prepare('SELECT credits FROM users WHERE id = ?').bind((user as any).id).first()
  await db
    .prepare(
      `INSERT INTO credit_logs (user_id, type, amount, balance, reason, ref_id)
       VALUES (?, 'deduct', ?, ?, 'pet_photo_generation', ?)`
    )
    .bind((user as any).id, -GENERATION_CREDIT_COST, balanceRow.credits, jobId)
    .run()

  await db
    .prepare(
      `INSERT INTO generation_logs (id, user_id, owner_image_b64, pet_image_b64, output_type, concept, status, credits_used)
       VALUES (?, ?, ?, ?, 'image', ?, 'pending', ?)`
    )
    .bind(jobId, (user as any).id, hasOwnerImage ? ownerImage : null, petImage, conceptId, GENERATION_CREDIT_COST)
    .run()

  const prompt = buildPrompt(conceptId, hasOwnerImage)
  const images = hasOwnerImage ? [petImage, ownerImage] : [petImage]

  c.executionCtx.waitUntil(runGenerationJob(db, c.env.ATLAS_API_KEY, jobId, (user as any).id, prompt, images))

  return c.json({ jobId, status: 'pending' }, 202)
})

// ────────────────────────────────────────────────────
// GET /api/generate/status/:jobId — 상태 폴링
// ────────────────────────────────────────────────────
generation.get('/status/:jobId', async (c) => {
  const db = c.env.NESEGGI_DB
  const token = c.req.header('X-Session-Token')
  const user = await getSessionUser(db, token)
  if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

  const jobId = c.req.param('jobId')
  const job: any = await db
    .prepare('SELECT id, status, result_url, error_message, concept FROM generation_logs WHERE id = ? AND user_id = ?')
    .bind(jobId, (user as any).id)
    .first()

  if (!job) return c.json({ error: 'not_found' }, 404)
  return c.json({
    jobId: job.id,
    status: job.status,
    resultUrl: job.result_url ?? null,
    errorMessage: job.error_message ?? null,
    concept: job.concept,
  })
})

export { generation }
