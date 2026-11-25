// 审阅台 · 台面脚本（无构建，原生 DOM）
// 数据只来自 /proof-board/api/board；批注写回 /proof-board/api/note。
// 和 DSH 的联动：iframe 里收到主题/语言变化就跟着切；「把批注交给 agent」通过 postMessage 交回宿主，
// 由 client.js 开一个新对话把草稿填进输入框（不直接发送）。

const BASE = '/proof-board'
const KINDS = ['deck', 'doc', 'sheet', 'image', 'html', 'pdf', 'video']

const I18N = {
  zh: {
    title: '审阅台',
    subtitle: 'Proof Board',
    search: '搜文件名…',
    all: '全部',
    noted: '有批注',
    kinds: { deck: '演示', doc: '文档', sheet: '表格', image: '图片', html: '网页', pdf: 'PDF', video: '视频' },
    ok: '通过',
    fix: '待改',
    todo: '待定',
    notePlaceholder: '写一句批注：改哪里、改成什么…',
    refresh: '刷新',
    handoff: '生成交接清单',
    revise: '把批注交给 agent',
    emptyTitle: '台面上还没有交付物',
    emptyBody: '在工作区里做出演示、文档、表格、图片或网页，它们会自动出现在这里。也可以让 agent 先跑一遍 proof_board_scan。',
    statsTotal: (n) => `台上 ${n} 项`,
    statsListing: (n) => `列出 ${n} 项`,
    fixWord: '待改',
    okWord: '通过',
    saved: '批注已保存',
    handoffDone: (p) => `交接清单已写进 ${p}`,
    reviseEmpty: '还没有批注。先给几项下结论，或者写一句话。',
    reviseSent: '批注已交给 agent，去对话里接着改',
    reviseCopied: '批注已复制，粘到输入框发给 agent',
    openHint: '在新标签打开',
    error: (m) => `出错了：${m}`,
    noWorkspace: '没有可用的工作区',
  },
  en: {
    title: 'Proof Board',
    subtitle: '审阅台',
    search: 'Search files…',
    all: 'All',
    noted: 'With notes',
    kinds: { deck: 'Deck', doc: 'Doc', sheet: 'Sheet', image: 'Image', html: 'Page', pdf: 'PDF', video: 'Video' },
    ok: 'Good',
    fix: 'Fix',
    todo: 'TBD',
    notePlaceholder: 'One line: what to change…',
    refresh: 'Refresh',
    handoff: 'Write checkout list',
    revise: 'Send notes to agent',
    emptyTitle: 'Nothing on the board yet',
    emptyBody: 'Make a deck, document, sheet, image, or page in this workspace and it shows up here. The agent can also run proof_board_scan first.',
    statsTotal: (n) => `${n} on the board`,
    statsListing: (n) => `showing ${n}`,
    fixWord: 'to fix',
    okWord: 'approved',
    saved: 'Note saved',
    handoffDone: (p) => `Checkout list written to ${p}`,
    reviseEmpty: 'No notes yet. Mark a few items or write a line first.',
    reviseSent: 'Notes handed to the agent',
    reviseCopied: 'Notes copied — paste them into the composer',
    openHint: 'Open in a new tab',
    error: (m) => `Something went wrong: ${m}`,
    noWorkspace: 'No workspace available',
  },
}

const state = { lang: 'zh', ws: '', kinds: [], noted: false, q: '', data: null, saving: new Map(), focus: null }
const cards = new Map()
let toastTimer = 0

const t = (key, ...args) => {
  const value = I18N[state.lang][key] ?? I18N.zh[key]
  return typeof value === 'function' ? value(...args) : value
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'html') node.innerHTML = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'style') Object.assign(node.style, value)
    else if (typeof value === 'boolean') node.toggleAttribute(key, value)
    else node.setAttribute(key, value)
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child)
  return node
}

