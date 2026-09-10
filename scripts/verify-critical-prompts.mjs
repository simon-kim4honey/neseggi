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
// 내새끼는 아직 AI 생성 프롬프트를 작성하지 않았다 — 실제 프롬프트를
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

const GUARDS = [
  {
    name: '반려동물 생김새 보존 지시문',
    must:
      'ABSOLUTE RULE — NEVER VIOLATE: the pet in the output must be the exact same animal as shown in Image 1 — identical breed, fur color, fur pattern and markings, ear shape, face, and eye color.',
    why: '이 문구가 사라지거나 약해지면 사용자가 보낸 반려동물과 다르게 생긴 "일반적인 동물"이 나와도 빌드/배포/로그 어디에도 안 남고 사용자 리포트로만 발견된다.',
  },
  {
    name: '보호자 얼굴 보존 지시문',
    must:
      "ABSOLUTE RULE — NEVER VIOLATE: the person in the output must be the exact same person as shown in Image 2 — identical face, facial features, hair, and skin tone.",
    why: '보호자 사진이 포함된 합성에서 이 문구가 사라지면 실제 보호자와 다른 사람 얼굴이 나올 수 있다.',
  },
  {
    name: '배경 사진은 장소 느낌 레퍼런스로만 사용 (100% 동일 재현 금지)',
    must:
      "only as a loose reference for the location's overall feel — general architecture style, furniture, colors, lighting, and atmosphere. The background does NOT need to match Image",
    why: '2026-09-10 배경사진 업로드 테스트에서 사용자가 "배경이 업로드 사진과 100% 동일할 필요는 없다"고 명확히 요구함 — 이 문구가 사라지면 모델이 배경 사진을 그대로 복제하려다 원본에 찍혀있던 다른 사람/동물까지 결과물에 나타날 위험이 다시 생긴다.',
  },
  {
    name: '카메라 각도/구도는 배경 원본이 아니라 인물·동물 비율에 맞춘다',
    must: 'choose whatever camera angle, framing, and room proportions naturally fit',
    why: '2026-09-10 사용자 피드백: "카메라 각도나 비율은 사람, 동물 비율에 맞춰라" — 이 문구가 사라지면 모델이 배경 사진의 원래 카메라 앵글을 그대로 고정해버려 인물/동물과 어색하게 안 맞는 합성이 다시 나올 수 있다.',
  },
  {
    name: '사람·동물·배경 세 요소가 한 장의 사진처럼 자연스럽게 혼합',
    must:
      'blend seamlessly together — matching lighting direction, color temperature, shadows, and camera perspective across every element',
    why: '2026-09-10 사용자 피드백: "사람, 동물, 배경 세가지가 모두 자연스럽게 혼합되어야하는것이 핵심이다" — 이 문구가 사라지면 비율은 맞아도 조명 방향/색온도/그림자/원근감이 서로 안 맞아 합성 티가 나는 결과가 나올 수 있다.',
  },
  {
    name: '배경 사진이 인물/동물 얼굴·생김새(정체성)에 영향 주지 않도록 제한',
    must: "their face, fur pattern, and other identifying features must stay exactly as shown in their source photo, regardless of Image",
    why: '2026-09-10 실사진 테스트에서 이 제약이 없을 때 배경 사진(넓은 실내 등) 때문에 반려동물 크기가 과도하게 커지고 보호자 얼굴이 바뀌는 문제가 실제로 발생함. (반려동물 단독 배경합성 케이스도 동일 위험이 있어 subject(s) 표현으로 일반화)',
  },
  {
    name: '배경(소파/가구 등)은 인물·동물 비율에 맞게 자연스럽게 렌더링',
    must: 'render the background\'s furniture and room proportions at a scale and perspective that naturally fits around the subjects',
    why: '2026-09-11 실사진 테스트에서, 인물 크기를 원본 그대로 고정하기만 하고 배경 비율은 안 맞춰서 소파/테이블 같은 가구가 인물과 어색하게 따로 노는(비율이 안 맞는) 합성 결과가 나옴 — 배경이 인물/동물 크기에 맞춰 조정되어야 한다는 방향을 명시.',
  },
]

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
