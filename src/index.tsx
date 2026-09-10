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
// 사용자 UI가 아니다 — API가 curl 없이도 브라우저에서 단계별로(로그인 →
// 우리 아이 프로필 → 보호자 프로필 → 사진 합성 → 채팅) 검증 가능하도록
// 만든 임시 도구. "오늘의 추억사진"(1일1회 자동 생성)이 사용자별로 이어지는
// 기능이라 익명 세션 자동 생성 대신 실제 로그인을 쓴다.
// ────────────────────────────────────────────────────
app.get('/test', (c) => {
  return c.render(
    <>
      <div id="test-app" class="max-w-md mx-auto">
        <div id="progress-dots">
          <span data-group="login"></span>
          <span data-group="pet"></span>
          <span data-group="owner"></span>
          <span data-group="gen"></span>
          <span data-group="chat"></span>
        </div>

        {/* 0. 로그인 */}
        <section id="step-login" class="step step-inner space-y-3" data-group="login">
          <h2 class="text-lg font-bold">로그인</h2>
          <p class="text-xs text-gray-400">⚠️ QA 테스트 화면입니다. 실제 서비스는 앱으로 제공됩니다.</p>
          <input id="login-name" type="text" placeholder="이름 (회원가입 시)" class="input-field" />
          <input id="login-email" type="email" placeholder="이메일" class="input-field" />
          <input id="login-password" type="password" placeholder="비밀번호" class="input-field" />
          <p id="login-error" class="text-xs text-red-500"></p>
          <div class="flex gap-2">
            <button id="login-submit" class="btn-secondary flex-1">로그인</button>
            <button id="signup-submit" class="btn-primary flex-1">회원가입</button>
          </div>
          <div class="flex items-center gap-2 py-1">
            <div class="flex-1 border-t border-gray-200"></div>
            <span class="text-xs text-gray-400">또는</span>
            <div class="flex-1 border-t border-gray-200"></div>
          </div>
          <button id="login-kakao" class="btn-secondary w-full">카카오로 로그인</button>
          <button id="login-google" class="btn-secondary w-full">구글로 로그인</button>
        </section>

        {/* 1. 우리 아이 프로필 */}
        <section id="step-pet" class="step step-inner hidden space-y-3" data-group="pet">
          <h2 class="text-lg font-bold">우리 아이 프로필 🐾</h2>
          <label for="pet-photo" class="photo-drop block">
            <span id="pet-photo-label">반려동물 사진을 올려주세요 (최대 10장)</span>
          </label>
          <input id="pet-photo" type="file" accept="image/*" multiple class="hidden" />
          <div id="pet-photo-grid" class="flex flex-wrap gap-2"></div>
          <p id="pet-photo-count" class="text-xs text-gray-400"></p>
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
          <div class="flex flex-wrap gap-2 justify-between items-center pt-2">
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
          <div class="flex flex-wrap gap-2 justify-between items-center pt-2">
            <button id="step-owner-photo-back" class="btn-ghost">이전단계</button>
            <div class="flex flex-wrap gap-2">
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
          <div class="flex flex-wrap gap-2 justify-between items-center pt-2">
            <button id="step-bg-photo-back" class="btn-ghost">이전단계</button>
            <div class="flex flex-wrap gap-2">
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
          {/* AtlasCloud 응답 지연/타임아웃으로 생성 시작 자체가 실패하면 이
              버튼만 보여준다 — 실패해도 재시도할 방법이 없어 막다른 화면에
              갇히는 문제가 있었음 */}
          <button id="gen-retry" class="btn-primary hidden">다시 시도하기</button>
        </section>

        {/* 4. 채팅 */}
        <section id="step-chat" class="step step-inner hidden space-y-3 pb-20" data-group="chat">
          {/* 카카오톡처럼 상단바(프로필 사진+이름 / 메뉴 버튼)를 두고, 앞으로
              추가되는 기능들은 계속 이 메뉴 안에 넣는다. */}
          <div class="flex items-center justify-between pb-2 border-b border-gray-100 -mt-1">
            <div class="flex items-center gap-2 min-w-0">
              <img id="chat-header-avatar" class="w-9 h-9 rounded-full object-cover border cursor-pointer flex-shrink-0" />
              <span id="chat-header-name" class="font-semibold text-sm truncate"></span>
            </div>
            <div class="relative flex-shrink-0">
              <button id="chat-menu-btn" class="text-xl leading-none px-2 py-1 text-gray-500" aria-label="메뉴">
                ☰
              </button>
              <div
                id="chat-menu-dropdown"
                class="hidden absolute right-0 mt-1 w-44 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-10"
              >
                <button id="menu-profile" class="w-full text-left px-4 py-2 text-sm hover:bg-gray-50">
                  사용자 프로필
                </button>
                <button id="menu-photo-album" class="w-full text-left px-4 py-2 text-sm hover:bg-gray-50">
                  사진첩
                </button>
                <div class="border-t border-gray-100 my-1"></div>
                <button id="menu-logout" class="w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-red-50">
                  로그아웃
                </button>
              </div>
            </div>
          </div>

          {/* 메시지 영역은 뷰포트 높이 기준으로 최대 높이를 제한하고 내부에서만
              스크롤되게 한다. 합성된 사진은 별도 큰 이미지가 아니라 반려동물
              메시지의 썸네일로 온다. */}
          <div id="chat-scroll" class="max-h-[50vh] overflow-y-auto space-y-3 pr-1">
            <div id="chat-messages" class="p-3 space-y-2 text-sm"></div>
          </div>
          {/* 입력창은 화면(뷰포트) 가장 아래에 고정 — 스크롤을 해도 항상
              같은 자리에 보이도록 position: fixed(style.css의 .chat-input-bar). */}
          <div class="chat-input-bar flex gap-2">
            <input id="chat-input" type="text" placeholder="메시지 입력..." class="input-field flex-1" />
            <button id="chat-send" class="btn-primary">보내기</button>
          </div>
        </section>

        {/* 5. 사진첩 — 이 사용자가 지금까지 생성한 사진 전체(수동 합성 +
            오늘의 추억사진)를 최신순으로 보여준다 */}
        <section id="step-photo-album" class="step step-inner hidden space-y-3" data-group="chat">
          <div class="flex justify-between items-center">
            <h2 class="text-lg font-bold">사진첩 📷</h2>
            <button id="photo-album-back" class="btn-ghost text-xs underline">채팅으로 돌아가기</button>
          </div>
          <div id="photo-album-grid" class="grid grid-cols-3 gap-2"></div>
          <p id="photo-album-empty" class="hidden text-sm text-gray-400 text-center py-8">
            아직 생성된 사진이 없어요.
          </p>
        </section>

        {/* 6. 사용자 프로필 — 앞으로 추가될 사용자 관련 기능들의 시작점 */}
        <section id="step-profile" class="step step-inner hidden space-y-3" data-group="chat">
          <div class="flex justify-between items-center">
            <h2 class="text-lg font-bold">사용자 프로필</h2>
            <button id="profile-back" class="btn-ghost text-xs underline">채팅으로 돌아가기</button>
          </div>
          <div class="space-y-2 text-sm bg-white rounded-2xl p-4 border border-gray-100">
            <div class="flex justify-between">
              <span class="text-gray-400">이름</span>
              <span id="profile-name"></span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">이메일</span>
              <span id="profile-email"></span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">로그인 방식</span>
              <span id="profile-provider"></span>
            </div>
          </div>
          <button id="profile-restart" class="btn-secondary w-full">처음부터 다시 시작</button>
        </section>
      </div>

      {/* 썸네일 클릭 시 큰 이미지로 보여주는 라이트박스 */}
      <div id="image-lightbox" class="hidden lightbox-overlay">
        <img id="image-lightbox-img" />
      </div>

      <script src={`/static/test.js?v=${__BUILD_VERSION__}`} defer></script>
    </>
  )
})

