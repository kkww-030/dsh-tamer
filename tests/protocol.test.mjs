import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_SHA256, PROTOCOL_SOURCE, PROTOCOL_TEXT } from '../src/protocol.js'
import { protocolSectionText } from '../src/prompt.js'

const here = dirname(fileURLToPath(import.meta.url))
const sourceCandidates = [
  resolve(here, '..', 'protocol', '协议注入模板.txt'),
  resolve(here, '..', '..', 'core', '协议注入模板.txt'),
]
const sourcePath = sourceCandidates.find((candidate) => existsSync(candidate)) ?? sourceCandidates[0]

test('生成的协议文本与协议正文逐字节一致（防漂移）', () => {
  const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/gu, '\n').trimEnd()
  assert.equal(PROTOCOL_TEXT, source)
  assert.equal(PROTOCOL_SHA256, createHash('sha256').update(source, 'utf8').digest('hex'))
  // 两种布局都合法：独立分享副本是 protocol/…，工具集同仓时是 ../core/…
  assert.ok(
    ['protocol/协议注入模板.txt', '../core/协议注入模板.txt'].includes(PROTOCOL_SOURCE),
    `PROTOCOL_SOURCE 意外：${PROTOCOL_SOURCE}`,
  )
})

test('协议段包含四条核心与三档', () => {
  const text = protocolSectionText()
  for (const keyword of ['先澄清', '信息来源', '四条核心', '档位']) {
    assert.ok(text.includes(keyword), `协议段缺少「${keyword}」`)
  }
  assert.ok(text.includes('/tamer'), '协议段应说明档位命令')
})

test('协议段是纯静态文本（利于提供方前缀缓存复用）', () => {
  assert.equal(protocolSectionText(), protocolSectionText())
})
