-- 내새끼 — 회원 테이블
-- 카카오, 구글, 이메일 통합 인증 (lookbook-ai 0002_users.sql 구조 재사용)

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- 내부 UUID (u_xxxx)
  email         TEXT UNIQUE NOT NULL,      -- 이메일 (고유)
  name          TEXT NOT NULL DEFAULT '',  -- 표시 이름
  password_hash TEXT,                      -- 이메일 가입 시 salt:sha256 해시 (소셜은 NULL)
  provider      TEXT NOT NULL DEFAULT 'email', -- 'email' | 'kakao' | 'google'
  provider_id   TEXT,                      -- 소셜 provider의 user id
  avatar_url    TEXT,                      -- 프로필 이미지 URL
  status        TEXT NOT NULL DEFAULT 'active', -- 'active' | 'suspended' | 'deleted'
  credits       INTEGER NOT NULL DEFAULT 5,
  role          TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider
  ON users(provider, provider_id)
  WHERE provider_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- 세션 테이블 (JWT 대신 서버사이드 세션)
CREATE TABLE IF NOT EXISTS user_sessions (
  token        TEXT PRIMARY KEY,          -- 세션 토큰 (랜덤 64자 hex)
  user_id      TEXT NOT NULL,
  expires_at   TEXT NOT NULL,             -- ISO datetime
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);
