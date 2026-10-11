import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveSource, buildMark, resolveArchiveRoot, sanitizeSegment, stamp } from '../src/archive.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-tamer-archive-'))
}

test('sanitizeSegment 阻断目录穿越与非法字符', () => {
  assert.equal(sanitizeSegment('硬件项目'), '硬件项目')
  assert.equal(sanitizeSegment('../../etc'), 'etc')
  assert.equal(sanitizeSegment('a/b\\c'), 'a_b_c')
  assert.equal(sanitizeSegment('a:b*c?'), 'a_b_c_')
  assert.equal(sanitizeSegment('   '), '未命名')
  assert.equal(sanitizeSegment('..'), '未命名')
})

test('sanitizeSegment 保留合法的下划线与中文（不误伤真实项目名）', () => {
  // 早期实现会削掉前导下划线，把 `_插件自检` 变成 `插件自检`——实测踩到过
  assert.equal(sanitizeSegment('_插件自检'), '_插件自检')
  assert.equal(sanitizeSegment('v2_最终稿'), 'v2_最终稿')
  assert.equal(sanitizeSegment('.隐藏项目'), '.隐藏项目')
  assert.equal(sanitizeSegment('a//b/'), 'a_b')
})

test('stamp 生成 YYYYMMDD_HHMMSS', () => {
  const value = stamp(new Date(2026, 8, 13, 2, 40, 14))
  assert.equal(value, '20260913_024014')
})

test('buildMark 字段与 tracing/archive.py 一致', () => {
  const mark = buildMark({
    project: '示例项目',
    subject: 'STM32F103 引脚定义',
    source: 'ST 官方数据手册',
    link: 'https://www.st.com/resource/en/datasheet/stm32f103c8.pdf',
    note: '演示留痕功能',
    saveFileName: 'stm32f103_demo.txt',
    now: new Date(2026, 8, 13, 2, 40, 15),
  })
  assert.match(mark, /^- 保存时间: 2026-09-13 02:40:15$/mu)
  assert.match(mark, /^- 项目\/任务: 示例项目$/mu)
  assert.match(mark, /^- 主题: STM32F103 引脚定义$/mu)
  assert.match(mark, /^- 来源名称: ST 官方数据手册$/mu)
  assert.match(mark, /^- 来源链接: https:\/\/www\.st\.com/mu)
  assert.match(mark, /^- 用途: 演示留痕功能$/mu)
  assert.match(mark, /^- 存档原文: stm32f103_demo\.txt$/mu)
  assert.match(mark, /dsh-tamer 插件自动生成/u)
})

test('buildMark 省略未提供的字段', () => {
  const mark = buildMark({ project: 'p', now: new Date(2026, 0, 1, 0, 0, 0) })
  assert.doesNotMatch(mark, /^- 主题:/mu)
  assert.doesNotMatch(mark, /^- 来源名称:/mu)
})

test('archiveSource 落盘到 留痕仓库/<项目>/来源登记_<ts>.md', () => {
  const root = tempDir()
  const result = archiveSource({
    root,
    project: '硬件项目/子任务',
    subject: '主题',
    source: '来源',
    link: 'https://example.com',
    note: '用途',
    now: new Date(2026, 8, 13, 2, 40, 14),
  })
  assert.ok(existsSync(result.path), '登记文件应存在')
  assert.equal(result.dir, join(root, '硬件项目_子任务'))
  assert.equal(result.path, join(root, '硬件项目_子任务', '来源登记_20260913_024014.md'))
  assert.match(readFileSync(result.path, 'utf8'), /主题: 主题/u)
  assert.ok(result.bytes > 0)
})

test('archiveSource 复制原文（copyFiles=true 且文件存在）', () => {
  const root = tempDir()
  const original = join(root, 'demo.pdf')
  writeFileSync(original, 'PDF', 'utf8')
  const result = archiveSource({ root, project: 'p', saveFile: original, copyFiles: true })
  assert.equal(result.savedFile, 'demo.pdf')
  assert.ok(existsSync(join(result.dir, 'demo.pdf')))
})

test('archiveSource 不复制缺失的原文，也不因 copyFiles=false 复制', () => {
  const root = tempDir()
  const original = join(root, 'demo.txt')
  writeFileSync(original, 'x', 'utf8')
  const missing = archiveSource({ root, project: 'p1', saveFile: join(root, 'nope.txt') })
  assert.equal(missing.savedFile, null)
  const skipped = archiveSource({ root, project: 'p2', saveFile: original, copyFiles: false })
  assert.equal(skipped.savedFile, null)
  assert.doesNotMatch(readFileSync(skipped.path, 'utf8'), /^- 存档原文:/mu)
})

test('resolveArchiveRoot 显式配置优先，否则用 cwd/留痕仓库', () => {
  assert.equal(resolveArchiveRoot({ configured: '', cwd: 'C:/work' }).replace(/\\/gu, '/'), 'C:/work/留痕仓库')
  assert.equal(
    resolveArchiveRoot({ configured: 'D:/仓', cwd: 'C:/work' }).replace(/\\/gu, '/'),
    'D:/仓',
  )
})
