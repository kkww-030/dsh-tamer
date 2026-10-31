import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadLogPath } from '../src/diagnostics.js'

// 加载自检默认写 <DSH_HOME>/dsh-tamer-load.log；测试改到临时目录，避免污染真实证据。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tamer-entry-home-'))

/**
 * 入口模块测试——这是"离线能做的最接近装载器的验证"。
 *
 * 因为入口刻意做到**零裸静态导入**，纯 Node 就能把 index.js 真正 import 进来，
 * 并调用 apply()：此时 @deepseek-ai/* 在纯 Node 下必然解析失败，
 * 正好把"可选 API 缺失时的降级路径"跑一遍。若哪天有人往入口加回裸静态导入，
 * 这个测试会立刻因 ERR_MODULE_NOT_FOUND 而失败。
 */
const here = dirname(fileURLToPath(import.meta.url))
const entryPath = resolve(here, '..', 'index.js')
const entryUrl = pathToFileURL(entryPath).href

test('入口没有任何裸静态导入（否则加载期即失败）', () => {
  const source = readFileSync(entryPath, 'utf8')
  const bare = []
  for (const match of source.matchAll(/^\s*import\s+(?:type\s+)?[^'"]*from\s*['"]([^'"]+)['"]/gmu)) {
    if (!match[1].startsWith('.') && !match[1].startsWith('node:')) bare.push(match[1])
  }
  assert.deepEqual(bare, [], `入口出现裸静态导入：${bare.join(', ')}`)
})

test('入口可被纯 Node 加载，并导出 name / inject / apply', async () => {
  const mod = await import(entryUrl)
  assert.equal(mod.name, 'dsh-tamer')
  assert.deepEqual(mod.inject, ['systemPrompt'])
  assert.equal(typeof mod.apply, 'function')
})

test('可选宿主 API 无法解析时，apply 仍然成功并完成装配（降级而非失败）', async () => {
  const mod = await import(entryUrl)

  const warnings = []
  const registered = { sections: [], commands: [], tools: [] }
  const listeners = new Map()
  const ctx = {
    logger: { info() {}, warn: (m) => warnings.push(m) },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    systemPrompt: { section: (o) => { registered.sections.push(o); return () => {} } },
    inject: (_deps, callback) => { callback(ctx); return () => {} },
    on: (event, listener) => { const l = listeners.get(event) ?? []; l.push(listener); listeners.set(event, l); return () => {} },
    commands: { register: (def) => registered.commands.push(def) },
    tools: { register: (def) => registered.tools.push(def) },
  }

  // 纯 Node 下 @deepseek-ai/dsh-llm 不存在 → 走内置消息工厂兜底，功能不降级
  const dispose = await mod.apply(ctx, {})
  assert.equal(typeof dispose, 'function', 'apply 必须返回释放函数')

  assert.equal(registered.sections.length, 1)
  assert.equal(registered.sections[0].name, 'tamer:protocol')
  assert.equal(registered.sections[0].interpolate, false)
  assert.equal(registered.commands.length, 1)
  assert.equal(registered.tools.length, 3)
  assert.equal(listeners.get('agent/turn-stopping')?.length, 1)

  // 加载自检日志必须留下"为什么没走宿主实现"的原文——桌面版没有控制台日志，
  // 这条记录是排查降级的唯一线索（20:49 那次就因为没有它而只能靠猜）
  const log = readFileSync(loadLogPath(), 'utf8').trim().split('\n')
  const applyRecord = JSON.parse(log[0])
  assert.equal(applyRecord.event, 'apply')
  assert.equal(applyRecord.apis.createUserMessage, 'builtin')
  assert.match(applyRecord.apiErrors.createUserMessage, /dsh-llm/u)
})
