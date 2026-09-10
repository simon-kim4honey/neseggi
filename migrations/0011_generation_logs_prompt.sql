-- AtlasCloud에 실제로 전달된 프롬프트 전문을 저장해서 관리자 페이지에서
-- 확인할 수 있게 한다. 프롬프트 문구가 조용히 깨지는 사고(CLAUDE.md 경고
-- 참고)를 감지하는 데도 도움이 됨 — 코드 리뷰만으로는 실제 런타임에 어떤
-- 프롬프트가 나갔는지 알 수 없다.
ALTER TABLE generation_logs ADD COLUMN prompt TEXT;
