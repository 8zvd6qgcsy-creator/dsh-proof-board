// 模型能调的三个工具：扫一遍审阅台、给某项写批注、把批注整理成交接清单。
// 和侧栏里的页面读写同一份数据（lib/board.js），所以页面上的批注和工具看到的永远一致。
import { KIND_LABEL, handoffMarkdown, notesOf, saveNote, scan, toRel, writeHandoff } from './board.js'

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const text = (value) => [{ type: 'text', text: value }]

const VERDICTS = ['ok', 'fix', 'todo', 'skip', 'clear']
const VERDICT_MARK = { ok: '✅', fix: '🔧', todo: '⬜', skip: '⏭' }

function check(args, schema) {
  const errs = []
  for (const key of schema.required || []) if (args?.[key] === undefined || args[key] === '') errs.push(`缺少 ${key}`)
  for (const [key, value] of Object.entries(args || {})) {
    const spec = schema.properties[key]
    if (!spec) {
      errs.push(`未知参数 ${key}`)
      continue
    }
    if (spec.type === 'array') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) errs.push(`${key} 应该是字符串数组`)
    } else if (spec.type === 'integer') {
      if (!Number.isInteger(value)) errs.push(`${key} 应该是整数`)
    } else if (typeof value !== 'string') {
      errs.push(`${key} 应该是字符串`)
    } else if (spec.enum && !spec.enum.includes(value)) {
      errs.push(`${key} 只能是 ${spec.enum.join(' / ')}`)
    }
  }
  if (errs.length) throw new Error(errs.join('；'))
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const shortTime = (iso) => new Date(iso).toISOString().slice(0, 10)
const DIR = str('工作区目录的绝对路径。省略时用默认工作区目录；当前会话不在默认目录里时必须传。')

