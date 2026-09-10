// 내새끼 QA 테스트 페이지 로직 (vanilla JS) — /test 전용, 실제 앱 UI 아님
;(function () {
  const TOKEN_KEY = 'neseggi_test_session_token'
  let currentPetId = null
  let currentPetName = null

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

  // ── 인증 ──
  const authLoggedOut = document.getElementById('auth-logged-out')
  const authLoggedIn = document.getElementById('auth-logged-in')
  const authMessage = document.getElementById('auth-message')

  async function refreshAuthUI() {
    const token = getToken()
    if (!token) {
      authLoggedOut.classList.remove('hidden')
      authLoggedIn.classList.remove('flex')
      authLoggedIn.classList.add('hidden')
      return
    }
    const { ok, data } = await api('/api/auth/me')
    if (!ok) {
      setToken(null)
      authLoggedOut.classList.remove('hidden')
      authLoggedIn.classList.add('hidden')
      return
    }
    authLoggedOut.classList.add('hidden')
    authLoggedIn.classList.remove('hidden')
    authLoggedIn.classList.add('flex')
    document.getElementById('auth-email-display').textContent = data.user.email
    document.getElementById('auth-credits').textContent = data.user.credits
    loadPets()
  }

  document.getElementById('btn-signup').addEventListener('click', async () => {
    const name = document.getElementById('auth-name').value
    const email = document.getElementById('auth-email').value
    const password = document.getElementById('auth-password').value
    const { ok, data } = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name, email, password }) })
    if (!ok) {
      authMessage.textContent = data.error || '회원가입 실패'
      return
    }
    setToken(data.token)
    authMessage.textContent = ''
    refreshAuthUI()
  })

  document.getElementById('btn-login').addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value
    const password = document.getElementById('auth-password').value
    const { ok, data } = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
    if (!ok) {
      authMessage.textContent = data.error || '로그인 실패'
      return
    }
    setToken(data.token)
    authMessage.textContent = ''
    refreshAuthUI()
  })

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' })
    setToken(null)
    currentPetId = null
    refreshAuthUI()
  })

  // ── 반려동물 프로필 ──
  const petList = document.getElementById('pet-list')

  async function loadPets() {
    const { ok, data } = await api('/api/chat/pets')
    if (!ok) return
    petList.innerHTML = ''
    ;(data.pets || []).forEach((pet) => {
      const btn = document.createElement('button')
      btn.textContent = pet.name
      btn.className = 'border rounded-full px-3 py-1 text-sm hover:bg-pink-50'
      btn.addEventListener('click', () => selectPet(pet.id, pet.name))
      petList.appendChild(btn)
    })
  }

  document.getElementById('btn-create-pet').addEventListener('click', async () => {
    const name = document.getElementById('pet-name').value
    const species = document.getElementById('pet-species').value
    const personality = document.getElementById('pet-personality').value
    const { ok, data } = await api('/api/chat/pets', {
      method: 'POST',
      body: JSON.stringify({ name, species, personality }),
    })
    if (!ok) {
      alert(data.error || '반려동물 등록 실패')
      return
    }
    loadPets()
    selectPet(data.pet.id, data.pet.name)
  })

  // ── 채팅 ──
  const chatMessagesEl = document.getElementById('chat-messages')
  const chatPetNameEl = document.getElementById('chat-pet-name')

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

  async function selectPet(petId, petName) {
    currentPetId = petId
    currentPetName = petName
    chatPetNameEl.textContent = petName
    chatMessagesEl.innerHTML = ''
    const { ok, data } = await api('/api/chat/pets/' + petId + '/messages')
    if (ok) (data.messages || []).forEach((m) => appendMessage(m.role, m.content))
  }

  document.getElementById('btn-send-chat').addEventListener('click', sendChat)
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat()
  })

  async function sendChat() {
    if (!currentPetId) {
      alert('먼저 반려동물을 선택하세요.')
      return
    }
    const input = document.getElementById('chat-input')
    const content = input.value.trim()
    if (!content) return
    input.value = ''
    appendMessage('user', content)
    const { ok, data } = await api('/api/chat/pets/' + currentPetId + '/messages', {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
    if (!ok) {
      appendMessage('pet', '[오류] ' + (data.error || '응답 실패'))
      return
    }
    appendMessage('pet', data.reply)
  }

  // ── 사진 합성 ──
  const genStatus = document.getElementById('gen-status')
  const genResult = document.getElementById('gen-result')

  document.getElementById('btn-generate').addEventListener('click', async () => {
    const petFile = document.getElementById('gen-pet-file').files[0]
    const ownerFile = document.getElementById('gen-owner-file').files[0]
    const bgFile = document.getElementById('gen-bg-file').files[0]
    const concept = document.getElementById('gen-concept').value

    if (!petFile || !ownerFile) {
      alert('반려동물 사진과 보호자 사진은 필수입니다.')
      return
    }

    genStatus.textContent = '업로드 중...'
    genResult.classList.add('hidden')

    const [petImage, ownerImage, backgroundImage] = await Promise.all([
      fileToDataUrl(petFile),
      fileToDataUrl(ownerFile),
      fileToDataUrl(bgFile),
    ])

    const body = { petImage, ownerImage, concept }
    if (backgroundImage) body.backgroundImage = backgroundImage

    const { ok, data } = await api('/api/generate/start', { method: 'POST', body: JSON.stringify(body) })
    if (!ok) {
      genStatus.textContent = '오류: ' + (data.error || '생성 시작 실패')
      return
    }

    genStatus.textContent = '생성 중... (jobId: ' + data.jobId + ')'
    pollGeneration(data.jobId)
  })

  function pollGeneration(jobId) {
    const interval = setInterval(async () => {
      const { ok, data } = await api('/api/generate/status/' + jobId)
      if (!ok) {
        clearInterval(interval)
        genStatus.textContent = '상태 조회 실패'
        return
      }
      if (data.status === 'done') {
        clearInterval(interval)
        genStatus.textContent = '완료!'
        genResult.src = data.resultUrl
        genResult.classList.remove('hidden')
        refreshAuthUI() // 크레딧 갱신
      } else if (data.status === 'failed') {
        clearInterval(interval)
        genStatus.textContent = '실패: ' + (data.errorMessage || '알 수 없는 오류')
      } else {
        genStatus.textContent = '생성 중... (' + data.status + ')'
      }
    }, 3000)
  }

  refreshAuthUI()
})()
