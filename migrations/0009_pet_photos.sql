-- 반려동물 참고 사진 풀(최대 10장). 온보딩 때 올린 사진들을 KV에 영구
-- 보관해서(gen_input과 달리 TTL 없음 — 계속 재사용돼야 하는 자료라서),
-- 사진 합성 때마다 이 중 한 장을 랜덤으로 골라 AtlasCloud에 보낸다.
-- "오늘의 추억사진"(1일1회 자동 생성) 기능도 이 풀에서 랜덤으로 고른다.
CREATE TABLE IF NOT EXISTS pet_photos (
  id          TEXT PRIMARY KEY,           -- pp_xxxx
  pet_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  kv_key      TEXT NOT NULL,              -- KV에 저장된 원본 이미지(data URL) 키
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pet_id) REFERENCES pets(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_pet_photos_pet_id ON pet_photos(pet_id);
