import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendMemory,
  memoryBlock,
  parseMemory,
  readMemory,
  removeMemory,
  resolveMemoryPath,
} from '../src/memory.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-tamer-memory-'))
}

test('parseMemory 只取「- 」开头的约定行', () => {
  const text = ['# 标题', '# 说明', '- 做硬件先查官方 datasheet', '', '- 回复末尾必须列来源'].join('\n')
  assert.deepEqual(parseMemory(text), ['- 做硬件先查官方 datasheet', '- 回复末尾必须列来源'])
  assert.deepEqual(parseMemory(''), [])
  assert.deepEqual(parseMemory(undefined), [])
})

test('appendMemory 首次创建文件并写入约定', () => {
  const dir = tempDir()
  const path = join(dir, '记忆库', '约定.md')
  assert.equal(appendMemory(path, '做硬件先查官方 datasheet'), true)
  const entries = readMemory(path)
  assert.deepEqual(entries, ['- 做硬件先查官方 datasheet'])
  assert.match(readFileSync(path, 'utf8'), /外部记忆库/u)
})

test('appendMemory 追加多条且不重复前缀', () => {
  const dir = tempDir()
  const path = join(dir, '约定.md')
  appendMemory(path, '第一条')
  appendMemory(path, '- 第二条')
  assert.deepEqual(readMemory(path), ['- 第一条', '- 第二条'])
})

test('appendMemory 拒绝空内容', () => {
  const dir = tempDir()
  assert.equal(appendMemory(join(dir, '约定.md'), '   '), false)
})

test('removeMemory 按关键词删除并返回条数', () => {
  const dir = tempDir()
  const path = join(dir, '约定.md')
  appendMemory(path, '硬件任务先查 datasheet')
  appendMemory(path, '行情类必须给链接')
  assert.equal(removeMemory(path, 'datasheet'), 1)
  assert.deepEqual(readMemory(path), ['- 行情类必须给链接'])
  assert.equal(removeMemory(path, '不存在的词'), 0)
})

test('resolveMemoryPath 优先显式配置，其次向上探测', () => {
  const dir = tempDir()
  const nested = join(dir, 'a', 'b')
  mkdirSync(join(dir, '记忆库'), { recursive: true })
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(dir, '记忆库', '约定.md'), '- x\n', 'utf8')

  assert.equal(resolveMemoryPath({ configured: '', cwd: nested }), join(dir, '记忆库', '约定.md'))
  assert.equal(resolveMemoryPath({ configured: 'my/约定.md', cwd: dir }), join(dir, 'my', '约定.md'))
  assert.equal(
    resolveMemoryPath({ configured: 'D:/abs/约定.md', cwd: dir }).replace(/\\/gu, '/'),
    'D:/abs/约定.md',
  )
})

test('memoryBlock 空数组返回空串', () => {
  assert.equal(memoryBlock([]), '')
  assert.match(memoryBlock(['- a']), /外部记忆库/u)
})
