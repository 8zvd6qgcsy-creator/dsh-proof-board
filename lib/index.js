// 审阅台 · Host 半边
//   1. /proof-board/            台面页面（web/，卡片墙 + 批注）
//   2. /proof-board/api/board   工作区列表、交付物、批注，一次取齐
//   3. /proof-board/raw         工作区里的原文件（只放行审阅台认识的交付物类型）
//   4. /proof-board/thumb       Office 交付物的第一页缩略图（officeKit 渲染，按 mtime 缓存）
//   5. 三个工具：proof_board_scan / proof_board_note / proof_board_handoff
//   6. 两个 skill：proof-board（怎么用台面）、deliverable-review（怎么审交付物）
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handoffMarkdown, itemOf, notesOf, saveNote, scan, toRel, writeHandoff } from './board.js'
import { createSkillProvider } from './skills.js'
import { canRender, getLastError, thumbFor } from './thumbs.js'
import { createTools } from './tools.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = '/proof-board'
const SKILL_DIR = join(ROOT, 'skills')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
}
const TEXTUAL = new Set(['.md', '.txt', '.csv'])
const PREVIEW = { image: 'image', html: 'html', pdf: 'pdf', video: 'video', deck: 'render', doc: 'render', sheet: 'render' }
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' }

const previewOf = (item) => (TEXTUAL.has(item.ext) ? 'text' : PREVIEW[item.kind] || 'none')

export const name = 'proof-board'
export const inject = ['webServer', 'skills', 'tools']

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}
function fail(res, status, message) {
  sendJson(res, status, { ok: false, error: message })
}
function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

