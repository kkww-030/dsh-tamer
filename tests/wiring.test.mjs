import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyTamer, lastUserText, textOfMessage } from '../src/wiring.js'

// 加载自检默认写 <DSH_HOME>/dsh-tamer-load.log；测试必须改到临时目录，
// 否则会往真实的"插件到底加载了没有"证据里掺入假记录。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tamer-home-'))

/* ── 测试替身：一个只记录行为的假 Cordis 上下文 ───────────────────── */

let msgSeq = 0
const api = {
  createUserMessage: (input) => ({ ...input, role: 'user', id: `msg-${(msgSeq += 1)}` }),
}

function fakeCtx() {
  const listeners = new Map()
  const reg = { sections: [], commands: [], tools: [], disposed: 0 }
  const defaultNext = async () => ({ kind: 'allow' })
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      const disposer = fn()
      return () => {
        reg.disposed += 1
        if (typeof disposer === 'function') disposer()
      }
    },
    systemPrompt: {
      section(options) {
        reg.sections.push(options)
        return () => {}
      },
    },
    inject(_deps, callback) {
      callback(ctx)
      return () => {}
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    commands: { register(def) { reg.commands.push(def) } },
    tools: { register(def) { reg.tools.push(def) } },
  }
  async function fire(event, payload, next = defaultNext) {
    let result
    for (const listener of listeners.get(event) ?? []) result = await listener(payload, next)
    return result
  }
  return { ctx, reg, fire }
}

function fakeAgent(cwd) {
  return {
    injected: [],
    steered: [],
    inject(message) { this.injected.push(message) },
    steer(message) { this.steered.push(message) },
    session: { header: { cwd } },
  }
}

const text = (message) => message.content.map((block) => block.text).join('\n')
const userMessage = (value, source = { kind: 'user' }) => ({
  role: 'user',
  source,
  content: [{ type: 'text', text: value }],
})
const tempDir = () => mkdtempSync(join(tmpdir(), 'dsh-tamer-wiring-'))

/* ── 装配 ─────────────────────────────────────────────────────────── */

test('applyTamer 注册协议段 / 档位命令 / 留痕工具', () => {
  const { ctx, reg } = fakeCtx()
  const dispose = applyTamer(ctx, {}, api)
  assert.equal(typeof dispose, 'function')
  assert.equal(reg.sections.length, 1)
  assert.equal(reg.sections[0].name, 'tamer:protocol')
  assert.equal(typeof reg.sections[0].order, 'number')
  // 必须关闭变量插值：未解析的 {{...}} 会让提示词组装失败（见 src/wiring.js 注释）
  assert.equal(reg.sections[0].interpolate, false)
  assert.equal(reg.commands.length, 1)
  assert.equal(reg.commands[0].name, 'tamer')
  assert.equal(reg.tools.length, 1)
  assert.equal(reg.tools[0].name, 'tamer_archive')
  dispose()
})

test('缺少宿主 API 时用内置消息工厂，装配照常且不抛错', () => {
  // DSH 启动是全有全无的，插件不该因为一个可选 API 缺失就整体失败
  const { ctx, reg } = fakeCtx()
  const dispose = applyTamer(ctx, {}, {})
  assert.equal(reg.sections.length, 1)
  assert.equal(reg.tools.length, 1)
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('内置消息工厂下，上下文注入与来源打回都照常工作（不降级）', async () => {
  // 本机实测宿主 @deepseek-ai/dsh-llm 解析不到；这两条是插件的核心价值，必须在兜底路径下仍然成立
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, {}, {})
  const agent = fakeAgent(tempDir())

  await fire('agent/created', { agent })
  assert.equal(agent.injected.length, 1, '应注入会话上下文（档位）')
  assert.equal(agent.injected[0].role, 'user')
  assert.equal(agent.injected[0].source.kind, 'dsh-tamer')
  assert.match(agent.injected[0].id, /^[0-9a-f-]{36}$/u, '内置工厂应生成 UUID 身份')

  await fire('agent/pre-step', { agent, messages: [userMessage('STM32F103 的引脚定义是什么')] })
  await fire('agent/assistant-stream', {
    agent,
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '大概是 PA0 到 PA15。' } },
  })
  await fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 1, '命中来源校验必须打回')
  assert.match(agent.steered[0].content[0].text, /信息来源/u)
})

