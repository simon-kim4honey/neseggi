// 내새끼 관리자 페이지 로직 (vanilla JS) — /admin 전용
;(function () {
  const PW_KEY = 'neseggi_admin_password'

  function getPw() {
    return localStorage.getItem(PW_KEY)
  }
  function setPw(pw) {
    if (pw) localStorage.setItem(PW_KEY, pw)
    else localStorage.removeItem(PW_KEY)
  }

  async function adminApi(path) {
    const res = await fetch(path, { headers: { 'X-Admin-Password': getPw() || '' } })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, data }
  }

  const loginEl = document.getElementById('admin-login')
  const contentEl = document.getElementById('admin-content')
  const loginError = document.getElementById('admin-login-error')
  const listEl = document.getElementById('admin-list')

  const STATUS_LABELS = { pending: '대기', processing: '진행중', done: '완료', failed: '실패' }
  const SOURCE_LABELS = { manual: '수동 합성', daily_memory: '오늘의 추억사진' }

  function renderGenerations(items) {
    listEl.innerHTML = ''
    if (items.length === 0) {
      listEl.innerHTML = '<p class="text-sm text-gray-400">생성 기록이 없습니다.</p>'
      return
    }
    items.forEach((g) => {
      const card = document.createElement('div')
      card.className = 'bg-white rounded-2xl p-4 shadow-sm border border-gray-100 space-y-2'

      const header = document.createElement('div')
      header.className = 'flex justify-between items-start text-sm gap-2'
      const who = document.createElement('div')
      who.innerHTML = '<strong></strong>'
      who.querySelector('strong').textContent = g.pet_name || '(알 수 없는 반려동물)'
      who.appendChild(document.createTextNode(' · ' + (g.user_email || g.user_id || '')))
      const when = document.createElement('div')
      when.className = 'text-xs text-gray-400 whitespace-nowrap'
      when.textContent = g.created_at
      header.appendChild(who)
      header.appendChild(when)
      card.appendChild(header)

      const meta = document.createElement('div')
      meta.className = 'text-xs text-gray-500'
      meta.textContent =
        '상태: ' +
        (STATUS_LABELS[g.status] || g.status) +
        ' · 종류: ' +
        (SOURCE_LABELS[g.source] || g.source) +
        ' · 컨셉: ' +
        (g.concept || '-') +
        (g.error_message ? ' · 오류: ' + g.error_message : '')
      card.appendChild(meta)

      if (g.status === 'done') {
        const img = document.createElement('img')
        img.className = 'w-24 h-24 object-cover rounded-lg border'
        img.alt = '결과 이미지'
        img.src = '/api/admin/generations/' + g.id + '/image'
        img.addEventListener('error', () => img.remove())
        card.appendChild(img)
      }

      const promptLabel = document.createElement('div')
      promptLabel.className = 'text-xs font-medium text-gray-600 mt-1'
      promptLabel.textContent = 'AtlasCloud에 전달된 프롬프트'
      card.appendChild(promptLabel)

      const pre = document.createElement('pre')
      pre.className =
        'text-xs whitespace-pre-wrap bg-gray-50 rounded-lg p-2 max-h-48 overflow-y-auto border border-gray-100'
      pre.textContent = g.prompt || '(저장된 프롬프트 없음 — 이 기능 추가 이전 job)'
      card.appendChild(pre)

      listEl.appendChild(card)
    })
  }

  async function loadGenerations() {
    const { ok, status, data } = await adminApi('/api/admin/generations?limit=100')
    if (!ok) {
      if (status === 401) {
        setPw(null)
        contentEl.classList.add('hidden')
        loginEl.classList.remove('hidden')
        loginError.textContent = '비밀번호가 올바르지 않아요.'
      }
      return
    }
    renderGenerations(data.generations || [])
  }

  document.getElementById('admin-login-btn').addEventListener('click', async () => {
    loginError.textContent = ''
    const pw = document.getElementById('admin-password').value
    setPw(pw)
    const { ok, status } = await adminApi('/api/admin/generations?limit=1')
    if (!ok) {
      setPw(null)
      loginError.textContent = status === 401 ? '비밀번호가 올바르지 않아요.' : '확인 실패'
      return
    }
    loginEl.classList.add('hidden')
    contentEl.classList.remove('hidden')
    loadGenerations()
  })

  document.getElementById('admin-refresh').addEventListener('click', loadGenerations)
  document.getElementById('admin-logout').addEventListener('click', () => {
    setPw(null)
    location.reload()
  })

  ;(function init() {
    if (getPw()) {
      loginEl.classList.add('hidden')
      contentEl.classList.remove('hidden')
      loadGenerations()
    }
  })()
})()
