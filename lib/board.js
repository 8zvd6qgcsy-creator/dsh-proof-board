// 审阅台的数据层：扫交付物、存批注、写交接清单。
// 这里刻意不碰 ctx：扫描和批注都是纯文件读写，测试可以直接跑（见 test/board.test.mjs）。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, normalize, relative, resolve, sep, basename, dirname } from 'node:path'

export const dataDir = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'proof-board')
const notesFile = () => join(dataDir(), 'notes.json')
const thumbsDir = () => join(dataDir(), 'thumbs')

// 交付物的种类。顺序就是页面上筛选按钮的顺序。
export const KINDS = ['deck', 'doc', 'sheet', 'image', 'html', 'pdf', 'video']
export const KIND_LABEL = {
  deck: '演示',
  doc: '文档',
  sheet: '表格',
  image: '图片',
  html: '网页',
  pdf: 'PDF',
  video: '视频',
}
const EXT_KIND = {
  '.pptx': 'deck', '.ppt': 'deck', '.odp': 'deck', '.key': 'deck',
  '.docx': 'doc', '.doc': 'doc', '.odt': 'doc', '.md': 'doc', '.txt': 'doc', '.rtf': 'doc',
  '.xlsx': 'sheet', '.xls': 'sheet', '.csv': 'sheet', '.ods': 'sheet',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.svg': 'image', '.avif': 'image',
  '.html': 'html', '.htm': 'html',
  '.pdf': 'pdf',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
}
// 这些扩展名要 officeKit 转成图片才能给缩略图；image 直出、html/pdf 用 iframe。
export const RENDERED = new Set(['deck', 'doc', 'sheet'])
export const OFFICE_EXT = new Set(['.ppt', '.pptx', '.odp', '.doc', '.docx', '.odt', '.xls', '.xlsx', '.ods'])

// 不走进去的目录：依赖、版本库、缓存、本插件自己的临时目录
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.pnpm', '.cache', '.next', '.nuxt', '.venv', 'venv',
  '__pycache__', '.mypy_cache', '.pytest_cache', 'dist', 'build', 'out', 'coverage', '.turbo',
  '.idea', '.vscode', 'site-packages', '.sass-cache',
])
// 会话里临时产物太多时，这些前缀的目录不进墙
const SKIP_PREFIX = ['.dsh-', '.tmp-', 'tmp-', 'temp-', '~$']

export const kindOf = (file) => EXT_KIND[extname(file).toLowerCase()] || null
export const idOf = (rel) => createHash('sha1').update(rel).digest('hex').slice(0, 12)
export const toUrlPath = (rel) => rel.split(sep).join('/')

/** 扫描一个目录，按修改时间倒序返回可摆上台面的交付物。 */
export function scan(root, options = {}) {
  const {
    kinds = null,
    limit = 120,
    maxDepth = 4,
    maxBytes = 80 * 1024 * 1024,
    maxEntries = 24000,
  } = options
  const want = kinds && kinds.length ? new Set(kinds) : null
  const base = resolve(root)
  if (!existsSync(base)) throw new Error(`目录不存在：${base}`)
  if (!statSync(base).isDirectory()) throw new Error(`不是目录：${base}`)

  const items = []
  let seen = 0
  const walk = (dir, depth) => {
    if (depth > maxDepth || seen > maxEntries) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      seen += 1
      if (seen > maxEntries) return
      const name = entry.name
      if (name.startsWith('.')) continue
      if (SKIP_PREFIX.some((p) => name.toLowerCase().startsWith(p))) continue
      const abs = join(dir, name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name.toLowerCase())) continue
        walk(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const kind = kindOf(name)
      if (!kind || (want && !want.has(kind))) continue
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.size > maxBytes) continue
      const rel = toUrlPath(relative(base, abs))
      items.push({
        id: idOf(rel),
        rel,
        name,
        dir: toUrlPath(relative(base, dir)) || '.',
        kind,
        ext: extname(name).toLowerCase(),
        bytes: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
      })
    }
  }
  walk(base, 0)
  items.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0))
  const byKind = items.reduce((acc, item) => ((acc[item.kind] = (acc[item.kind] || 0) + 1), acc), {})
  return { root: base, total: items.length, byKind, items: items.slice(0, Math.max(1, limit)) }
}

/** 单个交付物的元信息：缩略图和详情用，不依赖「台面上前 120 条」那份列表。 */
export function itemOf(root, rel) {
  const base = resolve(root)
  const abs = resolve(base, rel)
  if (!abs.startsWith(base + sep)) throw new Error(`不在工作区里：${rel}`)
  const stat = statSync(abs)
  if (!stat.isFile()) throw new Error(`不是文件：${rel}`)
  const kind = kindOf(abs)
  if (!kind) return null
  return {
    id: idOf(rel),
    rel: toUrlPath(rel),
    name: basename(abs),
    dir: toUrlPath(dirname(rel)) || '.',
    kind,
    ext: extname(abs).toLowerCase(),
    bytes: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
  }
}

// ---------- 批注 ----------

const EMPTY_VERDICT = ''

