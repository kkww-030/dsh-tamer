import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage, resolveMessageFactory } from '../src/message.js'

test('内置 createUserMessage 生成合法的 user 消息', () => {
  const message = createUserMessage({
    content: [{ type: 'text', text: '你好' }],
    source: { kind: 'dsh-tamer' },
  })
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'dsh-tamer')
  assert.equal(message.content[0].text, '你好')
  assert.match(message.id, /^[0-9a-f-]{36}$/u, 'id 应为 UUID')
})

test('内置 createUserMessage 冻结消息（与官方语义一致）', () => {
  const message = createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'dsh-tamer' } })
  assert.equal(Object.isFrozen(message), true)
  assert.equal(Object.isFrozen(message.content), true)
  assert.equal(Object.isFrozen(message.content[0]), true)
  assert.throws(() => { message.role = 'assistant' }, TypeError)
})

test('内置 createUserMessage 深拷贝入参（改原对象不影响消息）', () => {
  const input = { content: [{ type: 'text', text: '原文' }], source: { kind: 'dsh-tamer' } }
  const message = createUserMessage(input)
  input.content[0].text = '被改了'
  assert.equal(message.content[0].text, '原文')
})

test('每条消息身份唯一', () => {
  const a = createUserMessage({ content: [], source: { kind: 'dsh-tamer' } })
  const b = createUserMessage({ content: [], source: { kind: 'dsh-tamer' } })
  assert.notEqual(a.id, b.id)
})

test('resolveMessageFactory 优先宿主实现，缺失回落内置且不降级', () => {
  const host = (input) => ({ ...input, role: 'user', id: 'host-id' })
  assert.deepEqual(resolveMessageFactory({ createUserMessage: host }), { factory: host, origin: 'host' })
  assert.equal(resolveMessageFactory({}).origin, 'builtin')
  assert.equal(resolveMessageFactory(undefined).origin, 'builtin')
  assert.equal(typeof resolveMessageFactory({}).factory, 'function')
})
