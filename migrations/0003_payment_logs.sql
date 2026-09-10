-- ────────────────────────────────────────────────────
-- 0003_payment_logs.sql
-- 토스페이먼츠(국내) / Stripe(해외) 결제 내역 테이블
-- ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  order_id     TEXT UNIQUE NOT NULL,   -- 토스 orderId / Stripe session id (고유)
  payment_key  TEXT,                   -- 토스 paymentKey (confirm 후 채움)
  amount       INTEGER NOT NULL,       -- 결제 금액 (원 또는 최소 화폐 단위)
  credits      INTEGER NOT NULL,       -- 지급 크레딧
  status       TEXT NOT NULL DEFAULT 'pending',
                                        -- pending | paid | failed | canceled
  pg_provider  TEXT NOT NULL DEFAULT 'toss', -- 'toss' | 'stripe'
  toss_method  TEXT,                   -- 카드 / 가상계좌 / 계좌이체 등
  toss_raw     TEXT,                   -- PG 응답 JSON (전체 보존)
  created_at   DATETIME DEFAULT (datetime('now')),
  paid_at      DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_payment_logs_user_id  ON payment_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_logs_order_id ON payment_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_logs_status   ON payment_logs(status);
