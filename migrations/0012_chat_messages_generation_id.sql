-- 채팅에 뜨는 사진 썸네일(합성 결과/오늘의 추억사진)이 그 세션에서만
-- 보이고, 페이지를 나갔다 다시 들어오면(또는 새로고침) 사라지는 문제 수정.
-- 지금까지는 캡션 텍스트만 chat_messages에 저장되고 썸네일 자체는 순전히
-- 클라이언트 상태로만 표시됐음 — 이미지 메시지를 별도 row로 영구 저장해서
-- 대화 이력을 다시 불러올 때도 재구성할 수 있게 한다. content는 빈 문자열,
-- generation_id가 어느 사진 합성 job인지를 가리킨다(챗 클라이언트가
-- avatar-proxy?jobId=... 로 표시).
ALTER TABLE chat_messages ADD COLUMN generation_id TEXT REFERENCES generation_logs(id);
