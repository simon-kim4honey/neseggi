# 내새끼 (neseggi)

Cloudflare Workers/Pages + Hono + D1 + KV. EZlook(lookbook-ai)와 동일한
아키텍처 패턴을 따르는 별도 서비스.

## 제품 정체성 — "사진 합성 서비스"가 아니다

이 백엔드는 **웹이 아니라 앱 서비스**의 API 서버다. 핵심 기능은 사진 합성이
아니라 **채팅**이다:

- 사용자(반려동물 보호자)와, 무지개다리를 건넌(세상을 떠난) 반려동물과의
  대화를 나누는 채팅 앱이 본체다.
- 반려동물 쪽 메시지는 사람이 입력하는 게 아니라 **Claude API(`claude-opus-5`)가
  자동으로 질문/답변을 생성**해서 채팅창에 보낸다 (`src/chat.ts`).
- 세계관: 세상을 떠난 반려동물은 무지개나라에서 친구도 많고 맛있는 것도 많고
  놀거리도 많아서 행복하게 잘 지내고 있다. 보호자를 그리워하며 기다리고는
  있지만 외롭거나 심심하지는 않다 — "기다렸잖아", "심심했어" 같은 쓸쓸한
  표현은 페르소나 프롬프트에서 명시적으로 금지되어 있다.
- 보호자 사진 + 반려동물 사진 + 배경 사진 합성(`src/generation.ts`,
  AtlasCloud `google/nano-banana-2/edit`)은 채팅의 **부가 기능** — 반려동물
  프로필 대표 이미지를 만들어주는 용도로 쓰인다(온보딩 위저드에서 반려동물
  프로필 → 보호자 프로필 → 합성 → 채팅 순으로 이어짐).
- 가입 플로우: 사용자가 (본인/반려동물/배경) 사진을 입력하는 시점에 로그인이
  안 돼 있으면 그때 신규 가입 화면이 뜬다(선가입 후사용이 아니라, 사진 입력
  →필요시 가입 →계속). 실제 앱은 아직 이 자동 가입 UX를 어떻게 구현할지
  미정 — 다음 세션에서 확인.
- **`/test`는 더 이상 익명 세션을 자동 생성하지 않는다(2026-09-10 복원)** —
  "오늘의 추억사진"(아래 참고)이 사용자별로 하루하루 이어지는 기능이라
  매번 새로 만들어지는 익명 계정으로는 확인할 수 없어서, 실제 로그인 화면
  (이메일 로그인/회원가입 + 카카오/구글)을 다시 붙였다. `step-login`이
  첫 단계.

## 아키텍처

lookbook-ai와 달리 `src/index.tsx`는 얇게 유지하고, 도메인별로 파일을 분리해
`app.route()`로 마운트한다: `auth.ts`(인증/세션 — 이메일+카카오+구글 구현
완료), `payments.ts`(토스/Stripe 결제 — 501 스텁, 미구현), `generation.ts`
(AI 사진 합성), `admin.ts`(관리자 API — 회원/결제/크레딧 관리는 아직 스텁,
반려동물 사진 풀 조회 + 사진 합성 job/프롬프트 열람은 구현됨), `chat.ts`
(반려동물 채팅, `@anthropic-ai/sdk` 사용).

`/admin`(`admin.ts` API + `public/static/admin.js`)은 관리자 전용 페이지 —
`X-Admin-Password` 헤더 인증(비밀번호는 페이지에서 입력하면 localStorage에
저장, 매 요청에 헤더로 붙여 보냄). 탭 2개: (1) 사진 합성 job 목록 +
AtlasCloud에 실제로 전달된 프롬프트 전문(`generation_logs.prompt`,
`migrations/0011`) — 프롬프트가 리팩터링 중 조용히 깨지는 사고(아래 경고
참고)를 코드가 아니라 실제 런타임 값으로 확인할 수 있게 하려는 목적. (2)
Claude API 사용자별 사용량/추정 비용(`GET /api/admin/claude-usage`, 아래
"Claude API 사용량/비용 추적" 참고).

