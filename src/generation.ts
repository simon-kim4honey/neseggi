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
// 입력 조합: 반려동물 사진(필수) + 보호자 사진(선택) + 배경 사진(선택 — 반려동물과
// 자주 있던 장소, 없으면 프리셋 컨셉으로 대체). 이미지 순서는 항상
// [반려동물, (보호자), (배경)] — 즉 보호자가 없으면 배경이 Image 2가 된다.
// 반려동물/보호자의 실제 생김새를 그대로 유지하라는 지시문이 핵심이다 — 이게
// 조용히 사라지거나 약해지면, 사용자가 보낸 반려동물/보호자와 다르게 생긴
// 결과가 나와도 빌드/배포/로그 어디에도 안 남고 사용자 리포트로만 발견된다
// (lookbook-ai에서 실제로 겪은 사고와 동일 패턴).
// ────────────────────────────────────────────────────
function buildPrompt(conceptId: string, hasOwnerImage: boolean, hasBackgroundImage: boolean): string {
  const concept = CONCEPTS[conceptId] || CONCEPTS[DEFAULT_CONCEPT]

  const backgroundImageIndex = hasOwnerImage ? 3 : 2

  const subjects = [
    'Image 1 shows a pet.',
    hasOwnerImage ? "Image 2 shows the pet's owner (a person)." : '',
    hasBackgroundImage
      ? `Image ${backgroundImageIndex} is a real photo of a place where ${hasOwnerImage ? 'they' : 'it'} often spend${hasOwnerImage ? '' : 's'} time (e.g. home).`
      : '',
    hasOwnerImage
      ? `Combine the pet${hasBackgroundImage ? ' and owner' : ' and the owner'} into a single natural photo${hasBackgroundImage ? ` set in the location shown in Image ${backgroundImageIndex}` : ' together'}.`
      : `Create a single natural photo of this pet${hasBackgroundImage ? ` set in the location shown in Image ${backgroundImageIndex}` : ''}.`,
  ]
    .filter(Boolean)
    .join(' ')

  const petFidelity =
    'ABSOLUTE RULE — NEVER VIOLATE: the pet in the output must be the exact same animal as shown in Image 1 — identical breed, fur color, fur pattern and markings, ear shape, face, and eye color. Do not substitute a different breed, change its coat color or pattern, or generate a generic-looking animal. Only these identifying physical traits are fixed — everything else about the pet (its pose, body position, head angle, and the direction of light and shadow falling on it) must be freely and fully regenerated to naturally fit the new scene. Never simply paste the pet\'s exact pose or lighting from the source photo onto the new background — that produces a flat, cut-out sticker look, which is unacceptable. The pet must look like it was truly and naturally photographed within this new scene, standing, sitting, or moving in a way that makes physical sense there.'

  const ownerFidelity = hasOwnerImage
    ? "ABSOLUTE RULE — NEVER VIOLATE: the person in the output must be the exact same person as shown in Image 2 — identical face, facial features, hair, and skin tone. Do not alter their identity, age, or appearance. Only these identifying facial traits are fixed — everything else about them (their pose, body position, clothing fit, and the direction of light and shadow falling on them) must be freely and fully regenerated to naturally fit the new scene. Never simply paste their exact pose or lighting from the source photo onto the new background — that produces a flat, cut-out sticker look, which is unacceptable. They must look like they were truly and naturally photographed within this new scene, with their face remaining clearly recognizable as the same person."
    : ''

  const subjectsLabel = hasOwnerImage ? 'the pet or owner' : "the pet"
  const blendSubjectsLabel = hasOwnerImage ? 'the pet, the owner, and the background' : 'the pet and the background'
  const backgroundInstruction = hasBackgroundImage
    ? `ABSOLUTE RULE — NEVER VIOLATE: use Image ${backgroundImageIndex} only as a loose reference for the location's overall feel — general architecture style, furniture, colors, lighting, and atmosphere. The background does NOT need to match Image ${backgroundImageIndex} exactly — recreate a similar-feeling setting, and choose whatever camera angle, framing, and room proportions naturally fit ${subjectsLabel}, rather than copying Image ${backgroundImageIndex}'s original camera angle or aspect ratio. Image ${backgroundImageIndex} must have ZERO influence on ${subjectsLabel}'s face or identity — their face, fur pattern, and other identifying features must stay exactly as shown in their source photo, regardless of Image ${backgroundImageIndex}. Also, render the background's furniture and room proportions at a scale and perspective that naturally fits around the subjects, as if a photographer actually captured them in that room — adapt the background's scale and camera angle to match the subjects, not the other way around. The result must look like one single coherent photograph in which ${blendSubjectsLabel} blend seamlessly together — matching lighting direction, color temperature, shadows, and camera perspective across every element — not separate cutouts pasted onto a mismatched background. Do NOT copy any people, pets, animals, text, or objects that already appear in Image ${backgroundImageIndex} into the output — only the pet from Image 1${hasOwnerImage ? ' and the owner from Image 2' : ''} should appear as subjects.`
    : `SCENE: ${concept.promptFragment}`

  const finalReminder = `FINAL OUTPUT: one single photorealistic image of ${
    hasOwnerImage ? 'the owner and their pet together' : 'the pet'
  }, naturally composited into the ${
    hasBackgroundImage ? `location from Image ${backgroundImageIndex}` : 'described scene'
  }. The pet's exact appearance${
    hasOwnerImage ? " and the owner's exact face" : ''
  } must be preserved with zero deviation from the source photo${hasOwnerImage ? 's' : ''} — this is the single most important requirement. No text, no watermark, no logos anywhere in the image.`

  // 배경 사진이 있을 때는 생김새 보존 규칙(petFidelity/ownerFidelity)을 배경
  // 지시문보다 뒤(출력 직전)에 배치한다 — 실제 테스트에서 배경 지시문이 앞서
  // 나올 때 모델이 장면에 맞춰 인물 얼굴/동물 크기를 재구성해버리는 문제가
  // 확인됨(2026-09-10). 뒤쪽 지시문일수록 더 강하게 반영되는 경향을 이용해
  // 우선순위를 바로잡음. 배경 없는 케이스는 이미 정상 동작 확인돼서 순서 유지.
  return hasBackgroundImage
    ? [subjects, backgroundInstruction, petFidelity, ownerFidelity, finalReminder].filter(Boolean).join(' ')
    : [subjects, petFidelity, ownerFidelity, backgroundInstruction, finalReminder].filter(Boolean).join(' ')
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
  if (amount <= 0) return // QA 테스트 등 크레딧을 차감하지 않은 job은 환불도 없음
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

// AtlasCloud "생성 시작" 요청 1회 전송 — /start 핸들러에서 직접 await한다
// (waitUntil 백그라운드 아님). 전체 이미지 생성 완료까지 기다리는 게 아니라
// job이 정상 접수됐다는 응답만 기다리는 거라 보통은 1초 안팎으로 끝나지만,
// AtlasCloud가 간헐적으로 이 응답 자체를 느리게 줄 때가 있어서(2026-09-10
// 반복 확인) 타임아웃을 25초 → 3분으로 늘림. 클라이언트가 이 요청 응답을
// 기다리는 동안 로딩 화면에 붙잡아두지 않고 7초 뒤 바로 채팅으로 넘어가게
// 바꿔뒀기 때문에(`public/static/test.js`의 `startGeneration`), 이 요청이
// 오래 걸려도 사용자는 채팅을 하며 기다릴 수 있다 — 그래서 길게 잡아도 괜찮음.
//
// ⚠️ 예전엔 이 호출을 waitUntil로 백그라운드에 던졌는데, 실사진(수 MB) 테스트에서
// 매번 "함수는 시작됨(디버그 마커까지 기록됨) → AtlasCloud fetch 도중 실행이
// 조용히 끊김 → atlas_job_id 영영 null"인 게 재현됨 (2026-09-10). 이 Cloudflare
// Pages 환경에서 waitUntil이 fetch 완료까지 실행을 보장해주지 않는 것으로
// 판단 — 그래서 "시작" 요청만큼은 요청 처리 안에서 직접 기다리도록 바꿈.
// 실제 완료 확인(폴링)은 여전히 클라이언트가 /status를 호출할 때마다
// syncJobStatus()가 그때그때 짧게 조회한다.
const ATLAS_START_TIMEOUT_MS = 3 * 60 * 1000

async function startAtlasJob(
  apiKey: string,
  prompt: string,
  images: string[],
  thinkingLevel: string
): Promise<{ ok: true; atlasJobId: string } | { ok: false; message: string }> {
  // ⚠️ 타임아웃 없는 fetch가 무한정 걸려있는 문제가 실제로 재현됨(2026-09-10) —
  // AtlasCloud가 응답을 안 주는지, 이미지 payload가 커서 오래 걸리는지 구분
  // 안 되던 걸 AbortController로 명확한 타임아웃 에러로 바꿈.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ATLAS_START_TIMEOUT_MS)

  let startRes: Response
  try {
    startRes = await fetch(`${ATLAS_API_BASE}/api/v1/model/generateImage`, {
      method: 'POST',
      headers: atlasHeaders(apiKey),
      body: JSON.stringify({
        model: 'google/nano-banana-2/edit',
        prompt,
        aspect_ratio: '1:1',
        resolution: '2k',
        thinking_level: thinkingLevel,
        output_format: 'jpeg',
        images,
      }),
      signal: controller.signal,
    })
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.error(`generation start timed out after ${ATLAS_START_TIMEOUT_MS}ms`)
      return { ok: false, message: 'AI 생성 요청이 응답하지 않습니다 (타임아웃)' }
    }
    console.error('generation start fetch error:', err)
    return { ok: false, message: err?.message || 'AI 생성 요청 중 네트워크 오류' }
  } finally {
    clearTimeout(timeout)
  }

  const startData: any = await startRes.json()
  const atlasJobId = startData?.data?.id
  if (startData?.code !== 200 || !atlasJobId) {
    console.error('generation start failed:', startData)
    return { ok: false, message: 'AI 생성 요청 실패' }
  }
  return { ok: true, atlasJobId }
}