const fileUrl = (item) => `${BASE}/ws/${encodeURIComponent(state.ws)}/${item.rel.split('/').map(encodeURIComponent).join('/')}`
const thumbUrl = (item) => `${BASE}/thumb?ws=${encodeURIComponent(state.ws)}&rel=${encodeURIComponent(item.rel)}`

function toast(message, bad = false) {
  const node = document.getElementById('toast')
  node.textContent = message
  node.classList.toggle('bad', bad)
  node.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.remove('show'), bad ? 5200 : 2600)
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function shortTime(iso) {
  const date = new Date(iso)
  const diff = Date.now() - date.getTime()
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))} 分钟前`
  if (diff < day) return `${Math.round(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.round(diff / day)} 天前`
  return `${date.getMonth() + 1}/${date.getDate()}`
}

// ---------- 取数 ----------

async function load(options = {}) {
  const grid = document.getElementById('grid')
  // 已经有内容时静默刷新：不把台面闪回骨架屏
  if (!state.data || !options.silent) {
    grid.replaceChildren(...Array.from({ length: 8 }, () => el('div', { class: 'skel' })))
  }
  try {
    const params = new URLSearchParams()
    if (state.ws) params.set('ws', state.ws)
    if (state.kinds.length) params.set('kinds', state.kinds.join(','))
    if (state.noted) params.set('noted', '1')
    const response = await fetch(`${BASE}/api/board?${params}`)
    const data = await response.json()
    if (!data.ok) throw new Error(data.error || 'load failed')
    state.data = data
    state.ws = data.ws
    renderShell()
    renderGrid()
  } catch (error) {
    grid.replaceChildren(el('div', { class: 'empty' }, el('h2', { text: t('error', String(error.message || error)) })))
  }
}

// ---------- 顶栏 ----------

function renderShell() {
  const { workspaces, byKind } = state.data
  const select = document.getElementById('ws')
  select.replaceChildren(
    ...workspaces.map((workspace) =>
      el('option', { value: workspace.id, selected: workspace.id === state.ws, text: workspace.title }),
    ),
  )
  select.hidden = workspaces.length < 2
  select.title = workspaces.find((workspace) => workspace.id === state.ws)?.path || ''

  // 计数用整台（未筛选）的统计，筛选按钮才说真话
  const chips = KINDS.filter((kind) => byKind[kind] || state.kinds.includes(kind))
  const boardTotal = state.data.boardTotal ?? state.data.items.length
  const buttons = [
    el('button', {
      class: 'chip',
      'aria-pressed': String(state.kinds.length === 0 && !state.noted),
      onclick: () => setView({ kinds: [], noted: false }),
    }, t('all'), el('span', { class: 'count', text: String(boardTotal) })),
  ]
  // 批注可能落在窗口外（台面只列最新一批），单给一个只看批注的入口
  const notedCount = state.data.notedCount || 0
  if (notedCount > 0 || state.noted) {
    buttons.push(
      el('button', {
        class: 'chip',
        'aria-pressed': String(state.noted),
        onclick: () => setView({ noted: !state.noted }),
      }, t('noted'), el('span', { class: 'count', text: String(notedCount) })),
    )
  }
  for (const kind of chips) {
    buttons.push(
      el('button', {
        class: 'chip',
        'aria-pressed': String(state.kinds.includes(kind)),
        onclick: () => setView({ kinds: state.kinds.includes(kind) ? state.kinds.filter((k) => k !== kind) : [...state.kinds, kind] }),
      }, t('kinds')[kind] || kind, el('span', { class: 'count', text: String(byKind[kind] || 0) })),
    )
  }
  document.getElementById('kinds').replaceChildren(...buttons)
}

// 类型筛选交给服务端：否则「演示」只会在当前这批里找，永远显示 0
function setView(next) {
  if (next.kinds !== undefined) state.kinds = next.kinds
  if (next.noted !== undefined) state.noted = next.noted
  renderShell()
  load({ silent: true })
}

// ---------- 卡片 ----------

function notesOf() {
  return state.data?.items.filter((item) => item.note) || []
}

function renderStats() {
  const items = state.data?.items || []
  const boardTotal = state.data?.boardTotal ?? items.length
  const noted = items.filter((item) => item.note)
  const fix = noted.filter((item) => ['fix', 'todo'].includes(item.note.verdict)).length
  const ok = noted.filter((item) => item.note.verdict === 'ok').length
  const parts = [el('span', { text: t('statsTotal', boardTotal) })]
  if (items.length !== boardTotal) parts.push(el('span', { text: t('statsListing', items.length) }))
  parts.push(el('span', { class: 'fix' }, el('b', { text: String(fix) }), ` ${t('fixWord')}`))
  parts.push(el('span', { class: 'ok' }, el('b', { text: String(ok) }), ` ${t('okWord')}`))
  document.getElementById('stats').replaceChildren(...parts)
  document.getElementById('revise').disabled = noted.length === 0
  document.getElementById('handoff').disabled = noted.length === 0
}

function renderGrid() {
  const grid = document.getElementById('grid')
  cards.clear()
  if (!state.data) return
  const query = state.q.trim().toLowerCase()
  const items = state.data.items.filter((item) => {
    if (!query) return true
    return item.rel.toLowerCase().includes(query)
  })
  if (!items.length) {
    grid.replaceChildren(
      el('div', { class: 'empty' },
        el('h2', { text: state.q ? '没有匹配的文件' : t('emptyTitle') }),
        el('p', { text: t('emptyBody') }),
      ),
    )
    renderStats()
    return
  }
  grid.replaceChildren(...items.map(card))
  renderStats()
  if (state.focus && cards.has(state.focus)) {
    const node = cards.get(state.focus)
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    node.classList.add('focus')
    setTimeout(() => node.classList.remove('focus'), 1800)
    state.focus = null
  }
}

function placeholder(item) {
  return el('div', { class: 'ph' },
    el('div', { class: 'ext', text: item.ext.replace('.', '') }),
    el('div', { class: 'hint', text: t('kinds')[item.kind] || item.kind }),
  )
}

function shot(item) {
  const box = el('div', { class: 'shot', title: t('openHint'), onclick: () => window.open(fileUrl(item), '_blank', 'noopener') })
  if (item.preview === 'image') {
    const img = el('img', { src: fileUrl(item), alt: item.name, loading: 'lazy' })
    img.addEventListener('error', () => { img.remove(); box.append(placeholder(item)) })
    box.append(img)
  } else if (item.preview === 'html' || item.preview === 'pdf') {
    const frame = el('iframe', {
      src: item.preview === 'pdf' ? `${fileUrl(item)}#view=FitH` : fileUrl(item),
      loading: 'lazy',
      scrolling: 'no',
      tabindex: '-1',
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals',
    })
    box.append(frame)
  } else if (item.preview === 'render') {
    const img = el('img', { src: thumbUrl(item), alt: item.name, loading: 'lazy' })
    img.addEventListener('error', () => { img.remove(); box.append(placeholder(item)) })
    box.append(img)
  } else if (item.preview === 'video') {
    box.append(el('video', { src: fileUrl(item), muted: true, preload: 'metadata' }))
  } else if (item.preview === 'text') {
    const pre = el('pre', { class: 'snippet', text: '…' })
    box.append(pre)
    fetch(`${BASE}/api/text?ws=${encodeURIComponent(state.ws)}&rel=${encodeURIComponent(item.rel)}&limit=600`)
      .then((response) => response.json())
      .then((data) => { if (data.ok) pre.textContent = data.text })
      .catch(() => {})
  } else {
    box.append(placeholder(item))
  }
  box.append(el('div', { class: 'veil' }), el('span', { class: 'tag', text: t('kinds')[item.kind] || item.kind }))
  return box
}

