// lib/board.js 的单元测试：扫描、批注、交接清单。
// 不需要装依赖：node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'proof-board-home-'))
process.env.DSH_HOME = home

const { handoffMarkdown, idOf, kindOf, notesOf, pruneNotes, saveNote, scan, toRel, writeHandoff } = await import('../lib/board.js')

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'proof-board-ws-'))
  const base = Date.now() / 1000 - 60 * 60
  files.forEach(([rel, content = 'x'], index) => {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
    utimesSync(abs, base + index * 60, base + index * 60)
  })
  return root
}

test('kindOf 认得常见的交付物扩展名，别的一律 null', () => {
  assert.equal(kindOf('a.pptx'), 'deck')
  assert.equal(kindOf('a.PPT'), 'deck')
  assert.equal(kindOf('a.docx'), 'doc')
  assert.equal(kindOf('a.md'), 'doc')
  assert.equal(kindOf('a.xlsx'), 'sheet')
  assert.equal(kindOf('a.csv'), 'sheet')
  assert.equal(kindOf('a.png'), 'image')
  assert.equal(kindOf('a.html'), 'html')
  assert.equal(kindOf('a.pdf'), 'pdf')
  assert.equal(kindOf('a.zip'), null)
  assert.equal(kindOf('Makefile'), null)
})

test('scan 按修改时间倒序，跳过依赖目录和隐藏文件', () => {
  const root = workspace([
    ['old.pptx', 'a'],
    ['docs/brief.md', 'b'],
    ['node_modules/pkg/index.html', 'c'],
    ['.hidden/secret.png', 'd'],
    ['shots/cover.png', 'e'],
  ])
  const result = scan(root, { limit: 10 })
  assert.equal(result.root, root)
  assert.deepEqual(result.items.map((item) => item.rel), ['shots/cover.png', 'docs/brief.md', 'old.pptx'])
  assert.equal(result.byKind.deck, 1)
  assert.equal(result.byKind.image, 1)
  rmSync(root, { recursive: true, force: true })
})

test('scan 按 kinds 过滤，limit 生效但 total 仍是全部数量', () => {
  const root = workspace([
    ['a.pptx', 'a'],
    ['b.pptx', 'b'],
    ['c.md', 'c'],
  ])
  const decks = scan(root, { kinds: ['deck'] })
  assert.deepEqual(decks.items.map((item) => item.rel), ['b.pptx', 'a.pptx'])
  assert.equal(decks.total, 2)
  const limited = scan(root, { limit: 1 })
  assert.equal(limited.items.length, 1)
  assert.equal(limited.total, 3)
  rmSync(root, { recursive: true, force: true })
})

test('scan 跳过超过 maxBytes 的文件', () => {
  const root = workspace([['big.png', 'x'.repeat(64)]])
  assert.equal(scan(root, { maxBytes: 8 }).items.length, 0)
  assert.equal(scan(root, { maxBytes: 1024 }).items.length, 1)
  rmSync(root, { recursive: true, force: true })
})

test('scan 对不存在的目录报错', () => {
  assert.throws(() => scan(join(home, 'no-such-dir')), /目录不存在/)
})

test('idOf 对同一个相对路径稳定，不同路径不撞', () => {
  assert.equal(idOf('docs/a.md'), idOf('docs/a.md'))
  assert.notEqual(idOf('docs/a.md'), idOf('docs/b.md'))
  assert.equal(idOf('docs/a.md').length, 12)
})

test('toRel 接受相对和绝对路径，越界就报错', () => {
  const root = workspace([['a/b.pptx', 'x']])
  assert.equal(toRel(root, 'a/b.pptx'), 'a/b.pptx')
  assert.equal(toRel(root, join(root, 'a/b.pptx')), 'a/b.pptx')
  assert.throws(() => toRel(root, '../outside.pptx'), /不在工作区/)
  rmSync(root, { recursive: true, force: true })
})

