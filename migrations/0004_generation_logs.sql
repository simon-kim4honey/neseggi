-- PetLook — AI 생성 job 테이블
-- lookbook-ai의 "의류+모델+배경" 3-슬롯 구조와 달리, PetLook은
-- "보호자 사진 + 반려동물 사진"(또는 반려동물 사진 1장) 조합이 입력.
-- 실제 컬럼은 AI API 계약(AtlasCloud 등) 확정 후 조정 필요 — 우선 뼈대만.

CREATE TABLE IF NOT EXISTS generation_logs (
  id             TEXT PRIMARY KEY,       -- job id (g_xxxx)
  user_id        TEXT NOT NULL,
  owner_image_b64   TEXT,                -- 보호자 사진 (선택 — 없으면 반려동물 사진 1장 모드)
  pet_image_b64     TEXT NOT NULL,       -- 반려동물 사진
  output_type    TEXT NOT NULL DEFAULT 'image', -- 'image' | 'video'
  concept        TEXT,                   -- 배경/컨셉 프리셋 id
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | failed
  result_url     TEXT,
  error_message  TEXT,
  credits_used   INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at   TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_generation_logs_user_id ON generation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_generation_logs_status ON generation_logs(status);
