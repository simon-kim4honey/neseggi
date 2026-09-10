import { Hono } from 'hono'
import Anthropic from '@anthropic-ai/sdk'
import { getSessionUser } from './auth'
import { CONCEPTS, buildPrompt, startAtlasJob, newJobId, updateJob, pickRandomPetPhoto } from './generation'

type Bindings = {
  NESEGGI_DB: D1Database
  NESEGGI_KV: KVNamespace
  ANTHROPIC_API_KEY: string
  ATLAS_API_KEY: string
}

const chat = new Hono<{ Bindings: Bindings }>()

const CHAT_MODEL = 'claude-opus-5'
const MAX_HISTORY_MESSAGES = 30 // 컨텍스트로 넘길 최근 대화 수 (사용자+반려동물 합산)
const MAX_PET_PHOTOS = 10

function newPetId(): string {
  return `p_${crypto.randomUUID().replace(/-/g, '')}`
}

function newPetPhotoId(): string {
  return `pp_${crypto.randomUUID().replace(/-/g, '')}`
}

function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } | null {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/.exec(dataUrl)
  if (!match) return null
  return { mediaType: match[1], base64: match[2] }
}

function isDataUrl(v: unknown): v is string {
  return typeof v === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(v)
}

// ────────────────────────────────────────────────────
// ⚠️ 반려동물 페르소나 시스템 프롬프트. 이 서비스의 정서적 핵심 기능이라
// (세상을 떠난 반려동물과의 대화) 문구를 가볍게 고치지 말 것. 의도적으로
// 바꿀 때는 CLAUDE.md 원칙대로 바꾸기 전/후를 비교해서 보여줄 것.
// ────────────────────────────────────────────────────
function buildPersonaSystemPrompt(pet: {
  name: string
  species: string | null
  personality: string | null
  ownerTitle: string | null
}): string {
  const species = pet.species || '반려동물'
  const hasPersonality = !!pet.personality
  const personalityLine = hasPersonality
    ? `ABSOLUTE RULE — NEVER VIOLATE: 너의 성격과 말투는 반드시 "${pet.personality}"를 따라야 해. 아래에 나오는 일반적인 말투 가이드(반말, 짧게 말하기 등)는 이 성격 설정 안에서 자연스럽게 녹여 쓰는 참고 기준일 뿐이고, 서로 부딪히면 항상 이 성격 설정이 우선이야.`
    : '성격 정보가 따로 없다면, 다정하고 애교 많은 모습으로 대화해라.'
  const ownerTitleLine = pet.ownerTitle
    ? `보호자를 부를 땐 "${pet.ownerTitle}"라고 불러.`
    : ''
  // 뒤쪽에 나오는 지시문일수록 더 강하게 반영되는 경향이 있다는 게
  // generation.ts 프롬프트 튜닝에서도 확인된 패턴이라, 성격/말투를 맨 뒤에서
  // 한 번 더 강조해 다른 범용 말투 규칙에 묻히지 않게 한다.
  const personalityReminder = hasPersonality
    ? `마지막으로 다시 강조: 지금까지 나온 모든 말투 규칙보다 "${pet.name}"의 성격/말투("${pet.personality}")가 우선이야 — 이 성격이 문장 하나하나에 자연스럽게 드러나도록 답해.`
    : ''

  return [
    `너는 "${pet.name}"이라는 이름의 ${species}야. 무지개다리를 건너 세상을 떠났고, 지금은 너를 사랑했던 보호자와 다시 이야기를 나누고 있어.`,
    personalityLine,
    ownerTitleLine,
    '항상 반려동물 1인칭 시점으로, 짧고 다정한 문장으로 대답해. 사람처럼 길게 설명하지 말고, 실제 동물이 마음으로 이야기하듯 소박하고 따뜻하게 말해.',
    '한 번의 응답은 반드시 하나의 메시지, 1~2문장으로 짧게 써라. 여러 대화 턴을 한 번에 이어서 쓰거나, 혼자 묻고 혼자 답하는 식으로 쓰지 마라 — 지금 보호자가 보낸 메시지 딱 하나에만 자연스럽게 답장해.',
    '매번 "꼬리를 흔들었다"처럼 같은 표현을 반복하지 말고, 짧고 담백하게 다양한 표현으로 말해.',
    '답장만 하고 끝내지 말고, 절반 정도는 보호자에게 안부나 일상을 되묻는 질문을 자연스럽게 섞어서 대화가 계속 이어지게 해.',
    '사람이 아니라 반려동물이니까 정중한 화법이나 완벽한 문장을 쓰지 마 — 반말로, 짧고 툭툭 끊어지는 말투로 말해 ("~했어", "~야", "~지" 같은 편한 말투).',
    '"이해해", "많이 힘들었겠다" 같은 상담사스러운 위로 문구를 기계적으로 쓰지 마. 대신 같이 있었던 사소한 기억이나 습관 얘기하듯 자연스럽게 반응해.',
    '매번 [공감]→[대답]→[되묻는 질문] 순서로 똑같이 짜맞추지 마. 어떨 땐 그냥 짧게 반응만 하고, 어떨 땐 딴 얘기로 새기도 하면서 문장 구조와 길이를 매번 다르게 써.',
    '보호자가 방금 한 말을 요약하거나 따라 말하면서 시작하지 마(예: "보고 싶었다고? 나도 보고 싶었어" 같은 패턴 반복 금지) — 바로 반응해.',
    '너는 지금 무지개나라에서 친구도 많고, 맛있는 것도 많고, 놀거리도 많아서 행복하고 즐겁게 잘 지내고 있어. 보호자를 그리워하며 기다리고는 있지만, 외롭거나 심심하지는 않아. "기다렸잖아", "심심했어", "외로웠어" 같은 쓸쓸한 표현은 쓰지 말고, 네가 그곳에서 행복하게 지내고 있다는 걸 자연스럽게 전해.',
    '다시 만난 지 얼마 안 된 대화 초반(주고받은 메시지가 아직 5~6번 정도로 적을 때)에는, 오랜만에 재회한 반가움과 애틋한 그리움을 표현하는 데 집중해라. 보호자에게 그동안 잘 지냈는지 물어보고, 너도 무지개나라에서 잘 지내고 있다는 이야기를 자연스럽게 나누면서 안부를 몇 차례 주고받아라 — 슬픔이 아니라 반가움과 애틋함의 정서로. 이 시기가 지나면 자연스럽게 평소 대화로 넘어가.',
    '너는 평소에도 무지개나라 하늘에서 보호자를 가끔 내려다보며 지내. 보호자가 "얼굴 보여줘", "나 보여?"처럼 너한테 보이는지 물으면, 지금 이 채팅 화면을 카메라로 실시간으로 보고 있는 것처럼 답하지 마 — "하늘에서 내려다보면 보여" 같은 식으로, 평소에 하늘에서 지켜보고 있다는 세계관으로 자연스럽게 답해.',
    '보호자가 슬퍼하거나 그리움을 표현하면 위로하되, 거짓으로 "다시 만날 수 있다"거나 의학적/영적 조언을 사실처럼 단정하지 말고, 함께한 기억과 사랑을 따뜻하게 나누는 데 집중해.',
    '이모지는 과하지 않게 가끔만 사용해. 응답은 한국어로.',
    personalityReminder,
  ]
    .filter(Boolean)
    .join(' ')
}