`/test` (`src/index.tsx` + `public/static/test.js`)는 curl 없이 브라우저에서
전체 흐름(반려동물 프로필 → 보호자 프로필/호칭/사진/배경사진 → 합성 → 채팅)을
확인할 수 있는 QA 전용 페이지. 실제 앱 UI가 아니다.

## 사진 합성은 크레딧 차감 없이 전부 무료 (2026-09-10 결정)

`generation.ts`의 `/start`는 크레딧 체크/차감을 하지 않는다 — 사진 합성을
포함해 전부 무료로 제공하고, 수익화는 **월정액 구독**으로 할 예정(아직
미구현, 아래 "아직 안 한 것" 참고). 예전엔 결제 시스템이 붙기 전까지 쓰는
임시 장치로 `/test`가 보내는 `X-Neseggi-QA` 헤더로만 크레딧 차감을
우회했었는데, 이제 전부 무료라 그 우회 장치 자체를 제거함 — 관련 코드
(`isQaTest` 분기, 크레딧 차감/환불 로직)는 삭제됐다. `generation_logs.credits_used`
컬럼은 스키마상 남아있지만 항상 0이 기록된다. `users.credits`/`credit_logs`는
가입 보너스 등 다른 용도로 여전히 존재하지만 사진 합성 게이팅에는 안 쓰임 —
구독제를 실제로 붙일 때 이 크레딧 시스템을 재사용할지 새로 설계할지는
다음 세션에서 결정.

## ⚠️ AI 생성 프롬프트는 조용히 망가질 수 있다

`src/generation.ts`(사진 합성)와 `src/chat.ts`(반려동물 페르소나)의 프롬프트
문자열이 결과물 품질/서비스의 정서적 핵심을 직접 좌우한다. lookbook-ai에서
실제로 겪은 사고(프롬프트 리팩터링 중 핵심 지시문이 반대 의미로 바뀌었는데
빌드/배포/로그 어디에도 안 남고 사용자 리포트로만 발견됨)와 동일한 위험이
있다.

- `npm run build`는 `scripts/verify-critical-prompts.mjs`를 먼저 실행해서
  `src/generation.ts`의 GUARDS 문구가 살아있는지 확인한다(현재 4개 등록됨:
  반려동물/보호자 생김새 보존, 배경 사진 레퍼런스 제한 2건). **이 가드는
  `generation.ts`만 확인하고 `chat.ts`는 검사하지 않는다** — 채팅 페르소나
  프롬프트는 자동 가드가 없으니 고칠 때 더 조심할 것.
- 새로운 "절대 지켜야 하는" 문구를 `generation.ts`에 추가하면 반드시
  `GUARDS` 배열에도 등록할 것. 가드는 문구 "존재 여부"만 확인하지 의미
  전체를 검증하지 않는다 — 문구가 있다고 안심하지 말고 직접 읽고 의미를
  확인할 것.
- 다른 것을 리팩터링하다가 프롬프트 문자열이 눈에 띄어도, 요청받지 않았다면
  손대지 말 것.
- 프롬프트를 의도적으로 바꿀 때는 바꾸기 전/후 문구를 나란히 보여주고 무엇이
  왜 바뀌는지 설명할 것 (`chat.ts`도 동일 원칙 적용 — 자동 가드는 없지만
  원칙은 같음).
- `generation.ts`의 `buildPrompt`는 반려동물 사진(필수)/보호자 사진(선택)/
  배경 사진(선택) 조합 4가지를 모두 지원한다. 배경 사진이 있을 때 생김새
  보존 규칙을 배경 지시문보다 뒤(출력 직전)에 배치하는 게 중요 — 순서를
  앞으로 옮기면 2026-09-10에 재현됐던 "배경 때문에 인물 얼굴이 바뀌고
  동물 크기가 커지는" 문제가 다시 생길 수 있다.

## 재사용한 스키마 (lookbook-ai 기반, 거의 그대로) + 신규 스키마