export function createTools(deps) {
  const root = (args) => deps.rootOf(args?.dir)

  const scanTool = {
    name: 'proof_board_scan',
    description:
      '扫一遍审阅台：列出工作区里可以审阅的交付物（演示 / 文档 / 表格 / 图片 / 网页 / PDF），按修改时间倒序，带上已有批注。开工前先扫一遍知道台上有什么；交付后扫一遍确认东西真的在台上。只返回前 limit 项，总数看 total。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dir: DIR,
        kinds: { type: 'array', items: { type: 'string' }, description: '只看这几类：deck / doc / sheet / image / html / pdf。省略是全部。' },
        limit: { type: 'integer', description: '最多返回几项，默认 40，上限 200。' },
        withNotes: { type: 'string', enum: ['all', 'open', 'none'], description: '批注筛选：all 全部（默认）、open 只要待改和待定的、none 不带批注。' },
      },
    },
    timeoutMs: 60_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['root', 'total', 'shown', 'counts', 'items'],
        properties: {
          root: { type: 'string' },
          total: { type: 'integer' },
          shown: { type: 'integer' },
          counts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'count'],
              properties: { kind: { type: 'string' }, count: { type: 'integer' } },
            },
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['rel', 'kind', 'bytes', 'mtime', 'verdict', 'note'],
              properties: {
                rel: { type: 'string' },
                kind: { type: 'string' },
                bytes: { type: 'integer' },
                mtime: { type: 'string' },
                verdict: { type: 'string' },
                note: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const counts = value.counts.map((entry) => `${KIND_LABEL[entry.kind] || entry.kind} ${entry.count}`).join(' / ')
        const lines = [`审阅台 · ${value.root}`, `台上共 ${value.total} 项${counts ? `（${counts}）` : ''}，这次列出 ${value.shown} 项：`]
        for (const item of value.items) {
          const verdict = item.verdict ? `${VERDICT_MARK[item.verdict] || ''} ` : ''
          const note = item.note ? ` —— ${item.note}` : ''
          lines.push(`- ${verdict}\`${item.rel}\`（${KIND_LABEL[item.kind] || item.kind}，${humanSize(item.bytes)}，${shortTime(item.mtime)}）${note}`)
        }
        if (!value.items.length) lines.push('- （没有符合条件的交付物）')
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      check(args, scanTool.parameters)
      const workspace = root(args)
      const limit = Math.min(Math.max(args.limit ?? 40, 1), 200)
      const result = scan(workspace, { kinds: args.kinds, limit: 1000 })
      const notes = notesOf(workspace)
      const filter = args.withNotes || 'all'
      const items = result.items
        .map((item) => {
          const note = notes[item.rel]
          return {
            rel: item.rel,
            kind: item.kind,
            bytes: item.bytes,
            mtime: item.mtime,
            verdict: note?.verdict || '',
            note: note?.text || '',
          }
        })
        .filter((item) =>
          filter === 'open'
            ? ['fix', 'todo'].includes(item.verdict)
            : filter === 'none'
              ? !item.verdict && !item.note
              : true,
        )
      return {
        root: result.root,
        total: result.total,
        shown: Math.min(items.length, limit),
        counts: Object.entries(result.byKind).map(([kind, count]) => ({ kind, count })),
        items: items.slice(0, limit),
      }
    },
  }

  const noteTool = {
    name: 'proof_board_note',
    description:
      '在审阅台上给一个交付物写批注（结论 + 一句话说明），用户打开侧栏「审阅台」就看得到。用户口头给的评审意见、自己复核发现的问题，都记在这里，免得下一轮忘掉。verdict 传 clear 撤销批注。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        dir: DIR,
        path: str('交付物的路径：相对工作区目录，或者绝对路径。'),
        verdict: str('结论：ok 通过、fix 待改、todo 待定、clear 撤销批注。省略则不改结论。', { enum: VERDICTS }),
        text: str('一句说明，写清改哪里、改成什么。省略则不改文字。'),
      },
    },
    timeoutMs: 30_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['rel', 'verdict', 'text', 'saved', 'board'],
        properties: {
          rel: { type: 'string' },
          verdict: { type: 'string' },
          text: { type: 'string' },
          saved: { type: 'boolean' },
          board: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.saved) return text(`已撤销 \`${value.rel}\` 的批注。`)
        const mark = value.verdict ? `${VERDICT_MARK[value.verdict] || ''} ${value.verdict}` : '仅批注'
        return text(`已在审阅台记下 \`${value.rel}\`：${mark}${value.text ? ` —— ${value.text}` : ''}`)
      },
    },
    async execute(args) {
      check(args, noteTool.parameters)
      const workspace = root(args)
      const rel = toRel(workspace, args.path)
      const note = saveNote(workspace, rel, {
        verdict: args.verdict === undefined ? undefined : args.verdict === 'clear' ? '' : args.verdict,
        text: args.text,
      })
      return {
        rel,
        verdict: note?.verdict || '',
        text: note?.text || '',
        saved: Boolean(note),
        board: `${deps.boardUrl()}?ws=${encodeURIComponent(deps.workspaceId(workspace))}&focus=${encodeURIComponent(rel)}`,
      }
    },
  }

  const handoffTool = {
    name: 'proof_board_handoff',
    description:
      '把审阅台上的批注整理成一份 Markdown 交接清单，写进工作区根目录（审阅清单-时间.md），返回绝对路径。用户说「把批注给你」「按批注改」时用：先调用它拿到清单，再读清单里的路径逐项改。不传 paths 时收全部有批注的项。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dir: DIR,
        paths: { type: 'array', items: { type: 'string' }, description: '只收这几项（相对或绝对路径）。省略收全部有批注的项。' },
        title: str('清单标题，默认「审阅清单」。'),
      },
    },
    timeoutMs: 30_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'items', 'open'],
        properties: { path: { type: 'string' }, items: { type: 'integer' }, open: { type: 'integer' } },
      },
      render: (_args, value) =>
        text(`交接清单已写好：${value.path}\n共 ${value.items} 项，其中待改 / 待定 ${value.open} 项。读这个文件，按里面的顺序逐项改。`),
    },
    async execute(args) {
      check(args, handoffTool.parameters)
      const workspace = root(args)
      const result = scan(workspace, { limit: 5000 })
      const notes = notesOf(workspace)
      const pick = args.paths?.length ? new Set(args.paths.map((path) => toRel(workspace, path))) : null
      const markdown = handoffMarkdown({ title: args.title || '审阅清单', items: result.items, notes, pick })
      const file = writeHandoff(workspace, markdown)
      const chosen = result.items.filter((item) => (pick ? pick.has(item.rel) : Boolean(notes[item.rel])))
      return {
        path: file,
        items: chosen.length,
        open: chosen.filter((item) => ['fix', 'todo'].includes((notes[item.rel] || {}).verdict)).length,
      }
    },
  }

  return [scanTool, noteTool, handoffTool]
}