test('坏配置回落到默认值且不抛错', () => {
  const { ctx, reg } = fakeCtx()
  applyTamer(ctx, { mode: 'bogus', censor: 42, reinjectEvery: -3, protocolOrder: 'x' }, api)
  assert.equal(reg.sections[0].name, 'tamer:protocol')
})

/* ── 会话上下文注入 ───────────────────────────────────────────────── */

test('agent/created 注入档位与外部记忆库', async () => {
  const cwd = tempDir()
  mkdirSync(join(cwd, '记忆库'), { recursive: true })
  writeFileSync(join(cwd, '记忆库', '约定.md'), '- 做硬件先查官方 datasheet\n', 'utf8')

  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, {}, api)
  const agent = fakeAgent(cwd)
  await fire('agent/created', { agent })

  assert.equal(agent.injected.length, 1)
  const injected = text(agent.injected[0])
  assert.match(injected, /当前档位/u)
  assert.match(injected, /外部记忆库/u)
  assert.match(injected, /datasheet/u)
})

test('agent/created 没赶上时，pre-step 兜底把上下文并入本步批次（且只补一次）', async () => {
  // 实测 4 次插件加载只有 1 次走到 agent/created，只靠那个事件会让部分会话静默拿不到档位
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, {}, api)
  const agent = fakeAgent(tempDir())
  const claimed = [userMessage('你好')]

  // 注意：这里刻意不 fire agent/created
  const decision = await fire(
    'agent/pre-step',
    { agent, messages: claimed },
    async () => ({ kind: 'enter', messages: claimed, startsRequestSeries: true }),
  )
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2, '兜底上下文应并入本步批次')
  assert.equal(decision.messages[1].source.kind, 'dsh-tamer')
  assert.equal(decision.startsRequestSeries, true, '改写 decision 必须保留其他字段（如 startsRequestSeries）')

  // 幂等：第二次不再补
  const again = await fire(
    'agent/pre-step',
    { agent, messages: claimed },
    async () => ({ kind: 'enter', messages: claimed }),
  )
  assert.equal(again.messages.length, 1)

  // reject 分支不得被改写
  const rejected = await fire('agent/pre-step', { agent, messages: claimed }, async () => ({ kind: 'reject' }))
  assert.deepEqual(rejected, { kind: 'reject' })
})

test('已是 enter 但 agent 已 prime 过 → 不重复并入', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, {}, api)
  const agent = fakeAgent(tempDir())
  await fire('agent/created', { agent })
  const claimed = [userMessage('你好')]
  const decision = await fire(
    'agent/pre-step',
    { agent, messages: claimed },
    async () => ({ kind: 'enter', messages: claimed }),
  )
  assert.equal(decision.messages.length, 1)
})

test('无记忆库时也注入档位（不报错）', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, {}, api)
  const agent = fakeAgent(tempDir())
  await fire('agent/created', { agent })
  assert.equal(agent.injected.length, 1)
  assert.doesNotMatch(text(agent.injected[0]), /外部记忆库/u)
})

/* ── 档位命令 ─────────────────────────────────────────────────────── */