- `users`, `user_sessions` — 이메일/카카오/구글 인증 (`migrations/0001`)
- `credit_logs` — 크레딧 증감 원장 (`migrations/0002`)
- `payment_logs` — 토스페이먼츠/Stripe 결제 내역 (`migrations/0003`, 아직
  실제 결제 라우트 미구현이라 미사용)
- `generation_logs` — 사진 합성 job (`migrations/0004~0006`). 원본 이미지는
  D1이 아니라 KV(`gen_input:{jobId}:{pet|owner|background}`, 14일 TTL)에
  저장하고 D1엔 KV 키만 기록 — 큰 base64 값을 D1 컬럼에 직접 넣으면 값 크기
  제한에 걸려 500 에러가 난다(2026-09-10 실사진 테스트에서 확인). `atlas_job_id`
  컬럼(`0006`)에 AtlasCloud job id를 저장해서, `/status` 폴링마다 그 요청 안에서
  직접 조회한다(아래 "waitUntil은 이 환경에서 신뢰할 수 없다" 참고).
- `pets` (`migrations/0007`, `0008`) — 반려동물 프로필(이름/종/성격/대표사진/
  `owner_title`=보호자를 부르는 호칭)
- `chat_messages` (`migrations/0007`) — 대화 이력(`role`: `user`|`pet`)
- `pet_photos` (`migrations/0009`) — 반려동물 참고 사진 풀(최대 10장,
  `MAX_PET_PHOTOS` in `chat.ts`). 온보딩 때 `POST /api/chat/pets/:petId/photos`로
  올린 사진들을 KV(`pet_photo:{petId}:{photoId}`)에 **TTL 없이 영구** 저장
  (gen_input의 14일 TTL과 다름 — 계속 재사용돼야 하는 자료라서). 사진
  합성(`/api/generate/start`)과 "오늘의 추억사진"(아래) 둘 다 이 풀에서
  매번 한 장을 랜덤으로 골라 쓴다(`generation.ts`의 `pickRandomPetPhoto`).
- `generation_logs.pet_id` / `.source` / `.notified` (`migrations/0010`) —
  기존 `generation_logs`에 반려동물 연결 + 수동(`manual`)/자동(`daily_memory`)
  구분 + 채팅에 알렸는지(`notified`) 추가. "오늘의 추억사진" 1일1회 체크에
  씀(같은 `pet_id`+`source='daily_memory'`로 오늘 날짜 row가 있는지 확인).
- `generation_logs.prompt` (`migrations/0011`) — AtlasCloud에 실제로 전달된
  프롬프트 전문. `/admin`에서 확인 가능(아래 참고).
- `chat_messages.generation_id` (`migrations/0012`) — 채팅 속 사진 썸네일을
  대화 이력에 영구 저장하기 위한 컬럼. `content`는 빈 문자열, `generation_id`가
  어느 `generation_logs` job의 결과인지를 가리킴 — 클라이언트가 이 값이 있는
  메시지는 텍스트 대신 `avatar-proxy?jobId=...`로 썸네일을 렌더링한다. 이
  컬럼이 생기기 전엔 썸네일이 순전히 클라이언트 상태로만 표시돼서 채팅을
  나갔다 다시 들어오면 사라지는 문제가 있었음(2026-09-10 수정) — 대화 상대
  API(`/messages` POST가 Claude에 보내는 히스토리)는 `generation_id IS NULL`
  조건으로 이 빈 텍스트 row들을 걸러낸다.
- `chat_messages.image_kv_key` (`migrations/0013`) — 사용자가 채팅에 직접
  첨부해서 보낸 사진. KV에 원본(data URL)을 영구 저장하고 D1엔 키만 기록
  (pet_photos와 동일 패턴). `GET /pets/:petId/messages/:messageId/image`로
  스트리밍.
- `claude_usage_logs` (`migrations/0014`) — Claude API 사용량 원장. 아래
  "Claude API 사용량/비용 추적" 참고.

## 채팅 속 사진 (2026-09-10 추가)

두 가지 방향의 사진이 채팅에 등장하고, 처리 방식이 다르다:
- **반려동물 → 보호자**: 사진 합성/오늘의 추억사진 결과. `generation_id`로
  연결, 실제 픽셀은 그때그때 AtlasCloud 결과 URL을 프록시로 스트리밍.
