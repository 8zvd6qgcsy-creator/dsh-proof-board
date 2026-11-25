// skill 提供方：把插件自带的 skills/<name>/SKILL.md 注册进 DSH 的 skill 目录。
// 用户自己在 ~/.dsh/skills 或项目里装了同名 skill 时，那一份优先（本提供方 rank 600 排在最后）。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RANK = 600
const INVOCATION = { modelInvocable: true, userInvocable: true }

function parse(file) {
  // 有人用 Windows 记事本存过 SKILL.md 的话会带 BOM，frontmatter 就会解析失败
  const body = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const m = body.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return null
  const field = (k) => (m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
  const name = field('name')
  const description = field('description')
  return name && description ? { name, description, body: body.slice(m[0].length) } : null
}

export function readSkills(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md')))
    .map((entry) => ({ dir: join(dir, entry.name), file: join(dir, entry.name, 'SKILL.md'), ...parse(join(dir, entry.name, 'SKILL.md')) }))
    .filter((skill) => skill.name)
}

// 装进插件以后要多说一句的话：工具叫什么、台面在哪、别去跑 git。
function addendum(skill, pluginRoot) {
  return [
    '',
    '---',
    '',
    '## 在审阅台插件（DSH）里使用',
    '',
    `- 本 skill 的目录是 \`${skill.dir}\`，插件根目录是 \`${pluginRoot}\`。`,
    '- 审阅台的数据和页面形状由插件提供：`proof_board_scan`（扫描）、`proof_board_note`（批注）、`proof_board_handoff`（交接清单）三个工具可用；侧栏「审阅台」是同一份数据的页面。',
    '- 不要自己实现扫描或批注的脚本：工具在 Host 进程里跑，能读写 App 数据目录，模型的 shell 沙箱写不进去。',
    '',
  ].join('\n')
}

export function createSkillProvider(dir, pluginRoot) {
  const candidate = (skill) => ({
    name: skill.name,
    description: skill.description,
    path: skill.file,
    invocation: INVOCATION,
    source: 'bundled',
    provider: 'proof-board',
    rank: RANK,
    locator: skill.dir,
    resourceBase: { kind: 'directory', path: skill.dir },
  })
  return {
    name: 'proof-board',
    async list() {
      return readSkills(dir).map(candidate)
    },
    async get(c) {
      const skill = readSkills(dir).find((item) => item.dir === c.locator && item.name === c.name)
      if (!skill) return undefined
      const { rank, locator, ...summary } = candidate(skill)
      return {
        ...summary,
        content: skill.body.replaceAll('<SKILL_ROOT>', skill.dir).replaceAll('<PLUGIN_ROOT>', pluginRoot) + addendum(skill, pluginRoot),
      }
    },
  }
}