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

function atlasHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
}

function newJobId(): string {
  return `g_${crypto.randomUUID().replace(/-/g, '')}`
}

function isDataUrl(v: unknown): v is string {
  return typeof v === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(v)
}

// base64 이미지는 D1 컬럼(값 크기 제한)이 아니라 KV에 저장한다 — lookbook-ai도
// 같은 이유로 업로드 이미지를 KV(clothing_img:{job_id})에 저장하는 패턴을 쓴다.
// D1의 owner_image_b64/pet_image_b64/background_image_b64 컬럼에는 원본 대신
// 이 KV 키를 저장한다.
const IMAGE_KV_TTL_SECONDS = 60 * 60 * 24 * 14 // 14일

async function storeInputImage(
  kv: KVNamespace,
  jobId: string,
  slot: 'pet' | 'owner' | 'background',
  dataUrl: string
): Promise<string> {
  const key = `gen_input:${jobId}:${slot}`
  await kv.put(key, dataUrl, { expirationTtl: IMAGE_KV_TTL_SECONDS })
  return key
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
// 생성 흐름: 1) 반려동물 사진(필수) 2) 보호자 사진(필수) 3) 배경 사진(선택 —
// 반려동물과 자주 있던 장소, 없으면 프리셋 컨셉으로 대체) → 세 장을 한 장으로
// 합성한다. 반려동물/보호자의 실제 생김새를 그대로 유지하라는 지시문이
// 핵심이다 — 이게 조용히 사라지거나 약해지면, 사용자가 보낸 반려동물/보호자와
// 다르게 생긴 결과가 나와도 빌드/배포/로그 어디에도 안 남고 사용자 리포트로만
// 발견된다(lookbook-ai에서 실제로 겪은 사고와 동일 패턴).
// ────────────────────────────────────────────────────
function buildPrompt(conceptId: string, hasBackgroundImage: boolean): string {
  const concept = CONCEPTS[conceptId] || CONCEPTS[DEFAULT_CONCEPT]

  const subjects = hasBackgroundImage
    ? "Image 1 shows a pet. Image 2 shows the pet's owner (a person). Image 3 is a real photo of a place where they often spend time together (e.g. their home). Combine the pet and owner from Image 1 and Image 2 into a single natural photo set in the location shown in Image 3."
    : "Image 1 shows a pet. Image 2 shows the pet's owner (a person). Combine BOTH into a single natural photo of the owner together with their pet."

  const petFidelity =
    'ABSOLUTE RULE — NEVER VIOLATE: the pet in the output must be the exact same animal as shown in Image 1 — identical breed, fur color, fur pattern and markings, ear shape, face, and eye color. Do not substitute a different breed, change its coat color or pattern, or generate a generic-looking animal. Every physical detail of the pet must be reproduced exactly as in the source photo — only its pose may adapt naturally to the new scene.'

  const ownerFidelity =
    "ABSOLUTE RULE — NEVER VIOLATE: the person in the output must be the exact same person as shown in Image 2 — identical face, facial features, hair, and skin tone. Do not alter their identity, age, or appearance. Only their pose and clothing may adapt naturally to the new scene; their face must remain clearly recognizable as the same person."

  const backgroundInstruction = hasBackgroundImage
    ? "ABSOLUTE RULE — NEVER VIOLATE: use Image 3 ONLY as a reference for the location — its architecture, furniture, colors, lighting, and atmosphere. Recreate a similar-looking setting behind the pet and owner. Do NOT copy any people, pets, animals, text, or objects that already appear in Image 3 into the output — only the pet from Image 1 and the owner from Image 2 should appear as subjects."
    : `SCENE: ${concept.promptFragment}`

  const finalReminder = `FINAL OUTPUT: one single photorealistic image of the owner and their pet together, naturally composited into the ${
    hasBackgroundImage ? 'location from Image 3' : 'described scene'
  }. The pet's exact appearance and the owner's exact face must be preserved with zero deviation from the source photos — this is the single most important requirement. No text, no watermark, no logos anywhere in the image.`

  return [subjects, petFidelity, ownerFidelity, backgroundInstruction, finalReminder].filter(Boolean).join(' ')
}

async function updateJob(
  db: D1Database,
  jobId: string,
  fields: { status: string; result_url?: string; error_message?: string; atlas_job_id?: string }
) {
  await db
    .prepare(
      `UPDATE generation_logs
       SET status = ?, result_url = COALESCE(?, result_url), error_message = COALESCE(?, error_message),
           atlas_job_id = COALESCE(?, atlas_job_id),
           completed_at = CASE WHEN ? IN ('done', 'failed') THEN datetime('now') ELSE completed_at END
       WHERE id = ?`
    )
    .bind(
      fields.status,
      fields.result_url ?? null,
      fields.error_message ?? null,
      fields.atlas_job_id ?? null,
      fields.status,
      jobId
    )
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

const TERMINAL_FAIL_STATUSES = new Set(['failed', 'timeout', 'canceled', 'error'])
const JOB_STALE_MS = 5 * 60 * 1000 // 이 시간 넘게 processing인데 atlas_job_id도 없으면 타임아웃 처리

function extractOutputUrl(pollRes: any): string | null {
  const rawOut = pollRes?.data?.outputs ?? pollRes?.data?.output ?? pollRes?.data?.images ?? null
  if (Array.isArray(rawOut)) {
    return rawOut.find((u: any) => typeof u === 'string' && u.startsWith('http')) ?? null
  }
  return typeof rawOut === 'string' && rawOut.startsWith('http') ? rawOut : null
}

// AtlasCloud 생성 요청 1회 전송 (waitUntil로 백그라운드 실행). 완료까지 기다리지
// 않고 job id만 받아서 저장한다 — 실제 완료 확인은 클라이언트가 /status를 호출할
// 때마다 syncJobStatus()가 그때그때 짧게 조회한다. (예전엔 이 함수 안에서 최대
// 2분짜리 폴링 루프를 돌렸는데, Cloudflare waitUntil의 실행시간 제한에 걸려
// 루프 중간에 조용히 종료되고 job이 영원히 'processing'에 멈추는 문제가 실제로
// 발생함— 2026-09-10 첫 실사진 테스트에서 확인. 짧은 요청 여러 번으로 바꿔서 해결.)
async function startAtlasJob(
  db: D1Database,
  apiKey: string,
  jobId: string,
  userId: string,
  prompt: string,
  images: string[]
) {
  try {
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
    await updateJob(db, jobId, { status: 'processing', atlas_job_id: atlasJobId })
  } catch (err: any) {
    console.error('generation start error:', jobId, err)
    await updateJob(db, jobId, { status: 'failed', error_message: err?.message || '서버 오류' })
    await refundCredits(db, userId, jobId, GENERATION_CREDIT_COST)
  }
}

// GET /status 호출마다 한 번씩 AtlasCloud를 짧게 조회해서 상태를 동기화한다.
async function syncJobStatus(db: D1Database, apiKey: string, job: any): Promise<any> {
  if (job.status !== 'pending' && job.status !== 'processing') return job

  if (!job.atlas_job_id) {
    // start 요청이 아직(또는 실패로) atlas_job_id를 못 받은 상태 — 너무 오래 묵으면 타임아웃 처리
    const ageMs = Date.now() - new Date(job.created_at + 'Z').getTime()
    if (ageMs > JOB_STALE_MS) {
      await updateJob(db, job.id, { status: 'failed', error_message: '생성 시작에 실패했습니다.' })
      await refundCredits(db, job.user_id, job.id, GENERATION_CREDIT_COST)
      return { ...job, status: 'failed', error_message: '생성 시작에 실패했습니다.' }
    }
    return job
  }

  try {
    const pollRes: any = await fetch(`${ATLAS_API_BASE}/api/v1/model/prediction/${job.atlas_job_id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }).then((r) => r.json())

    const status = pollRes?.data?.status
    if (status === 'completed' || status === 'succeeded') {
      const url = extractOutputUrl(pollRes)
      if (url) {
        await updateJob(db, job.id, { status: 'done', result_url: url })
        return { ...job, status: 'done', result_url: url }
      }
      console.error('generation completed but no output url:', job.id, pollRes)
      await updateJob(db, job.id, { status: 'failed', error_message: '생성 결과를 받지 못했습니다.' })
      await refundCredits(db, job.user_id, job.id, GENERATION_CREDIT_COST)
      return { ...job, status: 'failed', error_message: '생성 결과를 받지 못했습니다.' }
    }

    if (TERMINAL_FAIL_STATUSES.has(status)) {
      console.error('generation failed status:', job.id, status)
      await updateJob(db, job.id, { status: 'failed', error_message: `AI 생성 실패 (${status})` })
      await refundCredits(db, job.user_id, job.id, GENERATION_CREDIT_COST)
      return { ...job, status: 'failed', error_message: `AI 생성 실패 (${status})` }
    }

    return job // 아직 진행 중 — 다음 폴링에서 다시 확인
  } catch (err: any) {
    // 일시적 네트워크 오류 등 — job을 실패 처리하지 않고 다음 폴링에서 재시도
    console.error('poll error:', job.id, err)
    return job
  }
}

// ────────────────────────────────────────────────────
// POST /api/generate/start — 생성 시작 (크레딧 차감 + job 생성 + 비동기 큐잉)
// body: { petImage: dataUrl, ownerImage?: dataUrl, concept?: 'studio'|'park'|'christmas' }
// ────────────────────────────────────────────────────
generation.post('/start', async (c) => {
  try {
    const db = c.env.NESEGGI_DB
    const token = c.req.header('X-Session-Token')
    const user = await getSessionUser(db, token)
    if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

    const body = await c.req.json().catch(() => null)
    const petImage = body?.petImage
    const ownerImage = body?.ownerImage
    const backgroundImage = body?.backgroundImage
    const conceptId = typeof body?.concept === 'string' && CONCEPTS[body.concept] ? body.concept : DEFAULT_CONCEPT

    if (!isDataUrl(petImage)) {
      return c.json({ error: '반려동물 사진이 필요합니다.', code: 'PET_IMAGE_REQUIRED' }, 400)
    }
    if (!isDataUrl(ownerImage)) {
      return c.json({ error: '보호자 사진이 필요합니다.', code: 'OWNER_IMAGE_REQUIRED' }, 400)
    }
    const hasBackgroundImage = isDataUrl(backgroundImage)

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

    // 원본 이미지는 KV에 저장 (D1 컬럼 값 크기 제한 회피) — D1엔 KV 키만 기록
    const petImageKey = await storeInputImage(c.env.NESEGGI_KV, jobId, 'pet', petImage)
    const ownerImageKey = await storeInputImage(c.env.NESEGGI_KV, jobId, 'owner', ownerImage)
    const backgroundImageKey = hasBackgroundImage
      ? await storeInputImage(c.env.NESEGGI_KV, jobId, 'background', backgroundImage)
      : null

    await db
      .prepare(
        `INSERT INTO generation_logs (id, user_id, owner_image_b64, pet_image_b64, background_image_b64, output_type, concept, status, credits_used)
         VALUES (?, ?, ?, ?, ?, 'image', ?, 'pending', ?)`
      )
      .bind(jobId, (user as any).id, ownerImageKey, petImageKey, backgroundImageKey, conceptId, GENERATION_CREDIT_COST)
      .run()

    const prompt = buildPrompt(conceptId, hasBackgroundImage)
    const images = hasBackgroundImage ? [petImage, ownerImage, backgroundImage] : [petImage, ownerImage]

    c.executionCtx.waitUntil(startAtlasJob(db, c.env.ATLAS_API_KEY, jobId, (user as any).id, prompt, images))

    return c.json({ jobId, status: 'pending' }, 202)
  } catch (err: any) {
    console.error('generate/start error:', err)
    return c.json({ error: '서버 오류가 발생했습니다.', code: 'INTERNAL_ERROR', message: err?.message }, 500)
  }
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
  let job: any = await db
    .prepare(
      'SELECT id, user_id, status, result_url, error_message, concept, atlas_job_id, created_at FROM generation_logs WHERE id = ? AND user_id = ?'
    )
    .bind(jobId, (user as any).id)
    .first()

  if (!job) return c.json({ error: 'not_found' }, 404)

  job = await syncJobStatus(db, c.env.ATLAS_API_KEY, job)

  return c.json({
    jobId: job.id,
    status: job.status,
    resultUrl: job.result_url ?? null,
    errorMessage: job.error_message ?? null,
    concept: job.concept,
  })
})

export { generation }