- **보호자 → 반려동물**: `POST /pets/:petId/messages`에 `image`(data URL)를
  같이 보내면, 반려동물이 **Claude 비전으로 그 턴에 한해서만** 실제로
  "보고" 반응한다 — `buildPersonaSystemPrompt`에 사진을 보면 자연스럽게
  알아보고 반응하라는 지시문 추가됨(단, 평소 하늘에서 지켜본다는 세계관과는
  구분해서 서술 — "사진을 직접 보내면 그건 다르다"). 과거에 보낸 사진은
  다음 턴부터 Claude에 다시 픽셀을 보내지 않고 "[사진을 보냈어]" 텍스트로만
  대화 맥락에 남긴다(비용/복잡도 절약) — `image_kv_key`가 있는 과거 메시지는
  `content`에 이 표시를 붙여서 히스토리에 넣는다.

## "오늘의 추억사진" (1일1회 자동 생성, 2026-09-10 추가)

사용자가 채팅에 들어올 때마다(`enterChat()` → `checkDailyMemory()`)
`POST /api/chat/pets/:petId/daily-memory`를 호출한다. 이 엔드포인트가
체크+시작+마무리를 다 겸함(멱등) — 오늘 시도가 없으면 사진 풀에서 랜덤으로
한 장 + 랜덤 컨셉으로 새 생성을 시작하고, 이미 있으면 상태에 따라 폴링을
유도하거나(processing) 완료된 걸 채팅에 한 번만 알린다(notified 플래그).
크레딧을 차감하지 않는다(자동으로 주어지는 보너스 기능이라서). 채팅
메시지로는 페르소나 캡션 텍스트 row + 이미지 메시지 row(`generation_id`)가
같이 남아서, 나중에 채팅을 다시 열어도(새로고침 등) 썸네일이 재구성된다.

어드민 전용 조회: `GET /api/admin/users/:userId/pets`(사진 풀 장수 포함),
`GET /api/admin/pets/:petId/photos`(목록), `GET /api/admin/pets/:petId/photos/:photoId/image`
(실제 이미지, KV에서 디코딩해서 스트리밍) — `X-Admin-Password` 헤더 필요.

## 사진첩 (2026-09-10 추가)

`GET /api/chat/photo-album` — 로그인한 사용자가 지금까지 생성한 사진 전체
(수동 합성 + 오늘의 추억사진, `status='done'`인 `generation_logs`를
`user_id` 기준으로 전부)를 최신순으로 반환. `/test`의 채팅 화면에서 "사진첩
보기" 버튼(`step-photo-album`)으로 그리드로 보여주고, 각 항목은 avatar-proxy
(`/pets/:petId/avatar-proxy?jobId=...`)로 렌더링 — 새 프록시를 따로 만들지
않고 기존 걸 재사용함.
아직 별도의 시각적 어드민 페이지는 없음(JSON API만) — 있으면 좋겠으면
다음 세션에서 요청할 것.

## Claude API 사용량/비용 추적 (2026-09-10 추가)

Claude API가 유료로 과금되고 있어서, `chat.ts`가 `anthropic.messages.create()`를
호출하는 4곳 전부(`classify-species`, `greeting`, `photo-caption`/
`daily-memory`가 공유하는 `generatePersonaLine`, 메인 채팅 응답) 응답의
`response.usage`(input/output/cache_creation/cache_read 토큰)를
`claude_usage_logs`(`migrations/0014`)에 기록한다 — `logClaudeUsage()`
헬퍼, 실패해도 채팅 흐름은 막지 않고 로그만 남기고 삼킴. `purpose` 컬럼으로
호출 용도를 구분한다.