function card(item) {
  const note = item.note || { verdict: '', text: '' }
  const node = el('article', { class: 'card', 'data-rel': item.rel, 'data-verdict': note.verdict || 'none' })
  const textarea = el('textarea', {
    class: `note${note.text ? ' filled' : ''}`,
    rows: 1,
    placeholder: t('notePlaceholder'),
    spellcheck: 'false',
  })
  textarea.value = note.text || ''
  textarea.addEventListener('input', () => {
    item.note = { ...(item.note || { verdict: '' }), text: textarea.value }
    textarea.classList.toggle('filled', Boolean(textarea.value))
    autosize(textarea)
    schedule(item, { text: textarea.value })
  })
  textarea.addEventListener('focus', () => autosize(textarea))
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      flush(item)
      textarea.blur()
    }
  })

  const verdicts = ['ok', 'fix', 'todo'].map((verdict) =>
    el('button', {
      class: 'v',
      'data-v': verdict,
      'aria-pressed': String(note.verdict === verdict),
      text: t(verdict),
      onclick: () => {
        const next = (item.note?.verdict || '') === verdict ? '' : verdict
        item.note = { ...(item.note || { text: '' }), verdict: next }
        node.dataset.verdict = next || 'none'
        for (const button of node.querySelectorAll('.v')) {
          button.setAttribute('aria-pressed', String(button.dataset.v === next))
        }
        renderStats()
        save(item, { verdict: next === '' ? 'clear' : next })
      },
    }),
  )

  node.append(
    shot(item),
    el('div', { class: 'meta' },
      el('span', { class: 'name', text: item.name, title: item.rel }),
      el('span', { class: 'size', text: `${humanSize(item.bytes)} · ${shortTime(item.mtime)}` }),
    ),
    // 工作区根目录的文件，文件名就是路径，再显示一行等于把名字写了两遍
    ...(item.dir && item.dir !== '.'
      ? [el('div', { class: 'path', text: item.dir, title: item.rel })]
      : []),
    el('div', { class: 'verdicts' }, ...verdicts),
    textarea,
  )
  cards.set(item.rel, node)
  return node
}

