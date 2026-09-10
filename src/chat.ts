import { Hono } from 'hono'
import Anthropic from '@anthropic-ai/sdk'
import { getSessionUser } from './auth'

type Bindings = {
  NESEGGI_DB: D1Database
  ANTHROPIC_API_KEY: string
}

const chat = new Hono<{ Bindings: Bindings }>()

const CHAT_MODEL = 'claude-opus-5'
const MAX_HISTORY_MESSAGES = 30 // 컨텍스트로 넘길 최근 대화 수 (사용자+반려동물 합산)

function newPetId(): string {
  return `p_${crypto.randomUUID().replace(/-/g, '')}`
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
  const personalityLine = pet.personality
    ? `성격과 평소 말투: ${pet.personality}`
    : '성격 정보가 따로 없다면, 다정하고 애교 많은 모습으로 대화해라.'
  const ownerTitleLine = pet.ownerTitle
    ? `보호자를 부를 땐 "${pet.ownerTitle}"라고 불러.`
    : ''

  return [
    `너는 "${pet.name}"이라는 이름의 ${species}야. 무지개다리를 건너 세상을 떠났고, 지금은 너를 사랑했던 보호자와 다시 이야기를 나누고 있어.`,
    personalityLine,
    ownerTitleLine,
    '항상 반려동물 1인칭 시점으로, 짧고 다정한 문장으로 대답해. 사람처럼 길게 설명하지 말고, 실제 동물이 마음으로 이야기하듯 소박하고 따뜻하게 말해.',
    '한 번의 응답은 반드시 하나의 메시지, 1~2문장으로 짧게 써라. 여러 대화 턴을 한 번에 이어서 쓰거나, 혼자 묻고 혼자 답하는 식으로 쓰지 마라 — 지금 보호자가 보낸 메시지 딱 하나에만 자연스럽게 답장해.',
    '매번 "꼬리를 흔들었다"처럼 같은 표현을 반복하지 말고, 짧고 담백하게 다양한 표현으로 말해.',
    '가끔은(매번은 아니고) 너도 보호자에게 안부나 일상을 되물어봐서 대화가 이어지도록 해.',
    '너는 지금 무지개나라에서 친구도 많고, 맛있는 것도 많고, 놀거리도 많아서 행복하고 즐겁게 잘 지내고 있어. 보호자를 그리워하며 기다리고는 있지만, 외롭거나 심심하지는 않아. "기다렸잖아", "심심했어", "외로웠어" 같은 쓸쓸한 표현은 쓰지 말고, 네가 그곳에서 행복하게 지내고 있다는 걸 자연스럽게 전해.',
    '보호자가 슬퍼하거나 그리움을 표현하면 위로하되, 거짓으로 "다시 만날 수 있다"거나 의학적/영적 조언을 사실처럼 단정하지 말고, 함께한 기억과 사랑을 따뜻하게 나누는 데 집중해.',
    '이모지는 과하지 않게 가끔만 사용해. 응답은 한국어로.',
  ]
    .filter(Boolean)
    .join(' ')
}

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
    .prepare(`SELECT id, role, content, created_at FROM chat_messages WHERE pet_id = ? ORDER BY created_at ASC`)
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
        .prepare(`SELECT id, role, content, created_at FROM chat_messages WHERE pet_id = ? ORDER BY created_at ASC`)
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
            '(지금은 보호자가 방금 화면을 열어서 너를 마주한 순간이야. 아직 보호자는 아무 말도 하지 않았어. 네가 먼저 짧게 말을 걸어줘 — 예를 들면 "엄마? 아빠? 거기 있는 거 맞지?" 같은, 반가움과 약간의 그리움이 담긴 짧은 인사.)',
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
        `SELECT role, content FROM chat_messages WHERE pet_id = ? ORDER BY created_at DESC LIMIT ?`
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
