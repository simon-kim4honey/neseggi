import { Hono } from 'hono'
import { renderer } from './renderer'
import { auth } from './auth'
import { payments } from './payments'
import { generation } from './generation'
import { admin } from './admin'
import { chat } from './chat'

declare const __BUILD_VERSION__: string

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
  ANTHROPIC_API_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use(renderer)

app.route('/api/auth', auth)
app.route('/payment', payments)
app.route('/api/generate', generation)
app.route('/api/admin', admin)
app.route('/api/chat', chat)

app.get('/', (c) => {
  return c.render(
    <div class="min-h-screen flex items-center justify-center">
      <h1 class="text-2xl font-bold">내새끼 🐾</h1>
    </div>
  )
})

// ────────────────────────────────────────────────────
// /test — QA용 테스트 화면. 실제 서비스는 앱(모바일)이고 이 페이지는 최종
// 사용자 UI가 아니다 — API가 curl 없이도 브라우저에서 수동 검증 가능하도록
// 만든 임시 도구. 로그인/회원가입 → 반려동물 프로필 → 채팅 → 사진 합성까지
// 한 화면에서 확인 가능.
// ────────────────────────────────────────────────────
app.get('/test', (c) => {
  return c.render(
    <>
      <div id="test-app" class="max-w-2xl mx-auto p-4 space-y-6 pb-20">
        <div class="bg-yellow-100 border border-yellow-300 text-yellow-900 text-sm rounded-lg px-3 py-2">
          ⚠️ 이 페이지는 QA용 테스트 화면입니다. 실제 서비스는 앱(모바일)으로 제공됩니다.
        </div>

        <h1 class="text-xl font-bold">내새끼 🐾 테스트 페이지</h1>

        {/* 로그인/회원가입 */}
        <section class="border rounded-xl p-4 space-y-3">
          <h2 class="font-semibold">1. 로그인 / 회원가입</h2>
          <div id="auth-logged-out" class="space-y-2">
            <input id="auth-name" type="text" placeholder="이름 (회원가입 시)" class="w-full border rounded px-3 py-2" />
            <input id="auth-email" type="email" placeholder="이메일" class="w-full border rounded px-3 py-2" />
            <input id="auth-password" type="password" placeholder="비밀번호 (8자 이상)" class="w-full border rounded px-3 py-2" />
            <div class="flex gap-2">
              <button id="btn-signup" class="bg-pink-500 text-white rounded px-4 py-2 flex-1">회원가입</button>
              <button id="btn-login" class="bg-gray-700 text-white rounded px-4 py-2 flex-1">로그인</button>
            </div>
          </div>
          <div id="auth-logged-in" class="hidden items-center justify-between">
            <span class="text-sm">
              <span id="auth-email-display"></span> 로그인됨 · 크레딧 <span id="auth-credits">-</span>
            </span>
            <button id="btn-logout" class="text-sm text-red-600 underline">로그아웃</button>
          </div>
          <p id="auth-message" class="text-sm text-gray-500"></p>
        </section>

        {/* 반려동물 프로필 */}
        <section class="border rounded-xl p-4 space-y-3">
          <h2 class="font-semibold">2. 반려동물 프로필</h2>
          <input id="pet-name" type="text" placeholder="이름 (예: 콩이)" class="w-full border rounded px-3 py-2" />
          <input id="pet-species" type="text" placeholder="종 (예: 강아지)" class="w-full border rounded px-3 py-2" />
          <input id="pet-personality" type="text" placeholder="성격/말투" class="w-full border rounded px-3 py-2" />
          <button id="btn-create-pet" class="bg-pink-500 text-white rounded px-4 py-2">반려동물 등록</button>
          <div>
            <p class="text-sm text-gray-500 mb-1">내 반려동물 (클릭해서 채팅 상대 선택)</p>
            <div id="pet-list" class="flex flex-wrap gap-2"></div>
          </div>
        </section>

        {/* 채팅 */}
        <section class="border rounded-xl p-4 space-y-3">
          <h2 class="font-semibold">
            3. 채팅 — <span id="chat-pet-name" class="text-pink-600">반려동물을 선택하세요</span>
          </h2>
          <div id="chat-messages" class="h-80 overflow-y-auto bg-gray-50 rounded p-3 space-y-2 text-sm"></div>
          <div class="flex gap-2">
            <input id="chat-input" type="text" placeholder="메시지 입력..." class="flex-1 border rounded px-3 py-2" />
            <button id="btn-send-chat" class="bg-pink-500 text-white rounded px-4 py-2">보내기</button>
          </div>
        </section>

        {/* 사진 합성 */}
        <section class="border rounded-xl p-4 space-y-3">
          <h2 class="font-semibold">4. 사진 합성 (부가 기능)</h2>
          <label class="block text-sm">반려동물 사진 (필수)<input id="gen-pet-file" type="file" accept="image/*" class="block w-full mt-1" /></label>
          <label class="block text-sm">보호자 사진 (필수)<input id="gen-owner-file" type="file" accept="image/*" class="block w-full mt-1" /></label>
          <label class="block text-sm">배경 사진 (선택 — 없으면 아래 컨셉 사용)<input id="gen-bg-file" type="file" accept="image/*" class="block w-full mt-1" /></label>
          <select id="gen-concept" class="w-full border rounded px-3 py-2">
            <option value="studio">스튜디오</option>
            <option value="park">공원</option>
            <option value="christmas">크리스마스</option>
          </select>
          <button id="btn-generate" class="bg-pink-500 text-white rounded px-4 py-2">합성 시작 (5크레딧)</button>
          <p id="gen-status" class="text-sm text-gray-500"></p>
          <img id="gen-result" class="hidden w-full rounded border" />
        </section>
      </div>
      <script src={`/static/test.js?v=${__BUILD_VERSION__}`} defer></script>
    </>
  )
})

// TODO(neseggi): 실제 법률 검토 전까지는 placeholder. 내새끼 사업자 정보 확정 후 교체.
app.get('/terms', (c) => c.render(<div class="prose mx-auto p-8">이용약관 — 작성 예정</div>))
app.get('/privacy', (c) => c.render(<div class="prose mx-auto p-8">개인정보처리방침 — 작성 예정</div>))
app.get('/refund-policy', (c) => c.render(<div class="prose mx-auto p-8">환불정책 — 작성 예정</div>))

export default app