// ────────────────────────────────────────────────────
// /admin — 관리자 전용 페이지. 지금은 사진 합성 job 목록 + AtlasCloud에
// 실제로 전달된 프롬프트 전문을 확인하는 용도만 있다(CLAUDE.md의 "AI 생성
// 프롬프트는 조용히 망가질 수 있다" 경고 대응 — 코드 리뷰가 아니라 실제
// 런타임 값을 직접 확인할 수 있게). X-Admin-Password 헤더로 인증하며,
// 브라우저가 커스텀 헤더를 못 보내는 GET 링크는 없으므로 이 페이지가 매
// 요청에 헤더를 붙여 fetch한다.
// ────────────────────────────────────────────────────
app.get('/admin', (c) => {
  return c.render(
    <div id="admin-app" class="max-w-2xl mx-auto p-4 space-y-4">
      <h1 class="text-xl font-bold">내새끼 관리자</h1>

      <div id="admin-login" class="space-y-2">
        <input id="admin-password" type="password" placeholder="관리자 비밀번호" class="input-field" />
        <button id="admin-login-btn" class="btn-primary">확인</button>
        <p id="admin-login-error" class="text-xs text-red-500"></p>
      </div>

      <div id="admin-content" class="hidden space-y-3">
        <div class="flex justify-between items-center">
          <h2 class="text-base font-semibold">사진 합성 프롬프트</h2>
          <div class="flex gap-2">
            <button id="admin-refresh" class="btn-secondary text-xs">새로고침</button>
            <button id="admin-logout" class="btn-ghost text-xs underline">로그아웃</button>
          </div>
        </div>
        <div id="admin-list" class="space-y-3"></div>
      </div>

      <script src={`/static/admin.js?v=${__BUILD_VERSION__}`} defer></script>
    </div>
  )
})

// TODO(neseggi): 실제 법률 검토 전까지는 placeholder. 내새끼 사업자 정보 확정 후 교체.
app.get('/terms', (c) => c.render(<div class="prose mx-auto p-8">이용약관 — 작성 예정</div>))
app.get('/privacy', (c) => c.render(<div class="prose mx-auto p-8">개인정보처리방침 — 작성 예정</div>))
app.get('/refund-policy', (c) => c.render(<div class="prose mx-auto p-8">환불정책 — 작성 예정</div>))

export default app