function readAll() {
  try {
    // 用户可能用记事本改过这份 JSON，Windows 记事本会加 BOM；JSON.parse 不认，先把 BOM 去掉
    const data = JSON.parse(readFileSync(notesFile(), 'utf8').replace(/^\uFEFF/, ''))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

function writeAll(all) {
  mkdirSync(dataDir(), { recursive: true })
  const file = notesFile()
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`)
  renameSync(tmp, file)
}

/** 某个工作区的全部批注：{ [rel]: { verdict, text, updatedAt } } */
export function notesOf(workspacePath) {
  const bucket = readAll()[resolve(workspacePath)]
  return bucket && typeof bucket === 'object' ? bucket : {}
}

/** 写一条批注。verdict 传空串表示撤销批注；text 传 undefined 表示不改文字。 */
export function saveNote(workspacePath, rel, patch = {}) {
  const key = resolve(workspacePath)
  const all = readAll()
  const bucket = { ...(all[key] || {}) }
  const before = bucket[rel] || { verdict: EMPTY_VERDICT, text: '', updatedAt: '' }
  const verdict = patch.verdict === undefined ? before.verdict : String(patch.verdict)
  const text = patch.text === undefined ? before.text : String(patch.text)
  if (!verdict && !text.trim()) {
    delete bucket[rel]
  } else {
    bucket[rel] = { verdict, text, updatedAt: new Date().toISOString() }
  }
  all[key] = bucket
  writeAll(all)
  return bucket[rel] || null
}

/** 清掉一个工作区里已经不存在的文件留下的批注。 */
export function pruneNotes(workspacePath, relSet) {
  const key = resolve(workspacePath)
  const all = readAll()
  const bucket = all[key]
  if (!bucket) return 0
  let removed = 0
  for (const rel of Object.keys(bucket)) {
    if (!relSet.has(rel)) {
      delete bucket[rel]
      removed += 1
    }
  }
  if (removed) writeAll(all)
  return removed
}

// ---------- 交接清单 ----------

const VERDICT_MARK = { ok: '✅ 通过', fix: '🔧 待改', todo: '⬜ 待定', skip: '⏭ 略过' }
export const verdictLabel = (v) => VERDICT_MARK[v] || v || ''

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 生成交接清单的 Markdown。纯函数：给 items（扫描结果）和 notes（批注表），
 * 只列出有批注或 explicitly 选中的项。
 */
export function handoffMarkdown({ title = '审阅清单', items = [], notes = {}, pick = null, now = new Date() } = {}) {
  const chosen = items.filter((item) => (pick ? pick.has(item.rel) : Boolean(notes[item.rel])))
  const open = chosen.filter((item) => ['fix', 'todo'].includes((notes[item.rel] || {}).verdict))
  const ok = chosen.filter((item) => (notes[item.rel] || {}).verdict === 'ok')
  const stamp = now.toISOString().replace('T', ' ').slice(0, 16)
  const lines = [`# ${title}`, '', `- 生成时间：${stamp}`, `- 一共 ${chosen.length} 项（待改 ${open.length}，通过 ${ok.length}）`, '']
  if (!chosen.length) {
    lines.push('（还没有批注。在审阅台上给交付物写批注，或者选中几项再导出。）', '')
    return lines.join('\n')
  }
  const order = { fix: 0, todo: 1, ok: 2, skip: 3 }
  const sorted = [...chosen].sort((a, b) => {
    const va = order[(notes[a.rel] || {}).verdict] ?? 4
    const vb = order[(notes[b.rel] || {}).verdict] ?? 4
    return va - vb || (a.mtime < b.mtime ? 1 : -1)
  })
  for (const item of sorted) {
    const note = notes[item.rel] || {}
    lines.push(`## ${item.name}`)
    lines.push('')
    lines.push(`- 路径：\`${item.rel}\``)
    lines.push(`- 类型：${KIND_LABEL[item.kind] || item.kind} · ${humanSize(item.bytes)}`)
    if (note.verdict) lines.push(`- 结论：${verdictLabel(note.verdict)}`)
    if (note.text) lines.push(`- 批注：${note.text.replace(/\n/g, ' ')}`)
    lines.push('')
  }
  lines.push('---', '', '改完以后重新扫一遍审阅台（proof_board_scan），把每一项的结论更新掉。', '')
  return lines.join('\n')
}

/** 交接清单落到工作区根目录，返回绝对路径。 */
export function writeHandoff(workspacePath, markdown, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)
  const file = join(resolve(workspacePath), `审阅清单-${stamp}.md`)
  writeFileSync(file, markdown)
  return file
}

// ---------- 缩略图缓存 ----------

export function thumbPath(workspacePath, item) {
  const wsHash = createHash('sha1').update(resolve(workspacePath)).digest('hex').slice(0, 8)
  return join(thumbsDir(), `${wsHash}-${item.id}.png`)
}

export function readCachedThumb(workspacePath, item) {
  const png = thumbPath(workspacePath, item)
  const meta = `${png}.json`
  try {
    const info = JSON.parse(readFileSync(meta, 'utf8'))
    // mtime 变了就是新版本，旧图作废
    if (info.mtime !== item.mtime || info.bytes !== item.bytes) return null
    return readFileSync(png)
  } catch {
    return null
  }
}

export function writeCachedThumb(workspacePath, item, png, extra = {}) {
  mkdirSync(thumbsDir(), { recursive: true })
  const file = thumbPath(workspacePath, item)
  writeFileSync(file, png)
  writeFileSync(`${file}.json`, `${JSON.stringify({ mtime: item.mtime, bytes: item.bytes, width: extra.width, height: extra.height }, null, 2)}\n`)
  return file
}

/** 把一次工具调用给的路径（相对或绝对）变回工作区里的相对路径。 */
export function toRel(workspacePath, input) {
  const abs = isAbsolute(input) ? normalize(input) : resolve(workspacePath, input)
  const base = resolve(workspacePath)
  const rel = toUrlPath(relative(base, abs))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`不在工作区里：${input}`)
  return rel
}

export { readAll as _readAll }