// GET /status 호출마다 한 번씩 AtlasCloud를 짧게 조회해서 상태를 동기화한다.
async function syncJobStatus(db: D1Database, apiKey: string, job: any): Promise<any> {
  if (job.status !== 'pending' && job.status !== 'processing') return job

  if (!job.atlas_job_id) {
    // start 요청이 아직(또는 실패로) atlas_job_id를 못 받은 상태 — 너무 오래 묵으면 타임아웃 처리
    const ageMs = Date.now() - new Date(job.created_at + 'Z').getTime()
    if (ageMs > JOB_STALE_MS) {
      await updateJob(db, job.id, { status: 'failed', error_message: '생성 시작에 실패했습니다.' })
      await refundCredits(db, job.user_id, job.id, job.credits_used)
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
      await refundCredits(db, job.user_id, job.id, job.credits_used)
      return { ...job, status: 'failed', error_message: '생성 결과를 받지 못했습니다.' }
    }

    if (TERMINAL_FAIL_STATUSES.has(status)) {
      console.error('generation failed status:', job.id, status)
      await updateJob(db, job.id, { status: 'failed', error_message: `AI 생성 실패 (${status})` })
      await refundCredits(db, job.user_id, job.id, job.credits_used)
      return { ...job, status: 'failed', error_message: `AI 생성 실패 (${status})` }
    }

    return job // 아직 진행 중 — 다음 폴링에서 다시 확인
  } catch (err: any) {
    // 일시적 네트워크 오류 등 — job을 실패 처리하지 않고 다음 폴링에서 재시도
    console.error('poll error:', job.id, err)
    return job
  }
}

