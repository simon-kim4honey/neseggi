-- 내새끼 — 생성 3단계(배경 사진) 지원
-- 사용자가 반려동물과 자주 있던 장소 사진(집 등)을 선택 업로드하면, 프리셋
-- 컨셉 대신 이 사진을 배경 레퍼런스로 사용한다. 없으면 기존 프리셋(concept)로
-- 대체(fallback)한다.

ALTER TABLE generation_logs ADD COLUMN background_image_b64 TEXT;