function serveFile(req, res, file, cache = 'no-cache') {
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  const stat = statSync(file)
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

// 只接受同源页面发来的 JSON（和 DSH 其它插件一致）
function readJson(req, max = 256 * 1024) {
  return new Promise((resolve_, reject) => {
    const origin = req.headers.origin
    if (req.method !== 'POST') return reject(Object.assign(new Error('method'), { status: 405 }))
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('type'), { status: 415 }))
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) return reject(Object.assign(new Error('origin'), { status: 403 }))
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > max) req.destroy()
      else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve_(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(Object.assign(error, { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

// 工作区里的文件只在这个根里面找：挡住 ..、隐藏文件和逃出去的符号链接
function safeFile(root, relPath) {
  if (!root || !relPath) return null
  if (relPath.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return null
  let base
  try {
    base = realpathSync(root)
  } catch {
    return null
  }
  const file = normalize(join(base, relPath))
  if (!file.startsWith(base + sep) || !existsSync(file)) return null
  let real
  try {
    real = realpathSync(file)
  } catch {
    return null
  }
  if (!real.startsWith(base + sep) || !statSync(real).isFile()) return null
  return real
}

function workspaceList(ctx, settings) {
  const list = []
  const seen = new Set()
  const registry = ctx.get('workspaceRegistry')
  if (registry && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list()) {
        if (!workspace?.path) continue
        const key = resolve(workspace.path)
        if (seen.has(key)) continue
        seen.add(key)
        list.push({ id: String(workspace.id), title: workspace.title || basename(key), path: key })
      }
    } catch {
      /* 注册表未就绪时退回默认目录 */
    }
  }
  const extra = settings.directory
  if (extra && !seen.has(extra)) {
    list.push({ id: 'config', title: basename(extra), path: extra })
  }
  return list
}

function defaultRoot(ctx, settings) {
  if (settings.directory) return settings.directory
  const workdir = ctx.get('workingDirectory')
  const dir = workdir?.defaultDirectory
  if (dir) return resolve(dir)
  const first = workspaceList(ctx, settings)[0]
  if (first) return first.path
  throw new Error('没有可用的工作区目录：请在插件配置里填 directory')
}

export function apply(ctx, config = {}) {
  const settings = {
    directory: config.directory ? resolve(String(config.directory)) : null,
    limit: Math.min(Math.max(Number(config.limit) || 200, 12), 600),
  }

  const roots = () => workspaceList(ctx, settings)
  const pick = (id) => {
    const list = roots()
    if (id) {
      const hit = list.find((workspace) => workspace.id === id)
      if (hit) return hit
      const byPath = list.find((workspace) => workspace.path === resolve(id))
      if (byPath) return byPath
    }
    return list[0] || null
  }

  // 扫描结果按 2 秒记忆：页面切筛选、连点批注时不用反复走目录树
  const memo = new Map()
  const scanCached = (root, kinds, limit = settings.limit) => {
    const key = `${root}|${(kinds || []).join(',')}|${limit}`
    const hit = memo.get(key)
    if (hit && Date.now() - hit.at < 2000) return hit.value
    const value = scan(root, { kinds, limit })
    memo.set(key, { at: Date.now(), value })
    return value
  }

  const deps = {
    rootOf: (dir) => (dir ? resolve(String(dir)) : defaultRoot(ctx, settings)),
    boardUrl: () => `${ctx.webServer.getOrigin()}${BASE}/`,
    workspaceId: (path) => roots().find((workspace) => workspace.path === resolve(path))?.id ?? 'default',
  }

  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(SKILL_DIR, ROOT)))
  for (const tool of createTools(deps)) ctx.effect(() => ctx.tools.register(tool))

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      async handler(req, res) {
        let url
        let rest
        try {
          url = new URL(req.url || '/', 'http://local')
          rest = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'
        } catch {
          return notFound(res)
        }
        try {
          // ---- 写操作 ----
          if (req.method === 'POST') {
            const body = await readJson(req)
            const workspace = pick(typeof body.ws === 'string' ? body.ws : null)
            if (!workspace) return fail(res, 400, '没有可用的工作区')
            if (rest === '/api/note') {
              const rel = toRel(workspace.path, String(body.rel || ''))
              const note = saveNote(workspace.path, rel, {
                verdict: body.verdict === undefined ? undefined : body.verdict === 'clear' ? '' : String(body.verdict),
                text: body.text === undefined ? undefined : String(body.text).slice(0, 4000),
              })
              return sendJson(res, 200, { ok: true, rel, note })
            }
            if (rest === '/api/handoff') {
              const result = scan(workspace.path, { limit: 5000 })
              const notes = notesOf(workspace.path)
              const pickSet = Array.isArray(body.rels) && body.rels.length ? new Set(body.rels.map((rel) => toRel(workspace.path, String(rel)))) : null
              const markdown = handoffMarkdown({ title: String(body.title || '审阅清单'), items: result.items, notes, pick: pickSet })
              const file = writeHandoff(workspace.path, markdown)
              return sendJson(res, 200, { ok: true, path: file, name: basename(file) })
            }
            return notFound(res)
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res)

          // ---- 页面和静态资源 ----
          if (rest === '/icon.svg') {
            const icon = join(ROOT, 'icon.svg')
            return existsSync(icon) ? serveFile(req, res, icon) : notFound(res)
          }
          if (STATIC[rest]) {
            const file = join(ROOT, 'web', STATIC[rest])
            return existsSync(file) ? serveFile(req, res, file) : notFound(res)
          }

          // ---- 接口 ----
          if (rest === '/api/board') {
            const workspace = pick(url.searchParams.get('ws'))
            if (!workspace) return fail(res, 400, '没有可用的工作区')
            const kinds = (url.searchParams.get('kinds') || '').split(',').map((k) => k.trim()).filter(Boolean)
            const notedOnly = url.searchParams.get('noted') === '1'
            const depth = notedOnly ? 5000 : settings.limit
            // 类型筛选走服务端：客户端那 120 条只是窗口，不能让筛选只作用在窗口里
            const full = scanCached(workspace.path, null, depth)
            const result = kinds.length ? scanCached(workspace.path, kinds, depth) : full
            const notes = notesOf(workspace.path)
            const listed = (notedOnly ? result.items.filter((item) => notes[item.rel]) : result.items).slice(0, settings.limit)
            return sendJson(res, 200, {
              ok: true,
              workspaces: roots().map(({ id, title, path }) => ({ id, title, path })),
              ws: workspace.id,
              root: workspace.path,
              total: result.total,
              boardTotal: full.total,
              notedCount: Object.keys(notes).length,
              byKind: full.byKind,
              items: listed.map((item) => ({ ...item, preview: previewOf(item), note: notes[item.rel] || null })),
            })
          }
          if (rest === '/api/render-status') {
            const workspace = pick(url.searchParams.get('ws'))
            const rel = url.searchParams.get('rel') || ''
            const item = workspace && safeFile(workspace.path, rel) ? itemOf(workspace.path, rel) : null
            if (!item) return fail(res, 404, '台上没有这一项')
            const started = Date.now()
            const png = await thumbFor(ctx, workspace.path, item)
            return sendJson(res, 200, {
              ok: true,
              rel,
              renderable: canRender(item),
              bytes: png ? png.length : 0,
              ms: Date.now() - started,
              error: png ? null : getLastError(),
            })
          }
          if (rest === '/api/text') {
            const workspace = pick(url.searchParams.get('ws'))
            const file = workspace && safeFile(workspace.path, url.searchParams.get('rel') || '')
            if (!file || !TEXTUAL.has(extname(file).toLowerCase())) return fail(res, 404, '不是可读的文本交付物')
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 1200, 200), 8000)
            return sendJson(res, 200, { ok: true, text: readFileSync(file, 'utf8').slice(0, limit) })
          }
          // 工作区文件：路径式路由，HTML 里的相对路径（css/js/图）才能照常解析
          if (rest.startsWith('/ws/')) {
            const trimmed = rest.slice(4)
            const slash = trimmed.indexOf('/')
            if (slash < 1) return notFound(res)
            const workspace = pick(trimmed.slice(0, slash))
            const file = workspace && safeFile(workspace.path, trimmed.slice(slash + 1))
            if (!file) return notFound(res)
            return serveFile(req, res, file)
          }
          if (rest === '/thumb') {
            const workspace = pick(url.searchParams.get('ws'))
            const rel = url.searchParams.get('rel') || ''
            const file = workspace && safeFile(workspace.path, rel)
            if (!workspace || !file) return notFound(res)
            const item = workspace && safeFile(workspace.path, rel) ? itemOf(workspace.path, rel) : null
            if (!item || !canRender(item)) return notFound(res)
            const png = await thumbFor(ctx, workspace.path, item)
            if (!png) return fail(res, 502, getLastError()?.message || '这张缩略图暂时渲染不出来')
            res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'max-age=60' })
            return res.end(req.method === 'HEAD' ? undefined : png)
          }
          return notFound(res)
        } catch (error) {
          const status = error?.status || 500
          if (status >= 500) console.error('[proof-board] 请求失败', error)
          return fail(res, status, String(error?.message || error))
        }
      },
    }),
  )
}