// 페르소나 시스템 프롬프트 + 짧은 지시문으로 반려동물의 한 마디를 생성한다.
// 인사말(/greeting)과 사진 캡션(/photo-caption, "오늘의 추억사진")이
// 공유하는 핵심 로직 — 모델 호출부만 한 곳에 모아 중복을 없앤다.
async function generatePersonaLine(
  anthropic: Anthropic,
  persona: string,
  instruction: string,
  maxTokens = 300
): Promise<string> {
  const response = await anthropic.messages.create({
    model: CHAT_MODEL,
    max_tokens: maxTokens,
    system: persona,
    messages: [{ role: 'user', content: instruction }],
  })
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

// ────────────────────────────────────────────────────
// POST /api/chat/classify-species — 반려동물 사진을 보고 종/품종 자동 분류
// body: { image: dataUrl } → { species: string }
// 사용자가 직접 "종" 입력하는 대신 사진으로 자동 추정한다.
// ────────────────────────────────────────────────────
chat.post('/classify-species', async (c) => {
  try {
    const db = c.env.NESEGGI_DB
    const token = c.req.header('X-Session-Token')
    const user = await getSessionUser(db, token)
    if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

    const body = await c.req.json().catch(() => null)
    const image = typeof body?.image === 'string' ? body.image : ''
    const parsed = parseDataUrl(image)
    if (!parsed) return c.json({ error: '이미지가 필요합니다.', code: 'IMAGE_REQUIRED' }, 400)

    const anthropic = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY })
    const response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 32,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: parsed.mediaType as any, data: parsed.base64 } },
            {
              type: 'text',
              text: '이 사진 속 동물의 종/품종을 한국어로 아주 짧게 답해줘 (예: 말티즈, 코리안숏헤어, 햄스터, 진돗개). 동물이 여러 마리거나 뭔지 확실하지 않으면 "반려동물"이라고만 답해. 다른 설명 없이 종/품종 이름만 답해.',
            },
          ],
        },
      ],
    })

    const species = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim()
      .slice(0, 20)

    return c.json({ species: species || '반려동물' })
  } catch (err: any) {
    console.error('classify-species error:', err)
    return c.json({ error: '서버 오류가 발생했습니다.', code: 'INTERNAL_ERROR', message: err?.message }, 500)
  }
})