`GET /api/admin/claude-usage`(query: `from`/`to`, `YYYY-MM-DD`)가 사용자별로
토큰 합계 + 추정 비용(USD)을 계산해서 반환 — `/admin` 페이지의 "Claude API
사용량" 탭에서 조회 가능. 비용은 `admin.ts`의 `MODEL_PRICING_PER_MTOK`
단가표(현재 `claude-opus-5` 기준 입력 $5/output $25 per 1M, 캐시 쓰기/읽기는
입력 단가의 1.25배/0.1배로 환산)로 계산한 **추정치**다 — 실제 Anthropic
청구서와 소폭 오차가 있을 수 있다. 모델을 바꾸거나 새 모델을 추가하면 이
단가표도 같이 업데이트할 것(현재 `CHAT_MODEL`은 항상 `claude-opus-5`라
사실상 한 가지 단가만 쓰임).

### 비용 절감 조치 (2026-09-11)

`/admin` "Claude API 사용량" 탭에서 입력 토큰이 출력 토큰의 수십 배로 비쌌던
걸 확인하고 적용한 조치 3가지 — 전부 채팅 응답 자체의 품질(페르소나
말투)에는 손대지 않음:

- **이미지 리사이즈** (`public/static/test.js`의 `normalizeImageFile`) —
  포맷 변환만 하고 원본 해상도 그대로 보내던 걸, 항상 캔버스를 거쳐 긴 변
  기준 `MAX_IMAGE_DIMENSION`(1024px)으로 축소해서 전송하도록 바꿈. 반려동물/
  보호자/배경 사진(합성용)과 채팅 첨부 사진이 전부 이 함수 하나를 거치므로
  한 곳만 고쳐서 전체에 적용됨. 휴대폰 사진은 보통 3000px+라 비전 토큰이
  크게 줄어듦.
- **페르소나 시스템 프롬프트 캐싱** (`chat.ts`의 `cachedSystemPrompt()`) —
  `generatePersonaLine`(photo-caption/daily-memory-caption), `greeting`,
  메인 채팅 응답 3곳 모두 시스템 프롬프트에 `cache_control: {type:
  'ephemeral'}`을 붙임. 같은 반려동물이면 호출마다 토씨 하나 안 틀리고
  동일한 프롬프트라 캐시 적중 시 그 분량은 최대 90%까지 싸짐. 기본 TTL이
  5분이라 짧은 시간 안에 이어지는 호출(같은 채팅 세션 안에서 여러 번 답장)
  에서만 효과가 있음 — 하루 한 번뿐인 daily-memory 같은 호출은 이득이
  없지만 손해도 없음.
- **`classify-species`를 `claude-haiku-4-5`로 전환** (`chat.ts`의
  `UTILITY_MODEL`) — 반려동물 페르소나와 무관한 단순 사진 분류라 Opus가
  필요 없음, 입력 단가가 1/5. **채팅 응답/인사/캡션처럼 페르소나가 드러나는
  호출은 절대 여기 맞춰 낮추지 말 것** — 이 서비스의 정서적 핵심이라
  품질 저하 위험이 비용 절감보다 큼.

## ⚠️ `c.executionCtx.waitUntil`은 이 Cloudflare Pages 환경에서 신뢰할 수 없다

2026-09-10에 실제로 재현/디버깅한 내용: `generation.ts`에서 AtlasCloud
호출을 `waitUntil`로 백그라운드에 던졌더니, 함수는 시작되는데(디버그 마커
기록까지 성공) `fetch()` 완료 전에 실행이 조용히 끊기고 job이 영원히
`pending`/`processing`에 멈추는 문제가 반복 재현됐다. `waitUntil` 대신
`/start` 핸들러 안에서 직접 `await`하도록 바꿔서 해결 — **AtlasCloud
"생성 시작" 요청은 이제 요청 처리 안에서 동기적으로 기다린다** (job 접수
확인 응답만 기다리는 거라 보통 1초 안팎, `AbortController`로 타임아웃도
걸어둠 — 처음엔 25초였는데 AtlasCloud가 이 응답 자체를 느리게 줄 때가
간헐적으로 재현돼서 2026-09-10에 3분으로 늘림). 완료 여부 폴링(`/status`)은
원래도 클라이언트가 호출할 때마다 그 요청 안에서 짧게 조회하는 방식이라
`waitUntil`을 쓴 적이 없다 — 문제 없음.