// 반려동물 사진 풀(pet_photos, 최대 10장)에서 한 장을 랜덤으로 골라 그
// 원본(data URL)을 KV에서 읽어온다. 온보딩 수동 합성과 "오늘의 추억사진"
// 자동 생성(chat.ts) 둘 다 이 함수로 사진을 고른다 — 사용자가 매번 다른
// 사진 조합을 보게 하려는 의도.
async function pickRandomPetPhoto(
  db: D1Database,
  kv: KVNamespace,
  petId: string,
  userId: string
): Promise<{ dataUrl: string; kvKey: string } | null> {
  const { results } = await db
    .prepare('SELECT kv_key FROM pet_photos WHERE pet_id = ? AND user_id = ?')
    .bind(petId, userId)
    .all()
  const rows = (results as any[]) ?? []
  if (rows.length === 0) return null
  const chosen = rows[Math.floor(Math.random() * rows.length)]
  const dataUrl = await kv.get(chosen.kv_key)
  if (!dataUrl) return null
  return { dataUrl, kvKey: chosen.kv_key }
}

// ────────────────────────────────────────────────────
// POST /api/generate/start — 생성 시작 (크레딧 차감 + job 생성 + 비동기 큐잉)
// body: { petId: string, ownerImage?: dataUrl, backgroundImage?: dataUrl, concept?: 'studio'|'park'|'christmas' }
// 반려동물 사진은 더 이상 클라이언트가 직접 보내지 않는다 — 온보딩 때
// 업로드해둔 사진 풀(최대 10장, pet_photos) 중 한 장을 서버가 랜덤으로
// 골라 사용한다(chat.ts의 POST /pets/:petId/photos로 미리 업로드돼 있어야 함).
// ────────────────────────────────────────────────────
generation.post('/start', async (c) => {
  try {
    const db = c.env.NESEGGI_DB
    const token = c.req.header('X-Session-Token')
    const user = await getSessionUser(db, token)
    if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

    const body = await c.req.json().catch(() => null)
    const petId = typeof body?.petId === 'string' ? body.petId : ''
    const ownerImage = body?.ownerImage
    const backgroundImage = body?.backgroundImage
    const conceptId = typeof body?.concept === 'string' && CONCEPTS[body.concept] ? body.concept : DEFAULT_CONCEPT

    if (!petId) return c.json({ error: '반려동물 정보가 필요합니다.', code: 'PET_ID_REQUIRED' }, 400)
    const pet = await db.prepare('SELECT id FROM pets WHERE id = ? AND user_id = ?').bind(petId, (user as any).id).first()
    if (!pet) return c.json({ error: '반려동물을 찾을 수 없습니다.', code: 'PET_NOT_FOUND' }, 404)

    const picked = await pickRandomPetPhoto(db, c.env.NESEGGI_KV, petId, (user as any).id)
    if (!picked) {
      return c.json({ error: '반려동물 사진이 필요합니다. 먼저 사진을 올려주세요.', code: 'PET_IMAGE_REQUIRED' }, 400)
    }
    const petImage = picked.dataUrl
    const hasOwnerImage = isDataUrl(ownerImage)
    const hasBackgroundImage = isDataUrl(backgroundImage)

    // ⚠️ 출시 전 QA 전용 우회 — /test 페이지만 이 헤더를 보낸다. 실제 결제/크레딧
    // 시스템이 붙기 전까지만 쓰는 임시 장치이므로, 정식 오픈 전에 반드시 제거하거나
    // (관리자 인증 등으로) 잠글 것. 그대로 두면 아무나 이 헤더로 무료 생성 가능.
    const isQaTest = c.req.header('X-Neseggi-QA') === '1'
    const creditsCost = isQaTest ? 0 : GENERATION_CREDIT_COST

    if ((user as any).credits < creditsCost) {
      return c.json({ error: '크레딧이 부족합니다.', code: 'INSUFFICIENT_CREDITS' }, 402)
    }

    const jobId = newJobId()

    // 차감은 잔액 조건을 다시 걸어 동시 요청으로 인한 이중 차감을 방지
    const deduct = await db
      .prepare('UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?')
      .bind(creditsCost, (user as any).id, creditsCost)
      .run()
    if (!deduct.meta.changes) {
      return c.json({ error: '크레딧이 부족합니다.', code: 'INSUFFICIENT_CREDITS' }, 402)
    }

    if (creditsCost > 0) {
      const balanceRow: any = await db.prepare('SELECT credits FROM users WHERE id = ?').bind((user as any).id).first()
      await db
        .prepare(
          `INSERT INTO credit_logs (user_id, type, amount, balance, reason, ref_id)
           VALUES (?, 'deduct', ?, ?, 'pet_photo_generation', ?)`
        )
        .bind((user as any).id, -creditsCost, balanceRow.credits, jobId)
        .run()
    }

    // 반려동물 사진은 이미 pet_photos 풀의 KV 키를 그대로 재사용(중복 저장 안 함).
    // 보호자/배경 사진은 여전히 그때그때 업로드되는 1회성 입력이라 기존처럼 KV에
    // 새로 저장한다(D1 컬럼 값 크기 제한 회피, D1엔 KV 키만 기록).
    const petImageKey = picked.kvKey
    const ownerImageKey = hasOwnerImage
      ? await storeInputImage(c.env.NESEGGI_KV, jobId, 'owner', ownerImage)
      : null
    const backgroundImageKey = hasBackgroundImage
      ? await storeInputImage(c.env.NESEGGI_KV, jobId, 'background', backgroundImage)
      : null

    await db
      .prepare(
        `INSERT INTO generation_logs (id, user_id, pet_id, owner_image_b64, pet_image_b64, background_image_b64, output_type, concept, status, credits_used, source)
         VALUES (?, ?, ?, ?, ?, ?, 'image', ?, 'pending', ?, 'manual')`
      )
      .bind(jobId, (user as any).id, petId, ownerImageKey, petImageKey, backgroundImageKey, conceptId, creditsCost)
      .run()

    const prompt = buildPrompt(conceptId, hasOwnerImage, hasBackgroundImage)
    const images = [petImage, ...(hasOwnerImage ? [ownerImage] : []), ...(hasBackgroundImage ? [backgroundImage] : [])]
    // 배경 사진이 있으면 여러 장을 정확히 구분해서 추론해야 하는 더 어려운
    // 케이스라 thinking_level을 높인다 (2026-09-10 테스트에서 default로는
    // 인물 생김새가 깨지는 문제 확인).
    const thinkingLevel = hasBackgroundImage ? 'high' : 'default'

    const started = await startAtlasJob(c.env.ATLAS_API_KEY, prompt, images, thinkingLevel)
    if (!started.ok) {
      await updateJob(db, jobId, { status: 'failed', error_message: started.message })
      await refundCredits(db, (user as any).id, jobId, creditsCost)
      return c.json({ error: started.message, code: 'ATLAS_START_FAILED' }, 502)
    }
    await updateJob(db, jobId, { status: 'processing', atlas_job_id: started.atlasJobId })

    return c.json({ jobId, status: 'processing' }, 202)
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
      'SELECT id, user_id, status, result_url, error_message, concept, atlas_job_id, created_at, credits_used FROM generation_logs WHERE id = ? AND user_id = ?'
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

export { generation, CONCEPTS, buildPrompt, startAtlasJob, newJobId, updateJob, pickRandomPetPhoto, ATLAS_API_BASE }
