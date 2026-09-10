#!/usr/bin/env node
// ────────────────────────────────────────────────────
// 생성 프롬프트 회귀 방지 가드
//
// lookbook-ai(EZlook)에서 실제로 있었던 사고: AI 생성 프롬프트 문자열을
// 리팩터링하다가 핵심 지시문이 조용히 사라지거나 반대 의미로 바뀐 적이 있다.
// 빌드도 배포도 정상, 에러도 로그도 없이, 사용자가 여러 장 생성해보고
// 이상함을 느낄 때까지 아무도 몰랐다.
//
// 이 스크립트는 `npm run build`에 포함되어 있어, 아래 GUARDS 배열에 등록된
// 핵심 문구 중 하나라도 소스에서 사라지면 빌드 자체를 실패시킨다.
//
// PetLook은 아직 AI 생성 프롬프트를 작성하지 않았다 — 실제 프롬프트를
// src/generation.ts에 작성하는 시점에 아래 GUARDS 배열을 함께 채울 것.
// 완벽한 가드는 아니다(문구 존재만 확인, 의미 전체를 검증 못함). 그래도
// 실수로 통째로 날리는 사고는 막아준다.
// ────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcPath = join(__dirname, '..', 'src', 'generation.ts')
const src = readFileSync(srcPath, 'utf8')

// TODO(petlook): 실제 생성 프롬프트를 작성하면 여기에 핵심 문구를 등록할 것.
// 형식은 lookbook-ai/scripts/verify-critical-prompts.mjs 참고:
// { name: '...', must: '반드시 남아있어야 하는 문구', why: '왜 중요한지' }
const GUARDS = []

let failed = false
for (const g of GUARDS) {
  if (!src.includes(g.must)) {
    failed = true
    console.error(`\n✘ [프롬프트 가드 위반] ${g.name}`)
    console.error(`  기대 문구: "${g.must}"`)
    console.error(`  이 문구가 src/generation.ts에서 사라졌거나 변경되었습니다.`)
    console.error(`  이유: ${g.why}`)
    console.error(`  의도적인 변경이라면 scripts/verify-critical-prompts.mjs의 GUARDS도 함께 업데이트하세요.`)
  }
}

if (failed) {
  console.error('\n빌드를 중단합니다 — 생성 프롬프트 회귀 가능성이 감지되었습니다.\n')
  process.exit(1)
} else if (GUARDS.length === 0) {
  console.log('⚠ 프롬프트 가드가 아직 비어있습니다 (GUARDS.length === 0) — 실제 생성 프롬프트 작성 시 채울 것.')
} else {
  console.log('✔ 생성 프롬프트 가드 통과 (' + GUARDS.length + '개 문구 확인됨)')
}
