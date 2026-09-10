import { Hono } from 'hono'

type Bindings = {
  NESEGGI_DB: D1Database
  NESEGGI_KV: KVNamespace
}

const generation = new Hono<{ Bindings: Bindings }>()

// AI 생성 파이프라인 패턴 (lookbook-ai와 동일):
// 업로드 → 비동기 job 생성(즉시 202 + job id) → 클라이언트가 폴링 →
// 완료 시 결과 URL 반환. 동기 응답으로 처리하면 생성 수초~수십초 소요로
// 타임아웃/UX 문제가 생기기 때문.
//
// 내새끼 입력 조합은 lookbook-ai(의류+모델+배경 3-슬롯)와 다르게
// "보호자 사진 + 반려동물 사진" 2-슬롯(또는 반려동물 사진 1장)이라
// job payload/프롬프트 구조는 AI API 계약 확정 후 별도 설계 필요.

// TODO(neseggi): 생성 시작 — 크레딧 차감(credit_logs) + generation_logs row 생성 + job 큐잉
generation.post('/start', async (c) => {
  return c.json({ error: 'not_implemented' }, 501)
})

// TODO(neseggi): 상태 폴링
generation.get('/status/:jobId', async (c) => {
  return c.json({ error: 'not_implemented' }, 501)
})

export { generation }
