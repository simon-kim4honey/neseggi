import { Hono } from 'hono'
import { renderer } from './renderer'
import { auth } from './auth'
import { payments } from './payments'
import { generation } from './generation'
import { admin } from './admin'

type Bindings = {
  NESEGGI_DB: D1Database
  NESEGGI_KV: KVNamespace
  TOSS_SECRET_KEY: string
  ADMIN_PASSWORD: string
  KAKAO_CLIENT_ID: string
  KAKAO_CLIENT_SECRET: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  ATLAS_API_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use(renderer)

app.route('/api/auth', auth)
app.route('/payment', payments)
app.route('/api/generate', generation)
app.route('/api/admin', admin)

app.get('/', (c) => {
  return c.render(
    <div class="min-h-screen flex items-center justify-center">
      <h1 class="text-2xl font-bold">내새끼 🐾</h1>
    </div>
  )
})

// TODO(neseggi): 실제 법률 검토 전까지는 placeholder. 내새끼 사업자 정보 확정 후 교체.
app.get('/terms', (c) => c.render(<div class="prose mx-auto p-8">이용약관 — 작성 예정</div>))
app.get('/privacy', (c) => c.render(<div class="prose mx-auto p-8">개인정보처리방침 — 작성 예정</div>))
app.get('/refund-policy', (c) => c.render(<div class="prose mx-auto p-8">환불정책 — 작성 예정</div>))

export default app
