# PetLook

Cloudflare Workers/Pages + Hono + D1 + KV. EZlook(lookbook-ai)와 동일한
아키텍처 패턴을 따르는 별도 서비스 — 도메인은 반려동물 보호자+반려동물 합성
사진/영상 생성.

lookbook-ai와 달리 `src/index.tsx`는 얇게 유지하고, 도메인별로 파일을 분리해
`app.route()`로 마운트한다: `auth.ts`(인증/세션), `payments.ts`(토스/Stripe
결제), `generation.ts`(AI 생성 job), `admin.ts`(관리자 API).

## ⚠️ AI 생성 프롬프트는 조용히 망가질 수 있다

`src/generation.ts`에 실제 생성 프롬프트를 작성하게 되면, 그 문자열이
결과물 품질을 직접 좌우한다. lookbook-ai에서 실제로 겪은 사고(프롬프트
리팩터링 중 핵심 지시문이 반대 의미로 바뀌었는데 빌드/배포/로그 어디에도
안 남고 사용자 리포트로만 발견됨)와 동일한 위험이 있다.

- `npm run build`는 `scripts/verify-critical-prompts.mjs`를 먼저 실행한다.
  프롬프트에 새로운 "절대 지켜야 하는" 문구를 추가하면 반드시 이 스크립트의
  `GUARDS` 배열에도 등록할 것.
- 이 가드는 문구 "존재 여부"만 확인하지 의미 전체를 검증하지 않는다. 문구가
  있다고 안심하지 말고, 프롬프트를 고칠 때는 반드시 직접 읽고 의미를 확인할 것.
- 다른 것을 리팩터링하다가 프롬프트 문자열이 눈에 띄어도, 요청받지 않았다면
  손대지 말 것.
- 프롬프트를 의도적으로 바꿀 때는 바꾸기 전/후 문구를 나란히 보여주고 무엇이
  왜 바뀌는지 설명할 것.

## 재사용한 스키마 (lookbook-ai 기반, 거의 그대로)

- `users`, `user_sessions` — 이메일/카카오/구글 인증 (`migrations/0001_users.sql`)
- `credit_logs` — 크레딧 증감 원장 (`migrations/0002_credit_logs.sql`)
- `payment_logs` — 토스페이먼츠/Stripe 결제 내역 (`migrations/0003_payment_logs.sql`)
- `generation_logs` — PetLook 고유 스키마(보호자 사진 + 반려동물 사진 2-슬롯),
  lookbook-ai의 3-슬롯 구조와 다름 (`migrations/0004_generation_logs.sql`)

## 결제 (토스페이먼츠)

- 반드시 "API 개별연동 키" 사용 — "주문서형·결제창형 연동 키"는 SDK 방식에서
  토스가 거부한다.
- 웹훅(`POST /payment/toss/webhook`)엔 서명 헤더가 없다. 웹훅 수신 시
  `GET /v1/payments/{paymentKey}`로 직접 재조회한 뒤에만 크레딧을 회수할 것.

## 배포 워크플로

- `handoff` → `develop`(스테이징, Cloudflare Pages 자동 배포) → 확인 후
  `promote-*-to-main` 브랜치 + PR + merge → `main`(운영).
- `dist/_worker.js`, `dist/static/*`는 빌드 산출물이지만 저장소에 커밋한다
  (`npm run build` 후 항상 함께 커밋).
- `wrangler.jsonc`는 브랜치별로 다르다 — `develop`/handoff는 스테이징 D1/KV를,
  `main`은 운영 D1/KV를 가리킨다. **`main`으로 승격할 때 `wrangler.jsonc`는
  절대 건드리지 말 것** (`git diff origin/main -- wrangler.jsonc`가 비어있는지
  항상 확인).
- 새 D1 마이그레이션은 스테이징/운영 양쪽에 수동으로 실행해야 한다
  (`npx wrangler d1 execute <db-name> --remote --file=migrations/...sql`).
- Cloudflare Pages의 `wrangler pages secret put`은 버전에 따라 `--env` 플래그가
  없어, 플래그 없이 실행하면 Preview가 아니라 Production에 쓰인다. 결제 관련
  시크릿은 반드시 Cloudflare 대시보드 → 프로젝트 → Settings → Environment
  variables에서 Preview/Production을 구분해 넣을 것.

## 아직 안 한 것 (다음 세션)

- Cloudflare Workers/Pages 프로젝트 생성 + D1/KV(스테이징/운영 분리) 실제 생성
  → `wrangler.jsonc`의 `REPLACE_WITH_*` 값 채우기
- 토스페이먼츠 PetLook용 가맹점 가입 + API 개별연동 키 발급
- AI 생성 API(AtlasCloud 등) 계약/키 확인, 반려동물 합성 가능 여부 검증 →
  `src/generation.ts` 실제 구현 + `scripts/verify-critical-prompts.mjs`의
  `GUARDS` 채우기
- 인증/결제 라우트 실제 구현 (`src/auth.ts`, `src/payments.ts`는 현재 501
  스텁)
- `/terms`, `/privacy`, `/refund-policy` — PetLook 사업자 정보로 실제 내용 작성
  (전자상거래법 제17조 기준 청약철회 조항 포함)
