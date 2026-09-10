# 내새끼 (neseggi)

[www.neseggi.com](https://www.neseggi.com) — 반려동물 보호자가 본인 사진(또는
반려동물 사진) 1장을 업로드하면, AI가 보호자와 반려동물이 함께 찍은 자연스러운
합성 사진/영상을 자동 생성해주는 서비스.

EZlook([lookbook-ai](https://github.com/simon-kim4honey/lookbook-ai))와 기술
아키텍처/서비스 구조를 그대로 재사용하되, 사업 도메인은 완전히 다른 별도 서비스.

## 스택

Cloudflare Workers/Pages + Hono + D1(`NESEGGI_DB`) + KV(`NESEGGI_KV`) + Vite +
Vanilla JS(`public/static/app.js`) + Tailwind CDN.

## 개발

```bash
npm install
npm run dev
```

## 배포

`handoff/개발 브랜치` → `develop`(스테이징, Cloudflare Pages 자동 Preview 배포) →
확인 후 `promote-*-to-main` 브랜치 + PR → `main`(운영, 자동 Production 배포).

`wrangler.jsonc`는 브랜치별로 다른 D1/KV ID를 가진다. **`main`으로 승격할 때
`wrangler.jsonc`는 절대 건드리지 말 것** — 항상 `git diff origin/main --
wrangler.jsonc`가 비어있는지 확인.

자세한 컨벤션은 `CLAUDE.md` 참고.
