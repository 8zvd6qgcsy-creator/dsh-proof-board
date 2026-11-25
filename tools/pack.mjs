// 打包：npm pack 出 dist/dsh-proof-board-<version>.tgz（files 字段决定装包里有什么）
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
mkdirSync(join(root, 'dist'), { recursive: true })

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(npm, ['pack', '--pack-destination', join(root, 'dist')], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.status !== 0) {
  console.error(`npm pack 失败（${result.status ?? result.error}）`)
  process.exit(result.status || 1)
}
console.log(`已打包 ${pkg.name}@${pkg.version} → dist/`)