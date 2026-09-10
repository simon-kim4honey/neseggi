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
  const PURPOSE_LABELS = {
    classify_species: '종 자동분류',
    greeting: '첫 인사',
    photo_caption: '합성사진 캡션',
    daily_memory_caption: '오늘의 추억사진 캡션',
    chat_reply: '채팅 응답',
  }

  // ── 탭 전환 (사진 합성 프롬프트 / Claude API 사용량) ──
  const tabGenerationsBtn = document.getElementById('admin-tab-generations')
  const tabUsageBtn = document.getElementById('admin-tab-usage')
  const panelGenerations = document.getElementById('admin-panel-generations')
  const panelUsage = document.getElementById('admin-panel-usage')
  let activeTab = 'generations'

  function setActiveTab(tab) {
    activeTab = tab
    panelGenerations.classList.toggle('hidden', tab !== 'generations')
    panelUsage.classList.toggle('hidden', tab !== 'usage')
    if (tab === 'usage') loadUsage()
    else loadGenerations()
  }
  tabGenerationsBtn.addEventListener('click', () => setActiveTab('generations'))
  tabUsageBtn.addEventListener('click', () => setActiveTab('usage'))

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

  // ── Claude API 사용자별 사용량/추정 비용 ──
  const usageListEl = document.getElementById('admin-usage-list')
  const usageTotalEl = document.getElementById('admin-usage-total')
  const usageFromEl = document.getElementById('admin-usage-from')
  const usageToEl = document.getElementById('admin-usage-to')

  function formatUsd(n) {
    return '$' + n.toFixed(4)
  }

  function renderUsage(users, totalCostUsd) {
    usageTotalEl.textContent = '전체 추정 비용: ' + formatUsd(totalCostUsd) + ' (사용자 ' + users.length + '명)'
    usageListEl.innerHTML = ''
    if (users.length === 0) {
      usageListEl.innerHTML = '<p class="text-sm text-gray-400">해당 기간에 사용 기록이 없습니다.</p>'
      return
    }
    users.forEach((u) => {
      const card = document.createElement('div')
      card.className = 'bg-white rounded-2xl p-4 shadow-sm border border-gray-100 space-y-2'

      const header = document.createElement('div')
      header.className = 'flex justify-between items-start text-sm gap-2'
      const who = document.createElement('div')
      who.innerHTML = '<strong></strong>'
      who.querySelector('strong').textContent = u.userName || u.userEmail || u.userId
      if (u.userName && u.userEmail) who.appendChild(document.createTextNode(' · ' + u.userEmail))
      const cost = document.createElement('div')
      cost.className = 'font-semibold text-sm'
      cost.textContent = formatUsd(u.estimatedCostUsd)
      header.appendChild(who)
      header.appendChild(cost)
      card.appendChild(header)

      const meta = document.createElement('div')
      meta.className = 'text-xs text-gray-500'
      meta.textContent =
        '호출 ' +
        u.callCount +
        '회 · 입력 ' +
        u.inputTokens.toLocaleString() +
        ' tok · 출력 ' +
        u.outputTokens.toLocaleString() +
        ' tok' +
        (u.cacheReadInputTokens > 0 ? ' · 캐시읽기 ' + u.cacheReadInputTokens.toLocaleString() + ' tok' : '')
      card.appendChild(meta)

      const byPurpose = document.createElement('div')
      byPurpose.className = 'text-xs text-gray-400 space-y-0.5'
      u.byPurpose.forEach((p) => {
        const line = document.createElement('div')
        line.textContent =
          (PURPOSE_LABELS[p.purpose] || p.purpose) + ' (' + p.model + ') — ' + p.callCount + '회, ' + formatUsd(p.estimatedCostUsd)
        byPurpose.appendChild(line)
      })
      card.appendChild(byPurpose)

      usageListEl.appendChild(card)
    })
  }

  async function loadUsage() {
    const params = new URLSearchParams()
    if (usageFromEl.value) params.set('from', usageFromEl.value)
    if (usageToEl.value) params.set('to', usageToEl.value)
    const query = params.toString() ? '?' + params.toString() : ''
    const { ok, status, data } = await adminApi('/api/admin/claude-usage' + query)
    if (!ok) {
      if (status === 401) {
        setPw(null)
        contentEl.classList.add('hidden')
        loginEl.classList.remove('hidden')
        loginError.textContent = '비밀번호가 올바르지 않아요.'
      }
      return
    }
    renderUsage(data.users || [], data.totalCostUsd || 0)
  }
  document.getElementById('admin-usage-filter').addEventListener('click', loadUsage)

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
    setActiveTab('generations')
  })

  document.getElementById('admin-refresh').addEventListener('click', () => setActiveTab(activeTab))
  document.getElementById('admin-logout').addEventListener('click', () => {
    setPw(null)
    location.reload()
  })

  ;(function init() {
    if (getPw()) {
      loginEl.classList.add('hidden')
      contentEl.classList.remove('hidden')
      setActiveTab('generations')
    }
  })()
})()
