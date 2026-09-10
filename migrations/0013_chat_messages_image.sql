-- 채팅 메시지에 사용자가 직접 사진을 첨부해서 보낼 수 있게 한다("이거
-- 봐봐" 하며 사진을 보내면 반려동물이 Claude 비전으로 실제로 보고 반응).
-- KV에 원본(data URL)을 영구 저장하고 D1엔 키만 기록 — pet_photos와 동일한
-- 패턴. 히스토리를 다시 Claude에 보낼 때는 과거 사진은 실제 픽셀을 다시
-- 보내지 않고 "[사진을 보냈어]" 같은 텍스트 표시로 대체한다(비용/복잡도
-- 절약 — 방금 보낸 사진만 실제로 vision에 태운다).
ALTER TABLE chat_messages ADD COLUMN image_kv_key TEXT;