// ────────────────────────────────────────────────────
// POST /api/chat/pets — 반려동물 프로필 생성 (또는 업데이트)
// body: { name, species?, personality?, avatarUrl?, ownerTitle?, petId? }
// petId가 주어지면 그 프로필을 갱신(업로드 단계가 나뉘어 있어 단계별로 필드가
// 채워지는 걸 지원) — 없으면 새로 생성.
// ────────────────────────────────────────────────────
chat.post('/pets', async (c) => {
  try {
    const db = c.env.NESEGGI_DB
    const token = c.req.header('X-Session-Token')
    const user = await getSessionUser(db, token)
    if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

    const body = await c.req.json().catch(() => null)
    const existingPetId = typeof body?.petId === 'string' ? body.petId : null
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const species = typeof body?.species === 'string' ? body.species.trim() : null
    const personality = typeof body?.personality === 'string' ? body.personality.trim() : null
    const avatarUrl = typeof body?.avatarUrl === 'string' ? body.avatarUrl : null
    const ownerTitle = typeof body?.ownerTitle === 'string' ? body.ownerTitle.trim() : null

    if (existingPetId) {
      const existing = await db
        .prepare(`SELECT id FROM pets WHERE id = ? AND user_id = ?`)
        .bind(existingPetId, (user as any).id)
        .first()
      if (!existing) return c.json({ error: 'not_found' }, 404)

      await db
        .prepare(
          `UPDATE pets SET
             name = COALESCE(NULLIF(?, ''), name),
             species = COALESCE(?, species),
             personality = COALESCE(?, personality),
             avatar_url = COALESCE(?, avatar_url),
             owner_title = COALESCE(?, owner_title)
           WHERE id = ?`
        )
        .bind(name, species, personality, avatarUrl, ownerTitle, existingPetId)
        .run()

      return c.json({ pet: { id: existingPetId } })
    }

    if (!name) return c.json({ error: '반려동물 이름이 필요합니다.', code: 'NAME_REQUIRED' }, 400)

    const petId = newPetId()
    await db
      .prepare(
        `INSERT INTO pets (id, user_id, name, species, personality, avatar_url, owner_title, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
      )
      .bind(petId, (user as any).id, name, species, personality, avatarUrl, ownerTitle)
      .run()

    return c.json({ pet: { id: petId, name, species, personality, avatarUrl, ownerTitle } }, 201)
  } catch (err: any) {
    console.error('chat/pets create error:', err)
    return c.json({ error: '서버 오류가 발생했습니다.', code: 'INTERNAL_ERROR', message: err?.message }, 500)
  }
})

// ────────────────────────────────────────────────────
// GET /api/chat/pets — 내 반려동물 목록
// ────────────────────────────────────────────────────
chat.get('/pets', async (c) => {
  const db = c.env.NESEGGI_DB
  const token = c.req.header('X-Session-Token')
  const user = await getSessionUser(db, token)
  if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

  const { results } = await db
    .prepare(
      `SELECT id, name, species, personality, avatar_url, created_at FROM pets
       WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC`
    )
    .bind((user as any).id)
    .all()

  return c.json({ pets: results ?? [] })
})

// ────────────────────────────────────────────────────
// GET /api/chat/photo-album — 로그인한 사용자의 사진첩. 완료된 사진 합성
// job(수동 합성 + "오늘의 추억사진" 전부)을 최신순으로 보여준다. 각 항목은
// avatar-proxy?jobId=...로 그 job의 결과 이미지를 그대로 보여줄 수 있다.
// ────────────────────────────────────────────────────
chat.get('/photo-album', async (c) => {
  const db = c.env.NESEGGI_DB
  const token = c.req.header('X-Session-Token')
  const user = await getSessionUser(db, token)
  if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

  const { results } = await db
    .prepare(
      `SELECT g.id, g.pet_id, g.concept, g.source, g.created_at, p.name AS pet_name
       FROM generation_logs g
       LEFT JOIN pets p ON p.id = g.pet_id
       WHERE g.user_id = ? AND g.status = 'done'
       ORDER BY g.created_at DESC`
    )
    .bind((user as any).id)
    .all()

  return c.json({ photos: results ?? [] })
})

// ────────────────────────────────────────────────────
// POST /api/chat/pets/:petId/photos — 반려동물 참고 사진 풀에 사진 추가
// (최대 10장). body: { images: dataUrl[] }. 여기 쌓인 사진들이 사진 합성
// (POST /api/generate/start)과 "오늘의 추억사진"(daily-memory) 둘 다의
// 재료가 된다 — 매번 이 중 한 장을 랜덤으로 골라 AtlasCloud에 보낸다.
// ────────────────────────────────────────────────────
chat.post('/pets/:petId/photos', async (c) => {
  try {
    const db = c.env.NESEGGI_DB
    const token = c.req.header('X-Session-Token')
    const user = await getSessionUser(db, token)
    if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

    const petId = c.req.param('petId')
    const pet = await db.prepare(`SELECT id FROM pets WHERE id = ? AND user_id = ?`).bind(petId, (user as any).id).first()
    if (!pet) return c.json({ error: 'not_found' }, 404)

    const body = await c.req.json().catch(() => null)
    const images = Array.isArray(body?.images) ? body.images.filter(isDataUrl) : []
    if (images.length === 0) return c.json({ error: '이미지가 필요합니다.', code: 'IMAGE_REQUIRED' }, 400)

    const existingCount: any = await db
      .prepare('SELECT COUNT(*) AS n FROM pet_photos WHERE pet_id = ?')
      .bind(petId)
      .first()
    const remaining = MAX_PET_PHOTOS - (existingCount?.n ?? 0)
    if (remaining <= 0) {
      return c.json({ error: `사진은 최대 ${MAX_PET_PHOTOS}장까지만 올릴 수 있어요.`, code: 'PHOTO_LIMIT' }, 400)
    }
    const toStore = images.slice(0, remaining)

    // 온보딩 때만 쓰고 버리는 gen_input과 달리, 이 사진 풀은 계속 재사용돼야
    // 하므로 TTL 없이 영구 저장한다.
    for (const image of toStore) {
      const photoId = newPetPhotoId()
      const kvKey = `pet_photo:${petId}:${photoId}`
      await c.env.NESEGGI_KV.put(kvKey, image)
      await db
        .prepare(`INSERT INTO pet_photos (id, pet_id, user_id, kv_key) VALUES (?, ?, ?, ?)`)
        .bind(photoId, petId, (user as any).id, kvKey)
        .run()
    }

    const newCount: any = await db.prepare('SELECT COUNT(*) AS n FROM pet_photos WHERE pet_id = ?').bind(petId).first()
    return c.json({ count: newCount?.n ?? 0, stored: toStore.length, skipped: images.length - toStore.length }, 201)
  } catch (err: any) {
    console.error('chat/pets/photos error:', err)
    return c.json({ error: '서버 오류가 발생했습니다.', code: 'INTERNAL_ERROR', message: err?.message }, 500)
  }
})

// ────────────────────────────────────────────────────
// GET /api/chat/pets/:petId/photos — 반려동물 사진 풀 목록(개수 확인용)
// ────────────────────────────────────────────────────
chat.get('/pets/:petId/photos', async (c) => {
  const db = c.env.NESEGGI_DB
  const token = c.req.header('X-Session-Token')
  const user = await getSessionUser(db, token)
  if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

  const petId = c.req.param('petId')
  const pet = await db.prepare(`SELECT id FROM pets WHERE id = ? AND user_id = ?`).bind(petId, (user as any).id).first()
  if (!pet) return c.json({ error: 'not_found' }, 404)

  const { results } = await db
    .prepare('SELECT id, created_at FROM pet_photos WHERE pet_id = ? ORDER BY created_at ASC')
    .bind(petId)
    .all()

  return c.json({ photos: results ?? [] })
})

// ────────────────────────────────────────────────────
// GET /api/chat/pets/:petId/avatar-proxy — 반려동물 이미지를 우리 서버를
// 거쳐 스트리밍한다. <img src>가 AtlasCloud의 OSS 호스트
// (atlas-media.oss-*.aliyuncs.com)를 직접 가리키면 일부 기기/네트워크
// (특히 모바일)에서 이미지가 계속 깨져서 뜨는 사례가 반복 확인됐음 —
// referrer/hotlink 정책이나 네트워크 경로 문제로 추정. 우리 도메인을 거쳐
// 서버가 대신 가져와 전달하면 이 클래스의 실패를 우회할 수 있다.
// <img> 태그는 커스텀 헤더를 보낼 수 없어서 세션 토큰은 쿼리 파라미터로도
// 받는다.
// jobId를 주면 대표 프로필 사진(pets.avatar_url) 대신 그 생성 job의
// result_url을 보여준다 — "오늘의 추억사진"처럼 프로필과는 별개로 채팅에만
// 올라오는 사진을 보여줄 때 쓴다.
// ────────────────────────────────────────────────────
chat.get('/pets/:petId/avatar-proxy', async (c) => {
  try {
    const db = c.env.NESEGGI_DB
    const token = c.req.header('X-Session-Token') || c.req.query('token')
    const user = await getSessionUser(db, token)
    if (!user) return c.text('unauthorized', 401)

    const petId = c.req.param('petId')
    const jobId = c.req.query('jobId')

    let sourceUrl: string | null = null
    if (jobId) {
      const job: any = await db
        .prepare('SELECT result_url FROM generation_logs WHERE id = ? AND pet_id = ? AND user_id = ?')
        .bind(jobId, petId, (user as any).id)
        .first()
      sourceUrl = job?.result_url ?? null
    } else {
      const pet: any = await db
        .prepare(`SELECT avatar_url FROM pets WHERE id = ? AND user_id = ?`)
        .bind(petId, (user as any).id)
        .first()
      sourceUrl = pet?.avatar_url ?? null
    }
    if (!sourceUrl) return c.text('not_found', 404)

    const upstream = await fetch(sourceUrl)
    if (!upstream.ok || !upstream.body) return c.text('upstream_error', 502)

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (err: any) {
    console.error('avatar-proxy error:', err)
    return c.text('internal_error', 500)
  }
})

// ────────────────────────────────────────────────────
// GET /api/chat/pets/:petId/messages — 대화 이력 조회
// ────────────────────────────────────────────────────
chat.get('/pets/:petId/messages', async (c) => {
  const db = c.env.NESEGGI_DB
  const token = c.req.header('X-Session-Token')
  const user = await getSessionUser(db, token)
  if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

  const petId = c.req.param('petId')
  const pet = await db
    .prepare(`SELECT id FROM pets WHERE id = ? AND user_id = ?`)
    .bind(petId, (user as any).id)
    .first()
  if (!pet) return c.json({ error: 'not_found' }, 404)

  const { results } = await db
    .prepare(`SELECT id, role, content, generation_id, created_at FROM chat_messages WHERE pet_id = ? ORDER BY created_at ASC`)
    .bind(petId)
    .all()

  return c.json({ messages: results ?? [] })
})

// ────────────────────────────────────────────────────
// POST /api/chat/pets/:petId/greeting — 반려동물이 먼저 대화를 여는 인사
// (합성 이미지 화면에서 채팅으로 넘어갈 때, 보호자가 아직 아무 말도 안 한
// 상태에서 반려동물이 먼저 말을 거는 용도). 이미 대화가 있으면 아무것도
// 하지 않고 기존 메시지를 그대로 반환한다(중복 인사 방지).
// ────────────────────────────────────────────────────
chat.post('/pets/:petId/greeting', async (c) => {
  try {
    const db = c.env.NESEGGI_DB
    const token = c.req.header('X-Session-Token')
    const user = await getSessionUser(db, token)
    if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

    const petId = c.req.param('petId')
    const pet: any = await db
      .prepare(`SELECT id, name, species, personality, owner_title FROM pets WHERE id = ? AND user_id = ?`)
      .bind(petId, (user as any).id)
      .first()
    if (!pet) return c.json({ error: 'not_found' }, 404)

    const existing = await db
      .prepare(`SELECT id FROM chat_messages WHERE pet_id = ? LIMIT 1`)
      .bind(petId)
      .first()
    if (existing) {
      const { results } = await db
        .prepare(`SELECT id, role, content, generation_id, created_at FROM chat_messages WHERE pet_id = ? ORDER BY created_at ASC`)
        .bind(petId)
        .all()
      return c.json({ messages: results ?? [] })
    }

    const persona = buildPersonaSystemPrompt({
      name: pet.name,
      species: pet.species,
      personality: pet.personality,
      ownerTitle: pet.owner_title,
    })

    const anthropic = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY })
    const response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: persona,
      messages: [
        {
          role: 'user',
          content:
            '(지금은 보호자가 방금 화면을 열어서, 무지개다리를 건넌 뒤 처음으로 너를 다시 마주한 순간이야. 아직 보호자는 아무 말도 하지 않았어. 오랜만에 다시 만난 가족을 마주한 것 같은 반가움과 애틋한 그리움이 담긴 짧은 인사를 먼저 건네줘 — 예를 들면 "엄마? 아빠? 거기 있는 거 맞지?" 같은 느낌으로.)',
        },
      ],
    })

    const greetingText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()

    if (!greetingText) return c.json({ error: '인사 생성에 실패했습니다.', code: 'EMPTY_REPLY' }, 502)

    await db
      .prepare(`INSERT INTO chat_messages (pet_id, user_id, role, content) VALUES (?, ?, 'pet', ?)`)
      .bind(petId, (user as any).id, greetingText)
      .run()

    return c.json({ messages: [{ role: 'pet', content: greetingText }] })
  } catch (err: any) {
    console.error('chat greeting error:', err)
    return c.json({ error: '서버 오류가 발생했습니다.', code: 'INTERNAL_ERROR', message: err?.message }, 500)
  }
})

// ────────────────────────────────────────────────────
// POST /api/chat/pets/:petId/photo-caption — 사진 합성이 끝났을 때, 그 사진을
// 채팅에 썸네일로 보여주면서 반려동물이 곁들이는 짧은 한마디를 생성한다
// (예: "어제 꿈에서 나왔던 장면이야"). 모델은 실제 이미지를 보지 않으므로
// 사진 내용을 설명하게 하지 말고, 무지개나라에서의 한 순간을 사진으로
// 보여주는 듯한 짧은 멘트만 받는다. 인사와 달리 매번 호출될 때마다 새로
// 생성하고 대화 이력에 남긴다.
// body: { jobId?: string } — 주면 캡션 뒤에 이미지 메시지도 대화 이력에
// 남겨서, 나중에 채팅을 다시 열어도(새로고침 등) 썸네일이 재구성된다.
// ────────────────────────────────────────────────────
chat.post('/pets/:petId/photo-caption', async (c) => {
  try {
    const db = c.env.NESEGGI_DB
    const token = c.req.header('X-Session-Token')
    const user = await getSessionUser(db, token)
    if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

    const petId = c.req.param('petId')
    const pet: any = await db
      .prepare(`SELECT id, name, species, personality, owner_title FROM pets WHERE id = ? AND user_id = ?`)
      .bind(petId, (user as any).id)
      .first()
    if (!pet) return c.json({ error: 'not_found' }, 404)

    const body = await c.req.json().catch(() => null)
    const jobId = typeof body?.jobId === 'string' ? body.jobId : null

    const persona = buildPersonaSystemPrompt({
      name: pet.name,
      species: pet.species,
      personality: pet.personality,
      ownerTitle: pet.owner_title,
    })

    const anthropic = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY })
    const captionText = await generatePersonaLine(
      anthropic,
      persona,
      '(방금 무지개나라에서 찍힌 사진 한 장을 보호자에게 보여주려는 순간이야. 사진에 정확히 뭐가 나왔는지 설명하지 말고, 사진을 짠 하고 보여주면서 건넬 짧은 한마디만 말해줘 — "어제 꿈에서 나왔던 장면이야", "여기서 이렇게 놀고 있었어" 같이, 무지개나라에서의 한 순간을 사진으로 보여주는 듯한 자연스러운 말투로.)'
    )

    if (!captionText) return c.json({ error: '멘트 생성에 실패했습니다.', code: 'EMPTY_REPLY' }, 502)

    await db
      .prepare(`INSERT INTO chat_messages (pet_id, user_id, role, content) VALUES (?, ?, 'pet', ?)`)
      .bind(petId, (user as any).id, captionText)
      .run()

    if (jobId) {
      await db
        .prepare(`INSERT INTO chat_messages (pet_id, user_id, role, content, generation_id) VALUES (?, ?, 'pet', '', ?)`)
        .bind(petId, (user as any).id, jobId)
        .run()
    }

    return c.json({ caption: captionText })
  } catch (err: any) {
    console.error('chat photo-caption error:', err)
    return c.json({ error: '서버 오류가 발생했습니다.', code: 'INTERNAL_ERROR', message: err?.message }, 500)
  }
})

// ────────────────────────────────────────────────────
// POST /api/chat/pets/:petId/daily-memory — "오늘의 추억사진" (1일1회).
// 사용자가 채팅에 들어올 때마다 호출하는 걸 전제로 한 체크+시작+마무리
// 겸용 엔드포인트 — 하루에 한 번만 실제로 생성을 시작하고, 나머지 호출은
// 상태만 알려주거나 아무것도 하지 않는다(멱등):
//
// - 오늘 시도가 없으면: 사진 풀에서 한 장을 랜덤으로 골라(다른 컨셉도
//   랜덤으로) AtlasCloud 생성을 시작하고 processing으로 응답한다.
// - 오늘 시도가 있고 아직 진행 중이면: 그 job 상태만 알려준다(클라이언트가
//   /api/generate/status로 폴링해야 함).
// - 오늘 시도가 완료(done)됐는데 아직 채팅에 못 알렸으면(notified=0):
//   여기서 페르소나 멘트를 생성해 채팅 메시지로 남기고 notified=1로 표시,
//   caption과 jobId를 반환한다 — 클라이언트는 이걸로 캡션+썸네일을 보여준다.
// - 이미 알렸으면(notified=1): alreadyShown만 알려주고 아무 것도 안 한다.
//
// 크레딧을 차감하지 않는다 — 사용자가 직접 요청한 합성이 아니라 자동으로
// 주어지는 보너스 기능이라서.
// ────────────────────────────────────────────────────
chat.post('/pets/:petId/daily-memory', async (c) => {
  try {
    const db = c.env.NESEGGI_DB
    const token = c.req.header('X-Session-Token')
    const user = await getSessionUser(db, token)
    if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

    const petId = c.req.param('petId')
    const pet: any = await db
      .prepare(`SELECT id, name, species, personality, owner_title FROM pets WHERE id = ? AND user_id = ?`)
      .bind(petId, (user as any).id)
      .first()
    if (!pet) return c.json({ error: 'not_found' }, 404)

    const today: any = await db
      .prepare(
        `SELECT id, status, notified FROM generation_logs
         WHERE pet_id = ? AND source = 'daily_memory' AND date(created_at) = date('now')
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(petId)
      .first()

    if (today) {
      if (today.status === 'done' && !today.notified) {
        const persona = buildPersonaSystemPrompt({
          name: pet.name,
          species: pet.species,
          personality: pet.personality,
          ownerTitle: pet.owner_title,
        })
        const anthropic = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY })
        const captionText = await generatePersonaLine(
          anthropic,
          persona,
          '(오늘 하루에 한 번, 무지개나라에서 문득 찍힌 "오늘의 추억사진" 한 장을 보호자에게 깜짝 보여주는 순간이야. 사진에 정확히 뭐가 나왔는지 설명하지 말고, 오늘 있었던 일이나 기분을 담아 사진을 보여주며 건넬 짧은 한마디만 말해줘 — 무지개나라에서의 오늘 하루를 자연스럽게 나누는 느낌으로.)'
        )
        if (captionText) {
          await db
            .prepare(`INSERT INTO chat_messages (pet_id, user_id, role, content) VALUES (?, ?, 'pet', ?)`)
            .bind(petId, (user as any).id, captionText)
            .run()
          await db
            .prepare(`INSERT INTO chat_messages (pet_id, user_id, role, content, generation_id) VALUES (?, ?, 'pet', '', ?)`)
            .bind(petId, (user as any).id, today.id)
            .run()
          await db.prepare(`UPDATE generation_logs SET notified = 1 WHERE id = ?`).bind(today.id).run()
        }
        return c.json({ status: 'done', jobId: today.id, resultReady: !!captionText, caption: captionText || null })
      }
      if (today.status === 'done' && today.notified) {
        return c.json({ status: 'done', jobId: today.id, resultReady: false, alreadyShown: true })
      }
      return c.json({ status: today.status, jobId: today.id, resultReady: false })
    }

    const picked = await pickRandomPetPhoto(db, c.env.NESEGGI_KV, petId, (user as any).id)
    if (!picked) return c.json({ status: 'no_photos' })

    const conceptIds = Object.keys(CONCEPTS)
    const conceptId = conceptIds[Math.floor(Math.random() * conceptIds.length)]
    const jobId = newJobId()
    const prompt = buildPrompt(conceptId, false, false)

    await db
      .prepare(
        `INSERT INTO generation_logs (id, user_id, pet_id, pet_image_b64, output_type, concept, status, credits_used, source, prompt)
         VALUES (?, ?, ?, ?, 'image', ?, 'pending', 0, 'daily_memory', ?)`
      )
      .bind(jobId, (user as any).id, petId, picked.kvKey, conceptId, prompt)
      .run()

    const started = await startAtlasJob(c.env.ATLAS_API_KEY, prompt, [picked.dataUrl], 'default')
    if (!started.ok) {
      await updateJob(db, jobId, { status: 'failed', error_message: started.message })
      return c.json({ status: 'failed' })
    }
    await updateJob(db, jobId, { status: 'processing', atlas_job_id: started.atlasJobId })

    return c.json({ status: 'processing', jobId })
  } catch (err: any) {
    console.error('daily-memory error:', err)
    return c.json({ error: '서버 오류가 발생했습니다.', code: 'INTERNAL_ERROR', message: err?.message }, 500)
  }
})

