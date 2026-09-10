-- generation_logs를 반려동물 단위로 추적(랜덤 사진 풀 선택, "오늘의
-- 추억사진" 1일1회 체크에 필요)하고, 사용자가 직접 요청한 합성(manual)과
-- 자동 생성되는 "오늘의 추억사진"(daily_memory)을 구분한다. notified는
-- daily_memory 결과를 채팅에 이미 올렸는지(중복 알림 방지) 표시.
ALTER TABLE generation_logs ADD COLUMN pet_id TEXT REFERENCES pets(id);
ALTER TABLE generation_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE generation_logs ADD COLUMN notified INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_generation_logs_pet_id ON generation_logs(pet_id);
