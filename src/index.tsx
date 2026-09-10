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
// 사용자 UI가 아니다 — API가 curl 없이도 브라우저에서 단계별로(우리 아이
// 프로필 → 보호자 프로필 → 사진 합성 → 채팅) 검증 가능하도록 만든 임시 도구.
// 로그인 화면 없음 — 접속하면 내부적으로 익명 세션을 자동 생성한다.
// ────────────────────────────────────────────────────
app.get('/test', (c) => {
  return c.render(
    <>
      <div id="test-app" class="max-w-md mx-auto">
        <div id="progress-dots">
          <span data-group="pet"></span>
          <span data-group="owner"></span>
          <span data-group="gen"></span>
          <span data-group="chat"></span>
        </div>

        {/* 1. 우리 아이 프로필 */}
        <section id="step-pet" class="step step-inner space-y-3" data-group="pet">
          <h2 class="text-lg font-bold">우리 아이 프로필 🐾</h2>
          <label for="pet-photo" class="photo-drop block">
            <img id="pet-photo-preview" class="hidden photo-preview mx-auto mb-2" />
            <span id="pet-photo-label">반려동물 사진을 올려주세요</span>
          </label>
          <input id="pet-photo" type="file" accept="image/*" class="hidden" />
          <p id="pet-species-hint" class="text-xs text-gray-400 -mt-1"></p>
          <input id="pet-name" type="text" placeholder="이름 (예: 콩이)" class="input-field" />
          <input id="pet-personality" type="text" placeholder="성격/말투" class="input-field" />
          <div class="flex justify-end pt-1">
            <button id="step-pet-next" class="btn-primary">다음단계</button>
          </div>
        </section>

        {/* 2. 보호자 프로필 — 호칭 */}
        <section id="step-title" class="step step-inner hidden space-y-3" data-group="owner">
          <h2 class="text-lg font-bold">저를 뭐라고 부를까요?</h2>
          <div id="title-options" class="flex flex-wrap gap-2"></div>
          <input id="title-custom" type="text" placeholder="직접 입력 (예: 지수)" class="input-field" />
          <div class="flex justify-between pt-2">
            <button id="step-title-back" class="btn-ghost">이전단계</button>
            <button id="step-title-next" class="btn-primary">다음단계</button>
          </div>
        </section>

        {/* 2. 보호자 프로필 — 보호자 사진 */}
        <section id="step-owner-photo" class="step step-inner hidden space-y-3" data-group="owner">
          <h2 class="text-lg font-bold">보호자 사진을 넣어주세요</h2>
          <p class="text-sm text-gray-500">우리 아이와 함께 있는 사진이 생겨요</p>
          <label for="owner-photo" class="photo-drop block">
            <img id="owner-photo-preview" class="hidden photo-preview mx-auto mb-2" />
            <span id="owner-photo-label">사진 선택하기</span>
          </label>
          <input id="owner-photo" type="file" accept="image/*" class="hidden" />
          <div class="flex justify-between pt-2">
            <button id="step-owner-photo-back" class="btn-ghost">이전단계</button>
            <div class="flex gap-2">
              <button id="step-owner-photo-skip" class="btn-secondary">넣지 않아도 괜찮아요</button>
              <button id="step-owner-photo-next" class="btn-primary">다음단계</button>
            </div>
          </div>
        </section>

        {/* 2. 보호자 프로필 — 배경 사진 */}
        <section id="step-bg-photo" class="step step-inner hidden space-y-3" data-group="owner">
          <h2 class="text-lg font-bold">우리집 또는 자주 가는 장소를 올려주세요</h2>
          <p class="text-sm text-gray-500">우리 아이가 그곳에 있는 사진이 생겨요</p>
          <label for="bg-photo" class="photo-drop block">
            <img id="bg-photo-preview" class="hidden photo-preview mx-auto mb-2" />
            <span id="bg-photo-label">사진 선택하기</span>
          </label>
          <input id="bg-photo" type="file" accept="image/*" class="hidden" />
          <div class="flex justify-between pt-2">
            <button id="step-bg-photo-back" class="btn-ghost">이전단계</button>
            <div class="flex gap-2">
              <button id="step-bg-photo-skip" class="btn-secondary">넣지 않아도 괜찮아요</button>
              <button id="step-bg-photo-next" class="btn-primary">다음단계</button>
            </div>
          </div>
        </section>

        {/* 3. 사진 합성 진행 중 */}
        <section id="step-generating" class="step step-inner hidden text-center space-y-3 py-16" data-group="gen">
          <div class="loading-paw">🐾</div>
          <p class="text-lg font-medium">무지개 나라에서 우리 아이를 부르고 있어요..</p>
          <p id="gen-status-text" class="text-sm text-gray-400"></p>
        </section>

        {/* 4. 채팅 */}
        <section id="step-chat" class="step step-inner hidden space-y-3 pb-28" data-group="chat">
          <div id="chat-messages" class="h-80 overflow-y-auto p-3 space-y-2 text-sm"></div>
          <div class="flex gap-2">
            <input id="chat-input" type="text" placeholder="메시지 입력..." class="input-field flex-1" />
            <button id="chat-send" class="btn-primary">보내기</button>
          </div>
          <button id="restart" class="btn-ghost text-xs underline">처음부터 다시 시작</button>
        </section>
      </div>

      {/* 채팅 화면 하단에 고정으로 떠 있는 합성 이미지 */}
      <div id="chat-hero-image-wrap" class="hidden fixed bottom-0 left-0 right-0 border-t shadow-lg p-2 flex justify-center z-10">
        <img id="chat-hero-image" class="photo-preview" style="width:64px;height:64px" />
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
