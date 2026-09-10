// 내새끼 QA 테스트 페이지 로직 (vanilla JS) — /test 전용, 실제 앱 UI 아님
;(function () {
  const TOKEN_KEY = 'neseggi_test_session_token'
  const PET_ID_KEY = 'neseggi_test_pet_id'
  const RESULT_URL_KEY = 'neseggi_test_result_url'

  const MAX_PET_PHOTOS = 10

  const state = {
    petId: localStorage.getItem(PET_ID_KEY) || null,
    petName: null,
    petAvatarUrl: localStorage.getItem(RESULT_URL_KEY) || null,
    ownerTitle: null,
    petPhotos: [], // 반려동물 참고 사진 풀 (최대 10장, data URL[])
    petPhotosUploadedCount: 0, // 뒤로 갔다 다시 진행할 때 중복 업로드 방지용
    ownerPhoto: null,
    bgPhoto: null,
    // 채팅 화면으로 넘어가기 전에 사진 생성이 끝나버린 경우, 채팅 진입 후
    // 바로 썸네일 메시지를 보낼 수 있도록 대기시켜두는 값들
    chatEntered: false,
    pendingImageUrl: null,
    pendingImageJobId: null,
    pendingImageCaption: null,
    pendingGenerationError: null,
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY)
  }
  function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  }

  async function api(path, options) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {})
    const token = getToken()
    if (token) headers['X-Session-Token'] = token
    const res = await fetch(path, Object.assign({}, options, { headers }))
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, data }
  }

  // AtlasCloud OSS 호스트를 <img src>가 직접 가리키면 일부 기기/네트워크에서
  // 이미지가 계속 깨져서 뜨는 문제가 반복 확인됨 — 우리 서버가 대신 가져와
  // 스트리밍하는 프록시를 거치도록 우회한다. <img>는 커스텀 헤더를 못 보내서
  // 토큰은 쿼리 파라미터로 붙인다.
  function avatarProxyUrl(petId, jobId) {
    let url = '/api/chat/pets/' + petId + '/avatar-proxy?token=' + encodeURIComponent(getToken() || '')
    if (jobId) url += '&jobId=' + encodeURIComponent(jobId)
    return url
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve(null)
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  // Claude API/AtlasCloud 둘 다 image/avif, image/heic 같은 포맷은 지원하지
  // 않아서 서버가 거절한다 — 캔버스에 그려서 JPEG로 변환한 뒤 업로드한다.
  // (png/jpeg/webp는 이미 지원되는 포맷이라 변환 없이 그대로 사용)
  async function normalizeImageFile(file) {
    if (!file) return null
    const type = (file.type || '').toLowerCase()
    if (type === 'image/png' || type === 'image/jpeg' || type === 'image/jpg' || type === 'image/webp') {
      return fileToDataUrl(file)
    }
    const objectUrl = URL.createObjectURL(file)
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = reject
        el.src = objectUrl
      })
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      return canvas.toDataURL('image/jpeg', 0.92)
    } catch (err) {
      // 브라우저가 이 포맷을 디코딩하지 못하면 원본을 그대로 시도 — 서버가
      // 형식 오류로 거절하면 그때 사용자에게 알려진다.
      console.error('image format conversion failed:', err)
      return fileToDataUrl(file)
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  // 파일 선택 즉시 썸네일 미리보기 — 업로드(=파일 선택)가 제대로 됐는지 눈으로 확인용
  function wirePreview(inputId, previewId, labelId) {
    const input = document.getElementById(inputId)
    const preview = document.getElementById(previewId)
    const label = labelId ? document.getElementById(labelId) : null
    input.addEventListener('change', () => {
      const file = input.files[0]
      if (!file) {
        preview.classList.add('hidden')
        preview.src = ''
        if (label) label.classList.remove('hidden')
        return
      }
      preview.src = URL.createObjectURL(file)
      preview.classList.remove('hidden')
      if (label) label.classList.add('hidden')
    })
  }
  wirePreview('owner-photo', 'owner-photo-preview', 'owner-photo-label')
  wirePreview('bg-photo', 'bg-photo-preview', 'bg-photo-label')

  // 반려동물 사진은 한 번에 최대 10장까지 올릴 수 있다 — 이후 사진 합성/
  // "오늘의 추억사진" 때마다 이 중 한 장을 서버가 랜덤으로 골라 쓴다. 종/품종은
  // 첫 번째 사진으로만 자동 분류한다(사용자 직접 입력 없음). 사진을 고를 때마다
  // 백그라운드로 분류 요청을 보내고, "다음단계"를 누를 때 아직 안 끝났으면
  // 그때 기다린다.
  let speciesPromise = null
  const petPhotoGrid = document.getElementById('pet-photo-grid')
  const petPhotoLabel = document.getElementById('pet-photo-label')
  const petPhotoCount = document.getElementById('pet-photo-count')
  const petSpeciesHint = document.getElementById('pet-species-hint')

  function renderPetPhotoGrid() {
    petPhotoGrid.innerHTML = ''
    state.petPhotos.forEach((dataUrl, idx) => {
      const item = document.createElement('div')
      item.className = 'photo-grid-item'
      const img = document.createElement('img')
      img.src = dataUrl
      item.appendChild(img)
      const remove = document.createElement('div')
      remove.className = 'photo-grid-remove'
      remove.textContent = '×'
      remove.addEventListener('click', () => {
        state.petPhotos.splice(idx, 1)
        if (idx === 0) refreshSpeciesHint()
        renderPetPhotoGrid()
      })
      item.appendChild(remove)
      petPhotoGrid.appendChild(item)
    })
    petPhotoLabel.textContent =
      state.petPhotos.length === 0 ? '반려동물 사진을 올려주세요 (최대 10장)' : '사진 추가하기'
    petPhotoCount.textContent = state.petPhotos.length + ' / ' + MAX_PET_PHOTOS + '장'
  }

  function refreshSpeciesHint() {
    if (state.petPhotos.length === 0) {
      petSpeciesHint.textContent = ''
      speciesPromise = null
      return
    }
    petSpeciesHint.textContent = '종을 확인하고 있어요...'
    speciesPromise = api('/api/chat/classify-species', {
      method: 'POST',
      body: JSON.stringify({ image: state.petPhotos[0] }),
    }).then(({ ok, data }) => {
      const species = ok ? data.species : ''
      petSpeciesHint.textContent = species ? `${species}로 확인했어요` : ''
      return species || ''
    })
  }

  document.getElementById('pet-photo').addEventListener('change', async () => {
    const input = document.getElementById('pet-photo')
    const files = Array.from(input.files || [])
    input.value = '' // 같은 파일을 다시 골라도 change가 또 뜨도록 초기화
    if (files.length === 0) return

    const wasEmpty = state.petPhotos.length === 0
    const room = MAX_PET_PHOTOS - state.petPhotos.length
    if (room <= 0) {
      alert(`사진은 최대 ${MAX_PET_PHOTOS}장까지만 올릴 수 있어요.`)
      return
    }
    const toAdd = files.slice(0, room)
    if (files.length > toAdd.length) {
      alert(`최대 ${MAX_PET_PHOTOS}장까지만 담을 수 있어서 ${toAdd.length}장만 추가했어요.`)
    }

    const converted = await Promise.all(toAdd.map((f) => normalizeImageFile(f)))
    state.petPhotos.push(...converted)
    renderPetPhotoGrid()
    if (wasEmpty) refreshSpeciesHint()
  })

  // ── 로그인 (이메일/카카오/구글) ──
  // "오늘의 추억사진"이 사용자별로 하루하루 이어지는 기능이라, 매번 새로
  // 만들어지는 익명 세션으로는 이 기능을 확인할 수 없다 — 실제 로그인으로
  // 되돌림.
  const loginError = document.getElementById('login-error')

  async function checkExistingLogin() {
    if (!getToken()) return false
    const { ok } = await api('/api/auth/me')
    if (!ok) setToken(null)
    return ok
  }

  function afterLogin() {
    if (state.petId) {
      enterChat()
    } else {
      showStep('step-pet')
    }
  }

  document.getElementById('login-submit').addEventListener('click', async () => {
    loginError.textContent = ''
    const email = document.getElementById('login-email').value.trim()
    const password = document.getElementById('login-password').value
    const { ok, data } = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
    if (!ok) {
      loginError.textContent = data.error || '로그인 실패'
      return
    }
    setToken(data.token)
    afterLogin()
  })

  document.getElementById('signup-submit').addEventListener('click', async () => {
    loginError.textContent = ''
    const name = document.getElementById('login-name').value.trim() || '테스터'
    const email = document.getElementById('login-email').value.trim()
    const password = document.getElementById('login-password').value
    const { ok, data } = await api('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    })
    if (!ok) {
      loginError.textContent = data.error || '회원가입 실패'
      return
    }
    setToken(data.token)
    afterLogin()
  })

  function loginWithOAuth(provider) {
    loginError.textContent = ''
    const popup = window.open('/api/auth/' + provider, 'oauth_' + provider, 'width=480,height=640')
    function onMessage(e) {
      const payload = e.data
      if (!payload || payload.type !== 'oauth_success' || payload.provider !== provider) return
      window.removeEventListener('message', onMessage)
      setToken(payload.token)
      afterLogin()
    }
    window.addEventListener('message', onMessage)
    if (!popup) loginError.textContent = '팝업이 차단됐어요. 팝업 허용 후 다시 시도해주세요.'
  }
  document.getElementById('login-kakao').addEventListener('click', () => loginWithOAuth('kakao'))
  document.getElementById('login-google').addEventListener('click', () => loginWithOAuth('google'))

  // ── 단계 전환 ──
  const steps = ['step-login', 'step-pet', 'step-title', 'step-owner-photo', 'step-bg-photo', 'step-generating', 'step-chat']
  const progressDots = Array.from(document.querySelectorAll('#progress-dots span'))
  function showStep(id) {
    steps.forEach((s) => document.getElementById(s).classList.toggle('hidden', s !== id))
    const activeGroup = document.getElementById(id).dataset.group
    progressDots.forEach((dot) => dot.classList.toggle('active', dot.dataset.group === activeGroup))
  }

  // ── 1. 반려동물 프로필 ──
  // 사진 여러 장(특히 10장 가까이)을 업로드할 때 서버 응답까지 몇 초 걸릴 수
  // 있는데 버튼에 아무 반응이 없으면 사용자가 계속 눌러버려서, 그 사이 여러
  // 번 클릭되면 pet이 중복 생성되거나 같은 사진이 중복 업로드될 수 있었다 —
  // 버튼을 누르는 즉시 비활성화하고 진행 중 문구를 보여준다(중복 클릭 방지 +
  // 눈에 보이는 반응).
  let petNextSubmitting = false
  const petNextBtn = document.getElementById('step-pet-next')
  const petNextBtnDefaultText = petNextBtn.textContent
  document.getElementById('step-pet-next').addEventListener('click', async () => {
    if (petNextSubmitting) return
    const name = document.getElementById('pet-name').value.trim()
    if (!name) {
      alert('이름을 입력해주세요.')
      return
    }
    if (state.petPhotos.length === 0) {
      alert('반려동물 사진을 최소 1장 선택해주세요.')
      return
    }

    petNextSubmitting = true
    petNextBtn.disabled = true
    petNextBtn.textContent = '등록하는 중...'
    try {
      const species = speciesPromise ? await speciesPromise : ''
      const personality = document.getElementById('pet-personality').value.trim()

      const { ok, data } = await api('/api/chat/pets', {
        method: 'POST',
        body: JSON.stringify({ petId: state.petId, name, species, personality }),
      })
      if (!ok) {
        alert(data.error || '등록 실패')
        return
      }
      state.petId = data.pet.id
      state.petName = name
      localStorage.setItem(PET_ID_KEY, state.petId)

      // 뒤로 갔다가 다시 "다음단계"를 눌러도 이미 서버에 올라간 사진을 중복
      // 업로드하지 않도록, 지난번 업로드 이후 새로 추가된 사진만 보낸다.
      const newPhotos = state.petPhotos.slice(state.petPhotosUploadedCount)
      if (newPhotos.length > 0) {
        petNextBtn.textContent = '사진 업로드하는 중...'
        const uploadRes = await api('/api/chat/pets/' + state.petId + '/photos', {
          method: 'POST',
          body: JSON.stringify({ images: newPhotos }),
        })
        if (!uploadRes.ok) {
          alert(uploadRes.data.error || '사진 업로드 실패')
          return
        }
        state.petPhotosUploadedCount = state.petPhotos.length
      }

      showStep('step-title')
    } finally {
      petNextSubmitting = false
      petNextBtn.disabled = false
      petNextBtn.textContent = petNextBtnDefaultText
    }
  })

  // ── 2-1. 호칭 ──
  const TITLE_OPTIONS = ['아빠', '엄마', '오빠', '형', '언니', '누나']
  const titleOptionsEl = document.getElementById('title-options')
  let selectedTitle = null
  TITLE_OPTIONS.forEach((t) => {
    const btn = document.createElement('button')
    btn.textContent = t
    btn.type = 'button'
    btn.className = 'title-chip'
    btn.addEventListener('click', () => {
      selectedTitle = t
      document.getElementById('title-custom').value = ''
      Array.from(titleOptionsEl.children).forEach((el) => el.classList.remove('selected'))
      btn.classList.add('selected')
    })
    titleOptionsEl.appendChild(btn)
  })
  document.getElementById('title-custom').addEventListener('input', () => {
    selectedTitle = null
    Array.from(titleOptionsEl.children).forEach((el) => el.classList.remove('selected'))
  })

  document.getElementById('step-title-back').addEventListener('click', () => showStep('step-pet'))
  document.getElementById('step-title-next').addEventListener('click', async () => {
    const custom = document.getElementById('title-custom').value.trim()
    state.ownerTitle = selectedTitle || custom || null
    if (state.ownerTitle) {
      await api('/api/chat/pets', {
        method: 'POST',
        body: JSON.stringify({ petId: state.petId, ownerTitle: state.ownerTitle }),
      })
    }
    showStep('step-owner-photo')
  })

  // ── 2-2. 보호자 사진 ──
  document.getElementById('step-owner-photo-back').addEventListener('click', () => showStep('step-title'))
  document.getElementById('step-owner-photo-skip').addEventListener('click', () => {
    document.getElementById('owner-photo').value = ''
    state.ownerPhoto = null
    showStep('step-bg-photo')
  })
  document.getElementById('step-owner-photo-next').addEventListener('click', async () => {
    const file = document.getElementById('owner-photo').files[0]
    state.ownerPhoto = file ? await normalizeImageFile(file) : null
    showStep('step-bg-photo')
  })

  // ── 2-3. 배경 사진 ──
  document.getElementById('step-bg-photo-back').addEventListener('click', () => showStep('step-owner-photo'))
  document.getElementById('step-bg-photo-skip').addEventListener('click', () => {
    document.getElementById('bg-photo').value = ''
    state.bgPhoto = null
    startGeneration()
  })
  document.getElementById('step-bg-photo-next').addEventListener('click', async () => {
    const file = document.getElementById('bg-photo').files[0]
    state.bgPhoto = file ? await normalizeImageFile(file) : null
    startGeneration()
  })

  // ── 3. 사진 합성 ──
  // "무지개 나라에서 우리 아이를 부르고 있어요.." 화면은 실제 생성 완료를
  // 기다리지 않고 7초만 보여준 뒤 바로 채팅으로 넘어간다. 사진 생성은
  // 백그라운드에서 계속 폴링하고, 완료되면 이미 시작된 채팅에 반려동물
  // 메시지로 썸네일을 보낸다 — 보호자가 채팅을 하고 있는 동안 생성 시간을
  // 벌 수 있어서 AtlasCloud 응답이 늦어져도 체감 대기시간이 줄어든다.
  const GENERATING_SCREEN_MS = 7000
  const genStatusText = document.getElementById('gen-status-text')
  const genRetryBtn = document.getElementById('gen-retry')

  function startGeneration() {
    showStep('step-generating')
    genStatusText.textContent = ''
    genRetryBtn.classList.add('hidden')
    state.chatEntered = false
    state.pendingImageUrl = null
    state.pendingImageJobId = null
    state.pendingImageCaption = null
    state.pendingGenerationError = null

    if (!state.petId || state.petPhotosUploadedCount === 0) {
      // 정상 흐름이면 1단계에서 이미 필수로 막혀서 여기 도달할 수 없다 —
      // 혹시라도 상태가 꼬였을 때 조용히 건너뛰지 않고 명확히 되돌린다.
      alert('반려동물 사진이 없어서 합성을 진행할 수 없어요. 처음부터 다시 시작해주세요.')
      showStep('step-pet')
      return
    }

    // 반려동물 사진은 더 이상 직접 보내지 않는다 — 서버가 사진 풀(최대
    // 10장)에서 랜덤으로 한 장을 골라 사용한다.
    const body = { petId: state.petId, concept: 'studio' }
    if (state.ownerPhoto) body.ownerImage = state.ownerPhoto
    if (state.bgPhoto) body.backgroundImage = state.bgPhoto

    // AtlasCloud가 "생성 시작" 요청 자체를 느리게 받아줄 때가 있어서(최대
    // 3분까지) 이 요청을 기다리지 않고 바로 7초짜리 로딩 화면 → 채팅 전환을
    // 진행한다 — 응답은 백그라운드에서 계속 기다리다가, 늦게라도 성공하면
    // 폴링을 시작하고 실패하면 상황에 맞게(로딩 화면 or 채팅 중) 알려준다.
    api('/api/generate/start', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(({ ok, data }) => {
      if (!ok) {
        handleGenerationStartFailed(data.error)
        return
      }
      pollGenerationInBackground(data.jobId)
    })

    setTimeout(() => enterChat(), GENERATING_SCREEN_MS)
  }
  genRetryBtn.addEventListener('click', startGeneration)

  function handleGenerationStartFailed(errorMessage) {
    // 아직 로딩 화면이면 재시도 버튼으로, 이미 채팅에 들어와 있으면
    // 채팅 안내 문구로 알려준다.
    if (state.chatEntered) {
      appendSystemNote('사진 생성을 시작하지 못했어요' + (errorMessage ? ` (${errorMessage})` : ''))
    } else {
      genStatusText.textContent = '오류: ' + (errorMessage || '생성 시작 실패')
      genRetryBtn.classList.remove('hidden')
    }
  }

  function pollGenerationInBackground(jobId) {
    const interval = setInterval(async () => {
      const { ok, data } = await api('/api/generate/status/' + jobId)
      if (!ok) return // 일시적 오류 — 다음 폴링에서 재시도
      if (data.status === 'done') {
        clearInterval(interval)
        handleGeneratedImage(data.resultUrl, jobId)
      } else if (data.status === 'failed') {
        clearInterval(interval)
        handleGenerationFailed(data.errorMessage)
      }
    }, 3000)
  }

  async function handleGeneratedImage(url, jobId) {
    localStorage.setItem(RESULT_URL_KEY, url)
    state.petAvatarUrl = url
    // 방금 생성된 이미지를 반려동물 프로필 대표사진으로도 저장 — 아래에서
    // avatar-proxy가 이 값을 그대로 읽어오므로, 프록시 URL을 쓰기 전에
    // 저장이 끝나길 기다린다(레이스 방지).
    await api('/api/chat/pets', { method: 'POST', body: JSON.stringify({ petId: state.petId, avatarUrl: url }) })

    // 사진을 그냥 던지지 않고, 반려동물이 곁들이는 짧은 한마디("어제 꿈에서
    // 나왔던 장면이야" 같은)를 먼저 받아서 사진과 함께 보여준다. jobId를
    // 같이 보내면 서버가 이미지 메시지도 대화 이력에 영구 저장해서, 채팅을
    // 나갔다 다시 들어와도(새로고침 등) 썸네일이 사라지지 않는다.
    const { ok, data } = await api('/api/chat/pets/' + state.petId + '/photo-caption', {
      method: 'POST',
      body: JSON.stringify({ jobId }),
    })
    const caption = ok ? data.caption : null

    if (state.chatEntered) {
      if (caption) appendMessage('pet', caption)
      appendPetImageMessage(jobId)
    } else {
      state.pendingImageUrl = url
      state.pendingImageJobId = jobId
      state.pendingImageCaption = caption
    }
  }

  function handleGenerationFailed(errorMessage) {
    if (state.chatEntered) {
      appendSystemNote('사진을 만드는 데 문제가 생겼어요' + (errorMessage ? ` (${errorMessage})` : ''))
    } else {
      state.pendingGenerationError = errorMessage || true
    }
  }

  // ── 4. 채팅 ──
  const chatMessagesEl = document.getElementById('chat-messages')
  const chatScrollEl = document.getElementById('chat-scroll')
  const chatInput = document.getElementById('chat-input')
  const chatSendBtn = document.getElementById('chat-send')
  const lightboxOverlay = document.getElementById('image-lightbox')
  const lightboxImg = document.getElementById('image-lightbox-img')

  function openLightbox(url) {
    lightboxImg.src = url
    lightboxOverlay.classList.remove('hidden')
  }
  lightboxOverlay.addEventListener('click', () => lightboxOverlay.classList.add('hidden'))

  // AtlasCloud가 "완료" 상태를 반환한 직후에도 실제 파일이 CDN에 아직 다
  // 전파되지 않아 이미지가 깨져서 뜨는 경우가 있었음(2026-09-10) — 로드
  // 실패 시 캐시를 우회해서 잠깐 텀을 두고 재시도하고, 그래도 안 되면
  // onGiveUp으로 대체 UI를 보여준다.
  const IMAGE_LOAD_MAX_RETRIES = 10
  const IMAGE_LOAD_RETRY_DELAY_MS = 3000
  function setImageWithRetry(imgEl, url, attempt, onGiveUp) {
    attempt = attempt || 0
    imgEl.onerror = () => {
      if (attempt < IMAGE_LOAD_MAX_RETRIES) {
        setTimeout(() => setImageWithRetry(imgEl, url, attempt + 1, onGiveUp), IMAGE_LOAD_RETRY_DELAY_MS)
      } else if (onGiveUp) {
        onGiveUp()
      }
    }
    imgEl.src = attempt === 0 ? url : url + (url.includes('?') ? '&' : '?') + '_retry=' + attempt
  }

  function makeAvatarFallbackEl() {
    const fallback = document.createElement('div')
    fallback.className = 'avatar-fallback'
    fallback.textContent = '🐾'
    return fallback
  }

  // 프로필 이미지 URL이 없거나 로드에 실패하면 깨진 이미지 아이콘 대신
  // 발바닥 이모지 아바타로 대체한다.
  function makeAvatarEl() {
    if (!state.petAvatarUrl || !state.petId) return makeAvatarFallbackEl()
    const avatar = document.createElement('img')
    avatar.className = 'w-8 h-8 rounded-full object-cover border flex-shrink-0 cursor-pointer'
    const proxiedUrl = avatarProxyUrl(state.petId)
    avatar.addEventListener('click', () => openLightbox(proxiedUrl))
    setImageWithRetry(avatar, proxiedUrl, 0, () => avatar.replaceWith(makeAvatarFallbackEl()))
    return avatar
  }

  // 카카오톡처럼 반려동물 메시지는 위에 프로필 사진+이름을 붙여서 보여준다
  function makePetMessageRow(contentEl) {
    const row = document.createElement('div')
    row.className = 'flex items-start gap-2'
    row.appendChild(makeAvatarEl())

    const col = document.createElement('div')
    const nameEl = document.createElement('div')
    nameEl.className = 'text-xs text-gray-500 mb-1'
    nameEl.textContent = state.petName || '반려동물'
    col.appendChild(nameEl)
    col.appendChild(contentEl)

    row.appendChild(col)
    return row
  }

  function appendMessage(role, content) {
    if (role !== 'pet') {
      const div = document.createElement('div')
      div.className = 'text-right'
      const bubble = document.createElement('span')
      bubble.className = 'bubble-user inline-block max-w-[80%]'
      bubble.textContent = content
      div.appendChild(bubble)
      chatMessagesEl.appendChild(div)
      chatScrollEl.scrollTop = chatScrollEl.scrollHeight
      return
    }

    const bubble = document.createElement('span')
    bubble.className = 'bubble-pet inline-block max-w-[80%]'
    bubble.textContent = content
    chatMessagesEl.appendChild(makePetMessageRow(bubble))
    chatScrollEl.scrollTop = chatScrollEl.scrollHeight
  }

  // 사진 합성이 끝나면 반려동물 메시지로 썸네일을 보낸다 — 클릭하면 큰
  // 이미지로 볼 수 있다.
  //
  // ⚠️ width:30%를 CSS로만 주면 안 된다 — 이 썸네일은 flex-basis가 auto인
  // flex item(col) 안에 들어있어서, col 자체의 너비가 "내용 기준"으로
  // 정해지는 상태에서 이미지가 아직 로드되기 전이면 퍼센트 너비를 해석할
  // 기준(정해진 너비)이 없다. 그러면 브라우저가 깨진 이미지 아이콘의 아주
  // 작은 고유 크기를 기준으로 col 너비를 계산해버려서, 썸네일이 세로로 한
  // 글자씩 줄바꿈되는 기형적인 크기로 보이고, 재시도할 때마다 크기가
  // 요동쳐 깜빡이는 것처럼 보인다(2026-09-10). 채팅창 자체의 실제 픽셀
  // 너비를 JS로 계산해서 고정 px로 지정하면 이 순환 참조가 생기지 않는다.
  function appendPetImageMessage(jobId) {
    const proxiedUrl = avatarProxyUrl(state.petId, jobId)
    const thumb = document.createElement('img')
    thumb.className = 'chat-thumb'
    thumb.alt = '생성된 사진'
    const thumbWidthPx = Math.max(72, Math.round(chatMessagesEl.clientWidth * 0.3))
    thumb.style.width = thumbWidthPx + 'px'
    thumb.addEventListener('click', () => openLightbox(proxiedUrl))
    chatMessagesEl.appendChild(makePetMessageRow(thumb))
    chatScrollEl.scrollTop = chatScrollEl.scrollHeight

    setImageWithRetry(thumb, proxiedUrl, 0, () => {
      const fallback = document.createElement('div')
      fallback.className = 'chat-thumb chat-thumb-fallback'
      fallback.style.width = thumbWidthPx + 'px'
      fallback.textContent = '🐾'
      fallback.title = '사진을 불러오지 못했어요'
      thumb.replaceWith(fallback)
    })
  }

  function appendSystemNote(text) {
    const div = document.createElement('div')
    div.className = 'text-center text-xs text-gray-400 py-1'
    div.textContent = text
    chatMessagesEl.appendChild(div)
    chatScrollEl.scrollTop = chatScrollEl.scrollHeight
  }

  async function enterChat() {
    state.chatEntered = true
    if (!state.petName || !state.petAvatarUrl) {
      const { ok, data } = await api('/api/chat/pets')
      const pet = ok ? (data.pets || []).find((p) => p.id === state.petId) : null
      if (pet) {
        state.petName = state.petName || pet.name
        state.petAvatarUrl = state.petAvatarUrl || pet.avatar_url
      }
    }
    showStep('step-chat')
    chatMessagesEl.innerHTML = ''

    const { ok, data } = await api('/api/chat/pets/' + state.petId + '/greeting', { method: 'POST' })
    // generation_id가 있는 메시지는 텍스트가 아니라 그 job의 결과 이미지를
    // 썸네일로 보여준다 — 채팅을 나갔다 다시 들어와도 사진이 재구성되는 이유.
    if (ok) {
      ;(data.messages || []).forEach((m) => {
        if (m.generation_id) appendPetImageMessage(m.generation_id)
        else appendMessage(m.role, m.content)
      })
    }

    // 채팅으로 넘어오기 전에 이미 사진 생성이 끝났다면(또는 실패했다면)
    // 여기서 바로 반영한다.
    if (state.pendingImageUrl) {
      if (state.pendingImageCaption) appendMessage('pet', state.pendingImageCaption)
      appendPetImageMessage(state.pendingImageJobId)
      state.pendingImageUrl = null
      state.pendingImageJobId = null
      state.pendingImageCaption = null
    } else if (state.pendingGenerationError) {
      const errorMessage = typeof state.pendingGenerationError === 'string' ? state.pendingGenerationError : ''
      appendSystemNote('사진을 만드는 데 문제가 생겼어요' + (errorMessage ? ` (${errorMessage})` : ''))
      state.pendingGenerationError = null
    }

    checkDailyMemory()
  }

  // "오늘의 추억사진" — 채팅에 들어올 때마다 확인한다. 서버가 하루에 한 번만
  // 실제로 생성/알림을 하도록 멱등하게 처리하므로(generation_logs.source=
  // 'daily_memory' + notified), 여기서는 그냥 매번 호출하면 된다.
  async function checkDailyMemory() {
    const { ok, data } = await api('/api/chat/pets/' + state.petId + '/daily-memory', { method: 'POST' })
    if (!ok) return
    if (data.status === 'processing' || data.status === 'pending') {
      pollDailyMemoryInBackground(data.jobId)
    } else if (data.status === 'done' && data.resultReady && data.caption) {
      appendMessage('pet', data.caption)
      appendPetImageMessage(data.jobId)
    }
    // 'no_photos' | 'failed' | 이미 알림 완료 → 조용히 아무것도 하지 않음
  }

  function pollDailyMemoryInBackground(jobId) {
    const interval = setInterval(async () => {
      const { ok, data } = await api('/api/generate/status/' + jobId)
      if (!ok) return
      if (data.status === 'done' || data.status === 'failed') {
        clearInterval(interval)
        // 상태와 무관하게 daily-memory를 다시 호출해서 캡션 생성+채팅 반영
        // (또는 조용한 실패 처리)을 마무리한다.
        checkDailyMemory()
      }
    }, 3000)
  }

  let sending = false
  async function sendChat() {
    if (sending) return // 한 번에 하나의 메시지만 — 중복 전송 방지
    const content = chatInput.value.trim()
    if (!content) return
    sending = true
    chatSendBtn.disabled = true
    chatInput.disabled = true
    chatInput.value = ''
    appendMessage('user', content)
    try {
      const { ok, data } = await api('/api/chat/pets/' + state.petId + '/messages', {
        method: 'POST',
        body: JSON.stringify({ content }),
      })
      if (!ok) {
        appendMessage('pet', '[오류] ' + (data.error || '응답 실패'))
      } else {
        appendMessage('pet', data.reply)
      }
    } finally {
      sending = false
      chatSendBtn.disabled = false
      chatInput.disabled = false
      chatInput.focus()
    }
  }
  chatSendBtn.addEventListener('click', sendChat)
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      sendChat()
    }
  })

  document.getElementById('restart').addEventListener('click', () => {
    localStorage.removeItem(PET_ID_KEY)
    localStorage.removeItem(RESULT_URL_KEY)
    location.reload()
  })

  // ── 시작 ──
  ;(async function init() {
    const loggedIn = await checkExistingLogin()
    if (loggedIn) {
      afterLogin()
    } else {
      showStep('step-login')
    }
  })()
})()