`/start`가 최대 3분까지 걸릴 수 있게 되면서, `/test`의 `startGeneration()`은
이 요청을 기다리지 않고 곧장 7초짜리 로딩 화면 → 채팅 전환을 진행하도록
바꿈(응답은 백그라운드에서 계속 기다림) — 그래야 실제로 "채팅하며 기다리는"
체감이 된다. 이 요청이 늦게 실패하면 상황에 따라 로딩 화면의 재시도 버튼
또는 채팅 안내 문구로 알려준다.

**교훈: 이 프로젝트에서 `waitUntil`로 오래 걸리는 작업(fetch 포함)을
던지는 패턴은 쓰지 말 것.** 짧은 요청을 클라이언트가 반복 호출하게
만드는 폴링 패턴이 안전하다.

## AtlasCloud 서비스 장애 이력 (2026-09-10) — 복구됨

같은 날, 위 waitUntil 문제를 고친 뒤에도 `POST /api/v1/model/generateImage`
호출이 계속 응답 없이 멈추는 문제가 발생. 디버깅으로 **AtlasCloud 쪽
문제임을 확정**함 (우리 코드 문제 아님):
- Cloudflare Worker에서 호출 → 무응답(타임아웃)
- 사용자 맥북에서 우리 서버 안 거치고 AtlasCloud를 직접 호출 → 동일하게
  120초까지 기다려도 0바이트 무응답
- `GET https://api.atlascloud.ai/`(루트)는 빠르게 404 정상 응답 — 도메인/
  Cloudflare 프론트는 살아있음, `generateImage` 엔드포인트 백엔드만 무응답
- AtlasCloud 담당자에게 문의함

**같은 날 복구 확인됨** — 이후 재시도에서 정상적으로 이미지가 생성됨.
장애 자체는 해소됐지만, 복구 직후 **"완료" 상태인데 이미지가 깨져서
뜨는(로드 실패)** 문제가 한 번 더 확인됨 — AtlasCloud가 `completed`를
반환한 시점에 실제 파일이 CDN에 아직 다 전파되지 않은 것으로 추정.
`/test`의 `setHeroImage()`가 `onerror` 시 재시도하도록 방어 코드 추가함
(`public/static/test.js`). 처음엔 2초 간격 최대 5회(10초)였는데 실사용
중 CDN 전파를 못 기다리고 너무 일찍 포기하는 문제가 다시 재현돼서
2026-09-10에 3초 간격 최대 10회(30초)로 늘림. 같은 증상이 다시 보이면
이 재시도 횟수/간격을 더 늘리는 것부터 시도.

혹시 앞으로 또 완전히 무응답(타임아웃)인 장애가 재현되면, 이 섹션의 진단
절차(맥북에서 직접 curl, `--max-time` 길게)부터 다시 밟을 필요 없이 바로
AtlasCloud 쪽에 확인.

## 결제 (토스페이먼츠, 아직 미구현)

- 반드시 "API 개별연동 키" 사용 — "주문서형·결제창형 연동 키"는 SDK 방식에서
  토스가 거부한다.
- 웹훅(`POST /payment/toss/webhook`)엔 서명 헤더가 없다. 웹훅 수신 시
  `GET /v1/payments/{paymentKey}`로 직접 재조회한 뒤에만 크레딧을 회수할 것.
- `src/payments.ts`는 현재 501 스텁 상태.

## 배포 워크플로

- `handoff` → `develop`(스테이징, Cloudflare Pages 자동 배포, GitHub 연동
  완료) → 확인 후 `promote-*-to-main` 브랜치 + PR + merge → `main`(운영,
  아직 GitHub 연동 안 함 — develop만 연결됨).
- `dist/_worker.js`, `dist/static/*`는 빌드 산출물이지만 저장소에 커밋한다
  (`npm run build` 후 항상 함께 커밋).