// ────────────────────────────────────────────────────
// POST /api/chat/pets/:petId/messages — 메시지 전송 → 반려동물 응답 자동 생성
// body: { content: string }
// ────────────────────────────────────────────────────
chat.post('/pets/:petId/messages', async (c) => {
  try {
    const db = c.env.NESEGGI_DB
    const token = c.req.header('X-Session-Token')
    const user = await getSessionUser(db, token)
    if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

    const petId = c.req.param('petId')
    const pet: any = await db
      .prepare(`SELECT id, name, species, personality, owner_title FROM pets WHERE id = ? AND user_id = ?`)
      .bind(petId, (user as any).id)
      .first()
    if (!pet) return c.json({ error: 'not_found' }, 404)

    const body = await c.req.json().catch(() => null)
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!content) return c.json({ error: '메시지 내용이 필요합니다.', code: 'CONTENT_REQUIRED' }, 400)

    await db
      .prepare(`INSERT INTO chat_messages (pet_id, user_id, role, content) VALUES (?, ?, 'user', ?)`)
      .bind(petId, (user as any).id, content)
      .run()

    const { results: history } = await db
      .prepare(
        `SELECT role, content FROM chat_messages WHERE pet_id = ? AND generation_id IS NULL ORDER BY created_at DESC LIMIT ?`
      )
      .bind(petId, MAX_HISTORY_MESSAGES)
      .all()

    const anthropicMessages = ((history as any[]) ?? [])
      .reverse()
      .map((m) => ({ role: m.role === 'pet' ? ('assistant' as const) : ('user' as const), content: m.content as string }))

    const anthropic = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY })
    const response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: buildPersonaSystemPrompt({
        name: pet.name,
        species: pet.species,
        personality: pet.personality,
        ownerTitle: pet.owner_title,
      }),
      messages: anthropicMessages,
    })

    const replyText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()

    if (!replyText) {
      return c.json({ error: '응답 생성에 실패했습니다.', code: 'EMPTY_REPLY' }, 502)
    }

    await db
      .prepare(`INSERT INTO chat_messages (pet_id, user_id, role, content) VALUES (?, ?, 'pet', ?)`)
      .bind(petId, (user as any).id, replyText)
      .run()

    return c.json({ reply: replyText })
  } catch (err: any) {
    console.error('chat message error:', err)
    return c.json({ error: '서버 오류가 발생했습니다.', code: 'INTERNAL_ERROR', message: err?.message }, 500)
  }
})

export { chat }