function autosize(textarea) {
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`
}

// ---------- 写批注 ----------

function schedule(item, patch) {
  const previous = state.saving.get(item.rel)
  if (previous) clearTimeout(previous.timer)
  const timer = setTimeout(() => {
    state.saving.delete(item.rel)
    save(item, patch)
  }, 700)
  state.saving.set(item.rel, { timer, patch })
}

function flush(item) {
  const pending = state.saving.get(item.rel)
  if (!pending) return
  clearTimeout(pending.timer)
  state.saving.delete(item.rel)
  save(item, pending.patch)
}

async function save(item, patch) {
  try {
    const response = await fetch(`${BASE}/api/note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ws: state.ws, rel: item.rel, ...patch }),
    })
    const data = await response.json()
    if (!data.ok) throw new Error(data.error || 'save failed')
    item.note = data.note
    renderStats()
  } catch (error) {
    toast(t('error', String(error.message || error)), true)
  }
}

// ---------- 交接 ----------

async function handoff() {
  const noted = notesOf()
  if (!noted.length) return toast(t('reviseEmpty'), true)
  try {
    const response = await fetch(`${BASE}/api/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ws: state.ws }),
    })
    const data = await response.json()
    if (!data.ok) throw new Error(data.error || 'handoff failed')
    toast(t('handoffDone', data.path))
    copy(data.path)
  } catch (error) {
    toast(t('error', String(error.message || error)), true)
  }
}

function composePrompt() {
  const noted = notesOf()
  const open = noted.filter((item) => ['fix', 'todo'].includes(item.note.verdict))
  const marks = { ok: '✅ 通过', fix: '🔧 待改', todo: '⬜ 待定', skip: '⏭ 略过' }
  const lines = [
    `审阅台上的批注（${noted.length} 项，其中待改 / 待定 ${open.length} 项），按下面的结论逐项处理：`,
    '',
  ]
  const order = { fix: 0, todo: 1, ok: 2, skip: 3 }
  const sorted = [...noted].sort((a, b) => (order[a.note.verdict] ?? 4) - (order[b.note.verdict] ?? 4))
  sorted.forEach((item, index) => {
    lines.push(`${index + 1}. \`${item.rel}\` —— ${marks[item.note.verdict] || '未定'}${item.note.text ? `：${item.note.text}` : ''}`)
  })
  lines.push('', '改完以后跑一次 proof_board_scan 复核，并把每一项的结论更新掉（改好的标记 ok，还要改的留在 fix）。')
  return lines.join('\n')
}

