import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLogPath, reportLoad, resolveDshHome } from '../src/diagnostics.js'

test('resolveDshHome 优先 DSH_HOME，否则回落 ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'D:/custom' }), 'D:/custom')
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }).endsWith('.dsh'), true)
  assert.equal(resolveDshHome({}).endsWith(join('', '.dsh')), true)
})

test('reportLoad 追加 JSONL 且不覆盖历史', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tamer-diag-'))
  const env = { DSH_HOME: home }
  const first = reportLoad({ event: 'apply', version: '0.1.0', apis: { createUserMessage: true } }, env)
  const second = reportLoad({ event: 'wired', tools: 1 }, env)

  assert.equal(first, loadLogPath(env))
  assert.equal(existsSync(first), true)
  const lines = readFileSync(first, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  const record = JSON.parse(lines[0])
  assert.equal(record.event, 'apply')
  assert.equal(record.version, '0.1.0')
  assert.equal(record.apis.createUserMessage, true)
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/u)
  assert.equal(JSON.parse(lines[1]).event, 'wired')
  assert.equal(second, first)
})

test('诊断失败不影响插件（不可写路径返回 null，不抛错）', () => {
  // Windows 上非法字符路径一定失败；关键是不抛异常
  const result = reportLoad({ event: 'apply' }, { DSH_HOME: 'Z:\\definitely\\not\\a\\drive' })
  assert.equal(result, null)
})
