-- 내새끼 — 채팅 기능 (핵심 기능: 무지개다리를 건넌 반려동물과의 대화)
-- 사진 합성(generation_logs)은 부가 기능이고, 이게 실제 메인 기능이다.

CREATE TABLE IF NOT EXISTS pets (
  id            TEXT PRIMARY KEY,          -- p_xxxx
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  species       TEXT,                      -- '개' | '고양이' | 기타 자유 텍스트
  personality   TEXT,                      -- 성격/말투 묘사 (챗봇 페르소나 프롬프트에 반영)
  avatar_url    TEXT,                      -- 대표 사진 (generation_logs.result_url 등)
  status        TEXT NOT NULL DEFAULT 'active', -- 'active' | 'deleted'
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_pets_user_id ON pets(user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL,               -- 'user' | 'pet'
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pet_id) REFERENCES pets(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_pet_id ON chat_messages(pet_id, created_at);
