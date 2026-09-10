// 내새끼 QA 테스트 페이지 로직 (vanilla JS) — /test 전용, 실제 앱 UI 아님
;(function () {
  const TOKEN_KEY = 'neseggi_test_session_token'
  const PET_ID_KEY = 'neseggi_test_pet_id'
  const RESULT_URL_KEY = 'neseggi_test_result_url'

  const state = {
    petId: localStorage.getItem(PET_ID_KEY) || null,
    ownerTitle: null,
    petPhoto: null,
    ownerPhoto: null,
    bgPhoto: null,
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
  function showStep(id) {
    steps.forEach((s) => document.getElementById(s).classList.toggle('hidden', s !== id))
  }

  // ── 1. 반려동물 프로필 ──
  document.getElementById('step-pet-next').addEventListener('click', async () => {
    const name = document.getElementById('pet-name').value.trim()
    if (!name) {
      alert('이름을 입력해주세요.')
      return
    }
    const photoFile = document.getElementById('pet-photo').files[0]
    if (!photoFile) {
      alert('반려동물 사진을 선택해주세요.')
      return
    }
    state.petPhoto = await fileToDataUrl(photoFile)

    const species = document.getElementById('pet-species').value.trim()
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
    btn.className = 'border rounded-full px-4 py-2 text-sm'
    btn.addEventListener('click', () => {
      selectedTitle = t
      document.getElementById('title-custom').value = ''
      Array.from(titleOptionsEl.children).forEach((el) => el.classList.remove('bg-pink-500', 'text-white'))
      btn.classList.add('bg-pink-500', 'text-white')
    })
    titleOptionsEl.appendChild(btn)
  })
  document.getElementById('title-custom').addEventListener('input', () => {
    selectedTitle = null
    Array.from(titleOptionsEl.children).forEach((el) => el.classList.remove('bg-pink-500', 'text-white'))
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
    state.ownerPhoto = file ? await fileToDataUrl(file) : null
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
    state.bgPhoto = file ? await fileToDataUrl(file) : null
    startGeneration()
  })

  // ── 3. 사진 합성 ──
  const genStatusText = document.getElementById('gen-status-text')

  async function startGeneration() {
    showStep('step-generating')
    genStatusText.textContent = ''

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
    pollGeneration(data.jobId)
  }

  function pollGeneration(jobId) {
    const interval = setInterval(async () => {
      const { ok, data } = await api('/api/generate/status/' + jobId)
      if (!ok) {
        clearInterval(interval)
        genStatusText.textContent = '상태 조회 실패'
        return
      }
      if (data.status === 'done') {
        clearInterval(interval)
        enterChat(data.resultUrl)
      } else if (data.status === 'failed') {
        clearInterval(interval)
        genStatusText.textContent = '실패: ' + (data.errorMessage || '알 수 없는 오류')
      } else {
        genStatusText.textContent = '상태: ' + data.status
      }
    }, 3000)
  }

  // ── 4. 채팅 ──
  const chatMessagesEl = document.getElementById('chat-messages')
  const chatHeroImage = document.getElementById('chat-hero-image')
  const chatHeroImageWrap = document.getElementById('chat-hero-image-wrap')
  const chatInput = document.getElementById('chat-input')
  const chatSendBtn = document.getElementById('chat-send')

  function appendMessage(role, content) {
    const div = document.createElement('div')
    const isPet = role === 'pet'
    div.className = isPet ? 'text-left' : 'text-right'
    const bubble = document.createElement('span')
    bubble.className = isPet
      ? 'inline-block bg-white border rounded-lg px-3 py-2 max-w-[80%]'
      : 'inline-block bg-pink-500 text-white rounded-lg px-3 py-2 max-w-[80%]'
    bubble.textContent = content
    div.appendChild(bubble)
    chatMessagesEl.appendChild(div)
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight
  }

  async function enterChat(resultUrl) {
    if (resultUrl) {
      localStorage.setItem(RESULT_URL_KEY, resultUrl)
      chatHeroImage.src = resultUrl
      chatHeroImageWrap.classList.remove('hidden')
    }
    showStep('step-chat')
    chatMessagesEl.innerHTML = ''

    const { ok, data } = await api('/api/chat/pets/' + state.petId + '/greeting', { method: 'POST' })
    if (ok) (data.messages || []).forEach((m) => appendMessage(m.role, m.content))
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
      const savedUrl = localStorage.getItem(RESULT_URL_KEY)
      enterChat(savedUrl || null)
    } else {
      showStep('step-pet')
    }
  })()
})()
