-- 내새끼 — 반려동물이 보호자를 부르는 호칭 (엄마/아빠/오빠/형/언니/누나 또는 직접입력)
-- 채팅 페르소나 프롬프트에 반영해서 그 호칭으로 부르며 대화하게 한다.

ALTER TABLE pets ADD COLUMN owner_title TEXT;