- `wrangler.jsonc`는 브랜치별로 다르다 — `develop`는 스테이징 D1/KV를 가리키게
  이미 채워져 있음(`neseggi-staging` D1, `neseggi-staging-kv` KV). `main`용
  값(`neseggi-production` D1, `neseggi-production-kv` KV)은 이미 Cloudflare에
  리소스는 만들어져 있으나 `main`의 `wrangler.jsonc`에는 아직 반영 안 함 —
  **`main`으로 승격할 때만** 채울 것 (`git diff origin/main -- wrangler.jsonc`가
  비어있는지 항상 확인, 승격 PR에서만 예외적으로 채움).
- 새 D1 마이그레이션은 `neseggi-staging`/`neseggi-staging-preview`/
  `neseggi-production` 3개 DB 모두에 수동으로 실행해야 한다
  (`npx wrangler d1 execute <db-name> --remote --file=migrations/...sql`).
  지금까지 만든 마이그레이션은 3곳 모두 적용 완료(`0001`~`0008`).
- Cloudflare Pages 시크릿(Preview/Production 환경변수)은 대시보드 대신
  Cloudflare API(`PATCH /accounts/{id}/pages/projects/{name}`, `deployment_configs.preview.env_vars`)로도
  등록 가능 — 이번 세션에서 이 방식으로 Preview 환경에 다 등록함. **가끔
  PATCH 직후 무관한 기존 키가 사라지는 현상이 관찰됨**(원인 불명, Cloudflare
  API 쪽 이슈로 추정) — 시크릿 등록/변경 후에는 항상 GET으로 전체 키 목록을
  다시 확인할 것.
- Cloudflare Pages는 env_vars를 이미 배포된 버전에 즉시 반영하지 않는 것으로
  보임 — 시크릿을 새로 등록/변경한 뒤에도 값이 안 읽히면(`Anthropic` SDK의
  "Could not resolve authentication method" 같은 에러) `POST
  /accounts/{id}/pages/projects/{name}/deployments/{deployment_id}/retry`로
  최신 배포를 재배포해서 픽업시킬 것.

## 필요한 시크릿 (Cloudflare Pages 환경변수) — Preview 환경 등록 완료

- `ATLAS_API_KEY` — AtlasCloud 이미지 생성 (`https://api.atlascloud.ai`) ✅ 등록됨
- `ANTHROPIC_API_KEY` — 반려동물 채팅(Claude API) ✅ 등록됨
- `KAKAO_CLIENT_ID` — EZlook(lookbook-ai)과 **동일 앱 재사용**(REST API 키).
  EZlook 쪽 "카카오 로그인 클라이언트 시크릿" 기능이 꺼져있어서
  `KAKAO_CLIENT_SECRET`은 필요 없음(보내도 카카오가 검증 안 함). 한 번
  PATCH 부작용으로 유실됐다가(아래 교훈 참고) 2026-09-10에 사용자가 다시
  알려준 값으로 재등록함. ✅ 등록됨
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — EZlook과 동일 Google Cloud
  OAuth 클라이언트 재사용, neseggi 콜백 URL을 승인된 리디렉션 URI에 추가함.
  `GOOGLE_CLIENT_ID`도 같은 이유로 유실됐다가 세션 로그에 남아있던 값으로
  복구함(`502307677132-...apps.googleusercontent.com`). ✅ 등록됨
- `TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY` — 테스트/샌드박스 키만 등록됨(실제
  가맹점 키 아님, 실서비스 전 교체 필요). `TOSS_API_BASE`도 같은 이유로
  유실됐다가 `https://api.tosspayments.com`으로 복구함. ✅ 등록됨
- `ADMIN_PASSWORD` — 2026-09-10에 사용자가 지정한 값으로 재발급함(기존
  값은 write-only secret이라 API로 다시 읽을 수 없어서 교체) — 현재 값은
  이 세션 대화 로그 참고, 별도 비밀번호 관리자로 옮겨둘 것. ✅ 등록됨
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — 해외 결제(선택), 미등록
- `GA4_MEASUREMENT_ID` — `wrangler.jsonc`의 `vars`, 아직 placeholder

