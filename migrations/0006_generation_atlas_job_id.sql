-- 내새끼 — AtlasCloud job id 저장
-- 상태 확인을 긴 백그라운드 폴링(waitUntil) 대신 클라이언트가 /status를 호출할
-- 때마다 그 요청 안에서 AtlasCloud를 한 번 조회하는 방식으로 바꾸면서 필요해짐
-- (Cloudflare의 waitUntil 실행시간 제한에 긴 폴링 루프가 걸려 중간에 끊기는
-- 문제가 실제로 발생함 — 2026-09-10 첫 실사진 테스트에서 확인).

ALTER TABLE generation_logs ADD COLUMN atlas_job_id TEXT;