test('批注能写、能读、能撤销，按工作区分组', () => {
  const one = workspace([['a.pptx', 'x']])
  const two = workspace([['b.pptx', 'y']])
  saveNote(one, 'a.pptx', { verdict: 'fix', text: '第 3 页溢出' })
  assert.deepEqual(
    { verdict: notesOf(one)['a.pptx'].verdict, text: notesOf(one)['a.pptx'].text },
    { verdict: 'fix', text: '第 3 页溢出' },
  )
  assert.deepEqual(notesOf(two), {})

  saveNote(one, 'a.pptx', { verdict: 'ok' })
  assert.equal(notesOf(one)['a.pptx'].verdict, 'ok', '只改结论时保留文字')
  assert.equal(notesOf(one)['a.pptx'].text, '第 3 页溢出')

  saveNote(one, 'a.pptx', { verdict: '', text: '' })
  assert.equal(notesOf(one)['a.pptx'], undefined, '结论和文字都空就删掉这条')

  saveNote(one, 'a.pptx', { text: '只有文字' })
  assert.equal(notesOf(one)['a.pptx'].verdict, '')
  assert.equal(notesOf(one)['a.pptx'].text, '只有文字')

  rmSync(one, { recursive: true, force: true })
  rmSync(two, { recursive: true, force: true })
})

test('pruneNotes 清掉已经不在台上的批注', () => {
  const root = workspace([['a.pptx', 'x'], ['b.pptx', 'y']])
  saveNote(root, 'a.pptx', { verdict: 'fix' })
  saveNote(root, 'b.pptx', { verdict: 'ok' })
  assert.equal(pruneNotes(root, new Set(['a.pptx'])), 1)
  assert.deepEqual(Object.keys(notesOf(root)), ['a.pptx'])
  assert.equal(pruneNotes(root, new Set(['a.pptx'])), 0)
  rmSync(root, { recursive: true, force: true })
})

test('交接清单：待改排在通过前面，带上路径和批注', () => {
  const items = [
    { rel: 'cover.png', name: 'cover.png', kind: 'image', bytes: 2048, mtime: '2026-01-01T00:00:00.000Z' },
    { rel: 'deck/slides.pptx', name: 'slides.pptx', kind: 'deck', bytes: 4096, mtime: '2026-01-02T00:00:00.000Z' },
  ]
  const notes = {
    'cover.png': { verdict: 'ok', text: '封面可以' },
    'deck/slides.pptx': { verdict: 'fix', text: '第 4 页标题压到图上了' },
  }
  const markdown = handoffMarkdown({ items, notes, now: new Date('2026-01-03T04:05:00.000Z') })
  assert.match(markdown, /^# 审阅清单/m)
  assert.match(markdown, /待改 1，通过 1/)
  assert.ok(markdown.indexOf('slides.pptx') < markdown.indexOf('cover.png'), '待改在前')
  assert.match(markdown, /第 4 页标题压到图上了/)
  assert.match(markdown, /`deck\/slides\.pptx`/)
  assert.match(markdown, /2026-01-03 04:05/)
})

test('交接清单：pick 只收选中的项，没有批注也能导出', () => {
  const items = [
    { rel: 'a.pptx', name: 'a.pptx', kind: 'deck', bytes: 1, mtime: '2026-01-01T00:00:00.000Z' },
    { rel: 'b.pptx', name: 'b.pptx', kind: 'deck', bytes: 1, mtime: '2026-01-01T00:00:00.000Z' },
  ]
  const markdown = handoffMarkdown({ items, notes: {}, pick: new Set(['b.pptx']) })
  assert.match(markdown, /b\.pptx/)
  assert.doesNotMatch(markdown, /a\.pptx/)
})

test('交接清单：一项都没有时给出提示而不是空文件', () => {
  const markdown = handoffMarkdown({ items: [], notes: {} })
  assert.match(markdown, /还没有批注/)
})

test('writeHandoff 把清单写进工作区根目录', () => {
  const root = workspace([['a.pptx', 'x']])
  const file = writeHandoff(root, '# 审阅清单\n', new Date('2026-01-03T04:05:06.000Z'))
  assert.match(file, /审阅清单-20260103-0405\.md$/)
  rmSync(root, { recursive: true, force: true })
})

test('notes.json 带 BOM 也能读（记事本改过的文件）', () => {
  const root = workspace([['a.pptx', 'x']])
  saveNote(root, 'a.pptx', { verdict: 'fix', text: '带 BOM 的批注' })
  const file = join(home, 'proof-board', 'notes.json')
  writeFileSync(file, '\uFEFF' + readFileSync(file, 'utf8'))
  const notes = notesOf(root)
  assert.equal(notes['a.pptx'].verdict, 'fix')
  assert.equal(notes['a.pptx'].text, '带 BOM 的批注')
  rmSync(root, { recursive: true, force: true })
})

test('DSH_HOME 指向临时目录时，批注落在那里', () => {
  const root = workspace([['a.pptx', 'x']])
  saveNote(root, 'a.pptx', { verdict: 'todo' })
  assert.ok(existsSync(join(home, 'proof-board', 'notes.json')))
  rmSync(root, { recursive: true, force: true })
})