test('/tamer 命令：切档、记忆增删、状态', async () => {
  const cwd = tempDir()
  const { ctx, reg, fire } = fakeCtx()
  applyTamer(ctx, {}, api)
  const agent = fakeAgent(cwd)
  await fire('agent/created', { agent })
  const handler = reg.commands[0].handler

  assert.equal(handler({ agent, rawInput: '' }).kind, 'success')
  assert.equal(handler({ agent, rawInput: 'help' }).kind, 'success')

  const switched = handler({ agent, rawInput: 'strict' })
  assert.equal(switched.kind, 'success')
  assert.match(switched.text, /strict/u)

  const chinese = handler({ agent, rawInput: '快速' })
  assert.match(chinese.text, /fast/u)

  const remembered = handler({ agent, rawInput: 'remember 行情类必须给链接' })
  assert.equal(remembered.kind, 'success')
  assert.ok(existsSync(join(cwd, '记忆库', '约定.md')))

  const listed = handler({ agent, rawInput: 'memory' })
  assert.match(listed.text, /行情类必须给链接/u)

  const status = handler({ agent, rawInput: 'status' })
  assert.match(status.text, /档位：fast/u)

  const forgotten = handler({ agent, rawInput: 'forget 行情类' })
  assert.match(forgotten.text, /已删除 1 条/u)

  assert.equal(handler({ agent, rawInput: 'remember' }).kind, 'error')
  assert.equal(handler({ agent, rawInput: 'nonsense' }).kind, 'error')
})

test('/tamer 子命令优先于切档：参数里的档位词不会劫持 remember/forget', async () => {
  // 真实缺陷：detectMode 曾跑在整串 rawInput 上且早于子命令分支，
  // 于是 `/tamer remember 严格模式必须列来源` 会切档而丢掉约定。
  const cwd = tempDir()
  const { ctx, reg, fire } = fakeCtx()
  applyTamer(ctx, {}, api)
  const agent = fakeAgent(cwd)
  await fire('agent/created', { agent })
  const handler = reg.commands[0].handler

  const remembered = handler({ agent, rawInput: 'remember 严格模式必须列来源' })
  assert.equal(remembered.kind, 'success')
  assert.match(remembered.text, /已记入/u)
  assert.match(readFileSync(join(cwd, '记忆库', '约定.md'), 'utf8'), /严格模式必须列来源/u)
  assert.match(handler({ agent, rawInput: 'status' }).text, /档位：standard/u, '不应被参数里的「严格模式」切档')

  const forgotten = handler({ agent, rawInput: 'forget 严格模式' })
  assert.match(forgotten.text, /已删除 1 条/u)
  assert.match(handler({ agent, rawInput: 'status' }).text, /档位：standard/u, '不应被参数里的档位词切档')
})

/* ── 自然语言切档：只认精确匹配 ───────────────────────────────────── */

test('FastAPI/fastboot/strict 这类词不会静默切档（否则快速档会关掉打回）', async () => {
  const cwd = tempDir()
  const { ctx, reg, fire } = fakeCtx()
  applyTamer(ctx, { censor: 'warn' }, api)
  const agent = fakeAgent(cwd)
  await fire('agent/created', { agent })
  const handler = reg.commands[0].handler

  // 含 "FastAPI" + 客观信息：若被误判成 fast 档，censor 会被跳过
  await fire('agent/pre-step', {
    agent,
    messages: [userMessage('用 FastAPI 写接口，参数按 ST 官方规格来')],
  })
  assert.match(handler({ agent, rawInput: 'status' }).text, /档位：standard/u, 'FastAPI 不得触发快速档')

  await fire('agent/assistant-stream', {
    agent,
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '接口这样写就行。' } },
  })
  await fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 1, '仍在标准档校验 → 应打回')
})

test('整句就是档位词时仍然切档', async () => {
  const { ctx, reg, fire } = fakeCtx()
  applyTamer(ctx, {}, api)
  const agent = fakeAgent(tempDir())
  await fire('agent/created', { agent })

  await fire('agent/pre-step', { agent, messages: [userMessage('严格模式')] })
  assert.match(reg.commands[0].handler({ agent, rawInput: 'status' }).text, /档位：strict/u)
})

/* ── 兜底注入的回滚 ───────────────────────────────────────────────── */

test('pre-step 未被接纳时回滚 primed，下一步仍能补注入', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, {}, api)
  const agent = fakeAgent(tempDir())
  const claimed = [userMessage('你好')]

  const rejected = await fire('agent/pre-step', { agent, messages: claimed }, async () => ({ kind: 'reject' }))
  assert.deepEqual(rejected, { kind: 'reject' })

  const entered = await fire('agent/pre-step', { agent, messages: claimed }, async () => ({ kind: 'enter', messages: claimed }))
  assert.equal(entered.messages.length, 2, '回滚后必须仍能补注入（否则该会话永久失去档位与记忆库）')
})