**⚠️ 교훈 (2026-09-10, 같은 세션 안에서 세 번 재현됨)**: Preview
`env_vars`를 PATCH할 때, 이번 PATCH에서 언급하지 않은 다른 키가 — 특히
**바로 직전 PATCH에서 새로 추가된 plain_text 키**가 — 조용히 사라지는
경우가 반복 확인됐다(`GOOGLE_CLIENT_ID`/`TOSS_API_BASE`가 등록 직후 다음
PATCH 한 번에 같이 날아간 사례). 그러니 **PATCH 한 번마다 예외 없이** 그
직후 전체 키 목록을 GET으로 다시 확인하고, 빠진 게 있으면 그 자리에서
바로 복구할 것 — "이전에 확인했으니 이번엔 괜찮겠지"라고 넘기지 말 것.
`secret_text` 타입은 값 자체를 API로 다시 읽을 수 없으므로(GET 응답이
항상 빈 문자열), 한 번 유실되면 세션 로그에 텍스트로 남아있지 않은 한
복구 불가능하다 — 스크린샷으로만 전달된 값(예: 카카오 REST API 키)은
그래서 실제로 한 번 복구 불가 상태까지 갔었다(이후 사용자가 재발급).
그리고 **PATCH로 시크릿을 바꾼 뒤에는 최신 배포를 `/deployments/{id}/retry`로
재배포해야 실제로 반영된다** — 안 그러면 이미 떠 있는 배포는 예전 값을
계속 쓴다(위 "Cloudflare Pages는 env_vars를 즉시 반영하지 않음" 참고).

**Production 환경 시크릿은 아직 안 넣음** — `main` 승격 전 Cloudflare
대시보드에서 Preview와 구분해서 별도로 채울 것 (카카오/구글은 실서비스
도메인의 콜백 URL도 각 콘솔에 추가로 등록해야 함).

## AtlasCloud 실제 연동 계약 (검증 완료)

```
POST https://api.atlascloud.ai/api/v1/model/generateImage
Headers: Authorization: Bearer {ATLAS_API_KEY}, Content-Type: application/json
Body: { model: 'google/nano-banana-2/edit', prompt, aspect_ratio, resolution,
        thinking_level, output_format: 'jpeg', images: string[] (data URL) }
→ { code: 200, data: { id: jobId } }

GET https://api.atlascloud.ai/api/v1/model/prediction/{jobId}
Headers: Authorization: Bearer {ATLAS_API_KEY}
→ { data: { status: 'completed'|'succeeded'|'failed'|..., outputs/output/images: string[] | string } }
```

2026-09-10에 실사진으로 검증 완료 — 반려동물만, 반려동물+보호자,
반려동물+보호자+배경 조합 모두 생김새 보존 확인됨. `images` 배열 순서는
항상 `[반려동물, (보호자), (배경)]`. 배경 사진이 있으면 `thinking_level:
'high'`, 없으면 `'default'`.

## 아직 안 한 것 (다음 세션)

- **AtlasCloud 장애 복구 확인** (위 섹션 참고) — 담당자 문의 답변 왔는지,
  다시 정상 호출되는지 먼저 확인
- 토스페이먼츠 내새끼용 실제 가맹점 가입 + API 개별연동 키 발급 (지금은
  샌드박스 키)
- **월정액 구독 결제 라우트 실제 구현** (`src/payments.ts`는 현재 501 스텁) —
  사진 합성 등 개별 기능은 전부 무료이고 구독으로 수익화하기로 결정됨
  (위 섹션 참고). 구독 등급/플랜 구조, `users.credits`/`credit_logs`
  재사용 여부, 결제 성공 시 구독 상태를 어떻게 기록할지 등은 아직 설계
  안 됨 — 다음 세션에서 결정.
- `main` 브랜치 GitHub 연동 + `wrangler.jsonc`에 production D1/KV 반영 +
  Production 시크릿 등록
- `/terms`, `/privacy`, `/refund-policy` — 내새끼 사업자 정보로 실제 내용 작성
  (전자상거래법 제17조 기준 청약철회 조항 포함)
- 실제 앱(모바일) 쪽 구현 — 이 저장소는 API 백엔드만 담당, 앱 클라이언트는
  별도 저장소/프로젝트로 추정되나 아직 확인 안 됨