function revise() {
  const noted = notesOf()
  if (!noted.length) return toast(t('reviseEmpty'), true)
  const prompt = composePrompt()
  const parent = window.parent
  if (parent && parent !== window) {
    parent.postMessage({ type: 'proof-board:revise', prompt }, location.origin)
    toast(t('reviseSent'))
    return
  }
  copy(prompt)
  toast(t('reviseCopied'))
}

function copy(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {})
    return
  }
  const area = el('textarea', { style: { position: 'fixed', opacity: '0' } })
  area.value = text
  document.body.append(area)
  area.select()
  try {
    document.execCommand('copy')
  } catch {
    /* 复制失败不影响主流程 */
  }
  area.remove()
}

// ---------- 主题 / 语言 ----------

function applyScheme(scheme) {
  document.documentElement.dataset.theme = scheme === 'light' ? 'light' : 'dark'
}

function applyLang(lang) {
  if (!I18N[lang] || lang === state.lang) return
  state.lang = lang
  document.documentElement.lang = lang
  document.documentElement.dataset.lang = lang
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const key = node.dataset.i18n
    if (I18N[lang][key]) node.textContent = I18N[lang][key]
  }
  for (const node of document.querySelectorAll('[data-i18n-ph]')) {
    const key = node.dataset.i18nPh
    if (I18N[lang][key]) node.placeholder = I18N[lang][key]
  }
  if (state.data) {
    renderShell()
    renderGrid()
  }
}

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.type === 'proof-board:scheme') applyScheme(message.scheme)
  if (message.type === 'proof-board:locale') applyLang(message.lang === 'en' ? 'en' : 'zh')
})

// ---------- 启动 ----------

function boot() {
  const params = new URLSearchParams(location.search)
  state.lang = params.get('lang') === 'en' ? 'en' : 'zh'
  state.focus = params.get('focus')
  state.ws = params.get('ws') || ''
  // 深链：/proof-board/?kinds=deck&noted=1 直接进筛选后的台面
  state.kinds = (params.get('kinds') || '').split(',').map((k) => k.trim()).filter((k) => KINDS.includes(k))
  state.noted = params.get('noted') === '1'
  applyScheme(window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  applyLang(state.lang)

  document.getElementById('ws').addEventListener('change', (event) => {
    state.ws = event.target.value
    load()
  })
  const search = document.getElementById('q')
  search.addEventListener('input', () => {
    state.q = search.value
    renderGrid()
  })
  document.getElementById('refresh').addEventListener('click', () => load({ silent: true }))
  document.getElementById('handoff').addEventListener('click', handoff)
  document.getElementById('revise').addEventListener('click', revise)

  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== search) {
      event.preventDefault()
      search.focus()
    } else if (event.key === 'Escape' && document.activeElement === search) {
      search.value = ''
      state.q = ''
      renderGrid()
      search.blur()
    }
  })

  // agent 在右边改批注时，用户切回来能看到新的
  let lastRefresh = Date.now()
  window.addEventListener('focus', () => {
    if (Date.now() - lastRefresh > 4000) {
      lastRefresh = Date.now()
      load({ silent: true })
    }
  })

  load()
}

boot()