/* ── 助手文本缓冲：按 attempt 隔离 ────────────────────────────────── */

test('attempt 的 start 帧清空缓冲：中途片段不污染来源判定', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, { censor: 'strict' }, api)
  const agent = fakeAgent(tempDir())

  await fire('agent/pre-step', { agent, messages: [userMessage('该芯片引脚定义是什么')] })
  // 第一次尝试提到过链接
  await fire('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '参考 https://example.com' } } })
  // 重做：start 清空，最终答复没有来源
  await fire('agent/assistant-stream', { agent, frame: { type: 'start' } })
  await fire('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '引脚定义如下。' } } })

  await fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 1, '应按最近一次尝试判定，而不是把两次尝试拼起来')
})

/* ── 来源校验（打回重做） ─────────────────────────────────────────── */

test('涉及客观信息且回复无来源 → 打回一次（默认 warn）', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, {}, api)
  const agent = fakeAgent(tempDir())

  await fire('agent/pre-step', { agent, messages: [userMessage('STM32F103 的引脚定义是什么')] })
  await fire('agent/assistant-stream', {
    agent,
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '大概是 PA0 到 PA15。' } },
  })
  await fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 1)
  assert.match(text(agent.steered[0]), /信息来源/u)

  // 同一轮内第二次收尾：warn 只打回一次，放过以免死循环
  await fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 1)
})

test('闲聊轮次不打扰', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, {}, api)
  const agent = fakeAgent(tempDir())
  await fire('agent/pre-step', { agent, messages: [userMessage('今天天气不错')] })
  await fire('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '是的。' } } })
  await fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 0)
})

test('已列来源的回复不打回', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, {}, api)
  const agent = fakeAgent(tempDir())
  await fire('agent/pre-step', { agent, messages: [userMessage('引脚定义是什么')] })
  await fire('agent/assistant-stream', {
    agent,
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '引脚如下。\n信息来源：ST 官方手册 https://www.st.com/x.pdf' } },
  })
  await fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 0)
})

test('严格档 + strict 校验：连续打回两次后放过', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, { mode: 'strict', censor: 'strict' }, api)
  const agent = fakeAgent(tempDir())
  await fire('agent/pre-step', { agent, messages: [userMessage('该寄存器的规格参数是什么')] })
  await fire('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '参数是 72MHz。' } } })
  await fire('agent/turn-stopping', { agent, turn: 1 })
  await fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 2)
  await fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 2)
})

test('快速档不校验', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, { mode: 'fast', censor: 'strict' }, api)
  const agent = fakeAgent(tempDir())
  await fire('agent/pre-step', { agent, messages: [userMessage('引脚定义是什么')] })
  await fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steered.length, 0)
})

test('整句写「严格模式」会切档，并在后续轮生效', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, { censor: 'strict' }, api)
  const agent = fakeAgent(tempDir())

  // 第 1 轮：整句档位词 → 切到严格档
  await fire('agent/pre-step', { agent, messages: [userMessage('严格模式')] })
  // 第 2 轮：标准档只看用户提问；严格档还会看回复正文里的客观信息
  await fire('agent/pre-step', { agent, messages: [userMessage('帮我看看这个')] })
  await fire('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '该寄存器规格为 72MHz。' } } })
  await fire('agent/turn-stopping', { agent, turn: 2 })
  assert.equal(agent.steered.length, 1)
})

/* ── 每 N 轮重申 ──────────────────────────────────────────────────── */

test('每 N 轮注入一次协议重申（同一轮不重复）', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, { reinjectEvery: 2 }, api)
  const agent = fakeAgent(tempDir())
  await fire('agent/created', { agent })
  assert.equal(agent.injected.length, 1) // 首轮上下文

  await fire('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.injected.length, 1)

  await fire('agent/turn-stopping', { agent, turn: 2 })
  assert.equal(agent.injected.length, 2)
  assert.match(text(agent.injected[1]), /协议重申/u)

  await fire('agent/turn-stopping', { agent, turn: 2 })
  assert.equal(agent.injected.length, 2)
})

