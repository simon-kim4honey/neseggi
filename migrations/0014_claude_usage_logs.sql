-- Claude API(반려동물 채팅) 호출마다 실제 토큰 사용량을 기록한다. 관리자가
-- 사용자별 사용량과 그에 따른 비용을 확인할 수 있게 하려는 목적 — 지금까지는
-- anthropic.messages.create() 응답의 usage를 그냥 버리고 있었다.
CREATE TABLE IF NOT EXISTS claude_usage_logs (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                    TEXT NOT NULL,
  pet_id                     TEXT,                      -- 반려동물과 무관한 호출(예: classify-species)은 NULL
  purpose                    TEXT NOT NULL,              -- 'classify_species' | 'greeting' | 'photo_caption' | 'daily_memory_caption' | 'chat_reply'
  model                      TEXT NOT NULL,
  input_tokens               INTEGER NOT NULL DEFAULT 0,
  output_tokens              INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens    INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_claude_usage_user_id ON claude_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_claude_usage_created_at ON claude_usage_logs(created_at);
