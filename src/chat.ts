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
function buildPersonaSystemPrompt(pet: { name: string; species: string | null; personality: string | null }): string {
  const species = pet.species || '반려동물'
  const personalityLine = pet.personality
    ? `성격과 평소 말투: ${pet.personality}`
    : '성격 정보가 따로 없다면, 다정하고 애교 많은 모습으로 대화해라.'

  return [
    `너는 "${pet.name}"이라는 이름의 ${species}야. 무지개다리를 건너 세상을 떠났고, 지금은 너를 사랑했던 보호자와 다시 이야기를 나누고 있어.`,
    personalityLine,
    '항상 반려동물 1인칭 시점으로, 짧고 다정한 문장으로 대답해. 사람처럼 길게 설명하지 말고, 실제 동물이 마음으로 이야기하듯 소박하고 따뜻하게 말해.',
    '가끔은 너도 보호자에게 안부나 일상을 되물어봐서 대화가 이어지도록 해 — 항상 대답만 하지 말고, 자연스럽게 질문도 섞어.',
    '보호자가 슬퍼하거나 그리움을 표현하면 위로하되, 거짓으로 "다시 만날 수 있다"거나 의학적/영적 조언을 사실처럼 단정하지 말고, 함께한 기억과 사랑을 따뜻하게 나누는 데 집중해.',
    '이모지는 과하지 않게 가끔만 사용해. 응답은 한국어로.',
  ].join(' ')
}

// ────────────────────────────────────────────────────
// POST /api/chat/pets — 반려동물 프로필 생성
// body: { name, species?, personality?, avatarUrl? }
// ────────────────────────────────────────────────────
chat.post('/pets', async (c) => {
  try {
    const db = c.env.NESEGGI_DB
    const token = c.req.header('X-Session-Token')
    const user = await getSessionUser(db, token)
    if (!user) return c.json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' }, 401)

    const body = await c.req.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const species = typeof body?.species === 'string' ? body.species.trim() : null
    const personality = typeof body?.personality === 'string' ? body.personality.trim() : null
    const avatarUrl = typeof body?.avatarUrl === 'string' ? body.avatarUrl : null

    if (!name) return c.json({ error: '반려동물 이름이 필요합니다.', code: 'NAME_REQUIRED' }, 400)

    const petId = newPetId()
    await db
      .prepare(
        `INSERT INTO pets (id, user_id, name, species, personality, avatar_url, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`
      )
      .bind(petId, (user as any).id, name, species, personality, avatarUrl)
      .run()

    return c.json({ pet: { id: petId, name, species, personality, avatarUrl } }, 201)
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
      .prepare(`SELECT id, name, species, personality FROM pets WHERE id = ? AND user_id = ?`)
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
      system: buildPersonaSystemPrompt(pet),
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