test('reinjectEvery=0 关闭重申', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, { reinjectEvery: 0 }, api)
  const agent = fakeAgent(tempDir())
  await fire('agent/created', { agent })
  await fire('agent/turn-stopping', { agent, turn: 10 })
  assert.equal(agent.injected.length, 1)
})

/* ── 执行门禁（execGate，默认 off） ───────────────────────────────── */

test('execGate=off 时任何工具调用都放行', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, { execGate: 'off' }, api)
  const agent = fakeAgent(tempDir())
  await fire('agent/pre-step', { agent, messages: [userMessage('该芯片引脚定义')] })
  const decision = await fire('tools/pre-execute', { agent, name: 'write' })
  assert.deepEqual(decision, { kind: 'allow' })
})

test('execGate=ask：未查来源就要写文件 → 先问一次', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, { execGate: 'ask' }, api)
  const agent = fakeAgent(tempDir())
  await fire('agent/pre-step', { agent, messages: [userMessage('该芯片引脚定义，帮我改配置')] })

  const asked = await fire('tools/pre-execute', { agent, name: 'write' })
  assert.equal(asked.kind, 'ask')
  assert.ok(asked.displayReason.zh)

  // 只读工具不拦
  const readOk = await fire('tools/pre-execute', { agent, name: 'read' })
  assert.deepEqual(readOk, { kind: 'allow' })
})

test('execGate=ask：已经查过来源就放行', async () => {
  const { ctx, fire } = fakeCtx()
  applyTamer(ctx, { execGate: 'ask' }, api)
  const agent = fakeAgent(tempDir())
  await fire('agent/pre-step', { agent, messages: [userMessage('该芯片引脚定义，帮我改配置')] })
  await fire('tools/pre-execute', { agent, name: 'web_search' })
  const decision = await fire('tools/pre-execute', { agent, name: 'write' })
  assert.deepEqual(decision, { kind: 'allow' })
})

/* ── 留痕工具 ─────────────────────────────────────────────────────── */

test('tamer_archive 工具定义合法且能落盘', async () => {
  const cwd = tempDir()
  const { ctx, reg } = fakeCtx()
  applyTamer(ctx, {}, api)
  const tool = reg.tools[0]
  assert.equal(typeof tool.execute, 'function')
  // 原始 ToolDefinition：parameters 就是 JSON Schema（不再经过 defineTool 的作者 DSL）
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['project'])
  assert.equal(tool.parameters.properties.project.type, 'string')
  assert.equal(tool.output.schema.type, 'string')
  assert.equal(typeof tool.output.render, 'function')

  const agent = fakeAgent(cwd)
  const path = await tool.execute(
    { project: '测试项目', subject: '主题', source: '来源', link: 'https://example.com', note: '用途' },
    { agent, signal: { aborted: false } },
  )
  assert.ok(existsSync(path))
  assert.match(path.replace(/\\/gu, '/'), /留痕仓库\/测试项目\/来源登记_/u)
})

test('tamer_archive 在取消信号下拒绝执行', async () => {
  const { ctx, reg } = fakeCtx()
  applyTamer(ctx, {}, api)
  await assert.rejects(
    () => reg.tools[0].execute({ project: 'p' }, { agent: fakeAgent(tempDir()), signal: { aborted: true } }),
    /取消/u,
  )
})

/* ── 纯函数工具 ───────────────────────────────────────────────────── */

test('lastUserText 跳过本插件自己注入的消息', () => {
  const messages = [
    userMessage('真正的提问：引脚定义'),
    userMessage('（dsh-tamer 会话上下文）当前档位：标准', { kind: 'dsh-tamer' }),
  ]
  assert.equal(lastUserText(messages), '真正的提问：引脚定义')
  assert.equal(lastUserText([userMessage('只有插件消息', { kind: 'dsh-tamer' })]), '')
  assert.equal(textOfMessage({ content: [{ type: 'text', text: 'a' }, { type: 'image' }] }), 'a')
})
