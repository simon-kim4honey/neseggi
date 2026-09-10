import { Hono } from 'hono'

type Bindings = {
  PETLOOK_DB: D1Database
  TOSS_SECRET_KEY: string
}

const payments = new Hono<{ Bindings: Bindings }>()

// 주의(lookbook-ai에서 실전으로 확인된 사항):
// - 토스페이먼츠 개발자센터에서 반드시 "API 개별연동 키"를 발급받아야 한다.
//   "주문서형·결제창형 연동 키"는 클라이언트 SDK(js.tosspayments.com/v2/standard)
//   방식에서 토스가 거부한다.
// - 웹훅(PAYMENT_STATUS_CHANGED)에는 서명 헤더가 없다. 웹훅을 받았다고 바로
//   신뢰하지 말고, 반드시 GET /v1/payments/{paymentKey} 로 결제 상태를 직접
//   재조회한 뒤에만 크레딧을 회수(취소 처리)한다.

// TODO(petlook): 결제 승인 — successUrl에서 호출, 토스 confirm API 호출 후
// payment_logs.status를 'paid'로, users.credits 증가 + credit_logs 기록
payments.get('/toss/success', async (c) => {
  return c.json({ error: 'not_implemented' }, 501)
})

// TODO(petlook): 결제 실패 — failUrl, payment_logs.status를 'failed'로
payments.get('/toss/fail', async (c) => {
  return c.json({ error: 'not_implemented' }, 501)
})

// TODO(petlook): 웹훅 — 반드시 GET /v1/payments/{paymentKey}로 재조회 후 처리
payments.post('/toss/webhook', async (c) => {
  return c.json({ error: 'not_implemented' }, 501)
})

export { payments }
