// 내새끼 QA 테스트 페이지 로직 (vanilla JS) — /test 전용, 실제 앱 UI 아님
;(function () {
  const TOKEN_KEY = 'neseggi_test_session_token'
  const PET_ID_KEY = 'neseggi_test_pet_id'
  const RESULT_URL_KEY = 'neseggi_test_result_url'

  const state = {
    petId: localStorage.getItem(PET_ID_KEY) || null,
    petName: null,
    petAvatarUrl: localStorage.getItem(RESULT_URL_KEY) || null,
    ownerTitle: null,
    petPhoto: null,
    ownerPhoto: null,
    bgPhoto: null,
    // 채팅 화면으로 넘어가기 전에 사진 생성이 끝나버린 경우, 채팅 진입 후
    // 바로 썸네일 메시지를 보낼 수 있도록 대기시켜두는 값들
    chatEntered: false,
    pendingImageUrl: null,
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

  // 반려동물 사진은 미리보기와 동시에 종/품종을 사진으로 자동 분류한다(사용자
  // 직접 입력 없음). 선택 즉시 백그라운드로 분류 요청을 보내고, "다음단계"를
  // 누를 때 아직 안 끝났으면 그때 기다린다.
  let speciesPromise = null
  const petPhotoPreview = document.getElementById('pet-photo-preview')
  const petPhotoLabel = document.getElementById('pet-photo-label')
  const petSpeciesHint = document.getElementById('pet-species-hint')
  document.getElementById('pet-photo').addEventListener('change', async () => {
    const file = document.getElementById('pet-photo').files[0]
    if (!file) {
      petPhotoPreview.classList.add('hidden')
      petPhotoLabel.classList.remove('hidden')
      petSpeciesHint.textContent = ''
      speciesPromise = null
      return
    }
    petPhotoPreview.src = URL.createObjectURL(file)
    petPhotoPreview.classList.remove('hidden')
    petPhotoLabel.classList.add('hidden')
    petSpeciesHint.textContent = '종을 확인하고 있어요...'

    state.petPhoto = await normalizeImageFile(file)
    speciesPromise = api('/api/chat/classify-species', {
      method: 'POST',
      body: JSON.stringify({ image: state.petPhoto }),
    }).then(({ ok, data }) => {
      const species = ok ? data.species : ''
      petSpeciesHint.textContent = species ? `${species}로 확인했어요` : ''
      return species || ''
    })
  })

  function randomHex(len) {
    const bytes = new Uint8Array(len)
    crypto.getRandomValues(bytes)
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  // ── 익명 세션: 로그인 화면 없이 바로 테스트 진행 ──
  async function ensureSession() {
    const token = getToken()
    if (token) {
      const { ok } = await api('/api/auth/me')
      if (ok) return
    }
    const email = `test_${randomHex(6)}@neseggi.local`
    const password = randomHex(8)
    const { ok, data } = await api('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name: '테스터', email, password }),
    })
    if (!ok) {
      alert('테스트 세션 생성 실패: ' + (data.error || ''))
      return
    }
    setToken(data.token)
  }

  // ── 단계 전환 ──
  const steps = ['step-pet', 'step-title', 'step-owner-photo', 'step-bg-photo', 'step-generating', 'step-chat']
  const progressDots = Array.from(document.querySelectorAll('#progress-dots span'))
  function showStep(id) {
    steps.forEach((s) => document.getElementById(s).classList.toggle('hidden', s !== id))
    const activeGroup = document.getElementById(id).dataset.group
    progressDots.forEach((dot) => dot.classList.toggle('active', dot.dataset.group === activeGroup))
  }

  // ── 1. 반려동물 프로필 ──
  document.getElementById('step-pet-next').addEventListener('click', async () => {
    const name = document.getElementById('pet-name').value.trim()
    if (!name) {
      alert('이름을 입력해주세요.')
      return
    }
    const photoFile = document.getElementById('pet-photo').files[0]
    if (!photoFile || !state.petPhoto) {
      alert('반려동물 사진을 선택해주세요.')
      return
    }

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
    showStep('step-title')
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

  async function startGeneration() {
    showStep('step-generating')
    genStatusText.textContent = ''
    state.chatEntered = false
    state.pendingImageUrl = null
    state.pendingGenerationError = null

    if (!state.petPhoto) {
      // 정상 흐름이면 1단계에서 이미 필수로 막혀서 여기 도달할 수 없다 —
      // 혹시라도 상태가 꼬였을 때 조용히 건너뛰지 않고 명확히 되돌린다.
      alert('반려동물 사진이 없어서 합성을 진행할 수 없어요. 처음부터 다시 시작해주세요.')
      showStep('step-pet')
      return
    }

    const body = { petImage: state.petPhoto, concept: 'studio' }
    if (state.ownerPhoto) body.ownerImage = state.ownerPhoto
    if (state.bgPhoto) body.backgroundImage = state.bgPhoto

    const { ok, data } = await api('/api/generate/start', {
      method: 'POST',
      headers: { 'X-Neseggi-QA': '1' }, // QA 테스트 페이지 전용 — 크레딧 차감 우회
      body: JSON.stringify(body),
    })
    if (!ok) {
      genStatusText.textContent = '오류: ' + (data.error || '생성 시작 실패')
      return
    }
    pollGenerationInBackground(data.jobId)
    setTimeout(() => enterChat(), GENERATING_SCREEN_MS)
  }

  function pollGenerationInBackground(jobId) {
    const interval = setInterval(async () => {
      const { ok, data } = await api('/api/generate/status/' + jobId)
      if (!ok) return // 일시적 오류 — 다음 폴링에서 재시도
      if (data.status === 'done') {
        clearInterval(interval)
        handleGeneratedImage(data.resultUrl)
      } else if (data.status === 'failed') {
        clearInterval(interval)
        handleGenerationFailed(data.errorMessage)
      }
    }, 3000)
  }

  function handleGeneratedImage(url) {
    localStorage.setItem(RESULT_URL_KEY, url)
    state.petAvatarUrl = url
    // 방금 생성된 이미지를 반려동물 프로필 대표사진으로도 저장
    api('/api/chat/pets', { method: 'POST', body: JSON.stringify({ petId: state.petId, avatarUrl: url }) })
    if (state.chatEntered) {
      appendPetImageMessage(url)
    } else {
      state.pendingImageUrl = url
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

  // 프로필 이미지 URL이 없거나(캐시된 예전 URL 만료 등) 로드에 실패하면
  // 깨진 이미지 아이콘 대신 발바닥 이모지 아바타로 대체한다.
  function makeAvatarEl() {
    if (!state.petAvatarUrl) {
      const fallback = document.createElement('div')
      fallback.className = 'avatar-fallback'
      fallback.textContent = '🐾'
      return fallback
    }
    const avatar = document.createElement('img')
    avatar.className = 'w-8 h-8 rounded-full object-cover border flex-shrink-0'
    avatar.src = state.petAvatarUrl
    avatar.addEventListener(
      'error',
      () => {
        const fallback = document.createElement('div')
        fallback.className = 'avatar-fallback'
        fallback.textContent = '🐾'
        avatar.replaceWith(fallback)
      },
      { once: true }
    )
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
  function appendPetImageMessage(url) {
    const thumb = document.createElement('img')
    thumb.className = 'chat-thumb'
    thumb.src = url
    thumb.alt = '생성된 사진'
    thumb.addEventListener('click', () => openLightbox(url))
    chatMessagesEl.appendChild(makePetMessageRow(thumb))
    chatScrollEl.scrollTop = chatScrollEl.scrollHeight
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
    if (ok) (data.messages || []).forEach((m) => appendMessage(m.role, m.content))

    // 채팅으로 넘어오기 전에 이미 사진 생성이 끝났다면(또는 실패했다면)
    // 여기서 바로 반영한다.
    if (state.pendingImageUrl) {
      appendPetImageMessage(state.pendingImageUrl)
      state.pendingImageUrl = null
    } else if (state.pendingGenerationError) {
      const errorMessage = typeof state.pendingGenerationError === 'string' ? state.pendingGenerationError : ''
      appendSystemNote('사진을 만드는 데 문제가 생겼어요' + (errorMessage ? ` (${errorMessage})` : ''))
      state.pendingGenerationError = null
    }
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
    await ensureSession()
    if (state.petId) {
      // 이미 진행했던 반려동물이 있으면 바로 채팅으로 (프로필/사진 단계 생략)
      enterChat()
    } else {
      showStep('step-pet')
    }
  })()
})()
