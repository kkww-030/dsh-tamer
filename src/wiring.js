/**
 * dsh-tamer · 装配层（宿主半的真正实现）
 *
 * 与 index.js 分离的原因只有一个：**可测试**。index.js 承担两个无法在纯 Node 下解析的
 * 裸导入（`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`，二者只在 DSH 宿主里可解析），
 * 本文件只依赖纯函数与注入进来的 api，因此可以用 `node --test` 配桩直接验证装配逻辑。
 *
 * 用到的 DSH 接口（均已在官方源码中核对签名）：
 *   - ctx.systemPrompt.section({ name, order, text })        packages/core/system-prompt/README.md:59
 *   - ctx.commands.register({ name, description, input, handler })  packages/interaction/commands/README.md:32
 *   - ctx.on('agent/created' | 'agent/pre-step' | 'agent/assistant-stream' | 'agent/turn-stopping')
 *   - ctx.on('tools/pre-execute', (exec, next) => PreToolDecision)
 *   - ctx.tools.register(<原始 ToolDefinition>，不依赖 defineTool，见第 5 节注释)
 *   - agent.inject(UserMessage) / agent.steer(UserMessage)   packages/core/agent/src/runtime-types.ts:222,231,241
 */
import { normalizeConfig } from './config.js'
import { detectModeExact, MODES, normalizeMode } from './modes.js'
import { evaluateCensor, correctionText, runPreflight, evaluateFinalize } from './censor.js'
import { appendMemory, readMemory, removeMemory, resolveMemoryPath } from './memory.js'
import { archiveSource, resolveArchiveRoot } from './archive.js'
import { beginTurn, stateOf } from './state.js'
import { modeContextText, protocolSectionText, reinforceText } from './prompt.js'
import { reportLoad } from './diagnostics.js'
import { resolveMessageFactory } from './message.js'
import { savedMode, saveWorkspaceState, writeSnapshot } from './persist.js'

/** 本插件注入消息的来源标记；DSH 会按 kind 判断消息来源。 */
export const SOURCE_KIND = 'dsh-tamer'

/** 安全的日志出口：日志本身绝不能影响会话流程。 */
function log(ctx, level, message) {
  try {
    ctx?.logger?.[level]?.(`dsh-tamer: ${message}`)
  } catch {
    /* ignore */
  }
}

/** 会话工作目录：优先用会话头，其次进程 cwd。 */
export function cwdOf(agent) {
  return agent?.session?.header?.cwd ?? process.cwd()
}

/** 把消息内容里的文本块拼成纯文本。 */
export function textOfMessage(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 取最近一条「不是本插件注入」的用户消息文本。 */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message) continue
    if (message.role && message.role !== 'user') continue
    if (message.source?.kind === SOURCE_KIND) continue
    const text = textOfMessage(message)
    if (text.trim()) return text
  }
  return ''
}

/**
 * 构造一条注入用的用户消息。
 * `createUserMessage` 由宿主注入；拿不到时返回 null，调用方一律跳过注入——
 * 这样"缺少某个可选 API"只让功能降级，绝不会让插件加载失败。
 */
function makeContextMessage(createUserMessage, text) {
  if (typeof createUserMessage !== 'function') return null
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND },
  })
}

/**
 * 装配 dsh-tamer。
 * @param {any} ctx - Cordis 上下文
 * @param {unknown} rawConfig - 插件行 `config:` 的原始值
 * @param {{createUserMessage?: Function}} api - 宿主注入的可选构造器（缺失即降级）
 * @returns {() => void} 释放函数（插件卸载时调用）
 */
export function applyTamer(ctx, rawConfig, api) {
  // 消息工厂：宿主给了就用宿主的，没给就用内置等价实现（src/message.js）。
  // 本机实测（dsh-tamer-load.log 20:49）宿主 API 在 profile 插件里解析不到；
  // 若没有这个兜底，「上下文注入 / 每 N 轮重申 / 来源缺失打回」会整体失效——
  // 那正是本插件的核心价值，所以这里是兜底而不是降级。
  const messages = resolveMessageFactory(api)
  const createUserMessage = messages.factory
  if (messages.origin === 'builtin') {
    log(ctx, 'info', '宿主未提供 createUserMessage，已启用内置消息工厂（功能不降级）')
  }

  const config = normalizeConfig(rawConfig, ctx?.logger)
  const disposers = []
  const track = (disposer) => {
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  }

  // ── 工具函数：解析路径 / 注入上下文 ──────────────────────────────

  const memoryPathFor = (agent) => resolveMemoryPath({ configured: config.memoryFile, cwd: cwdOf(agent) })
  const archiveRootFor = (agent) => resolveArchiveRoot({ configured: config.archiveRoot, cwd: cwdOf(agent) })

  /** 消息里的可读文本长度（仅用于自检日志）。 */
  function messageChars(message) {
    if (!Array.isArray(message?.content)) return 0
    return message.content.reduce((n, block) => n + (typeof block?.text === 'string' ? block.text.length : 0), 0)
  }

  /**
   * 注入一条**已构造好**的消息。
   * 成功与失败都写进自检日志：桌面版**没有控制台**，`ctx.logger` 的告警看不到，
   * 20:49 那次"降级运行"就是因此被隐藏的——消息准入若拒绝我们的 source.kind，
   * 只会表现为"上下文不出现"，不写日志就无从诊断。
   */
  function injectMessage(agent, message, phase) {
    if (!message) return false
    try {
      agent?.inject?.(message)
      if (config.diagnostics !== false) {
        reportLoad({ event: 'context-injected', phase, messageId: message.id, chars: messageChars(message) })
      }
      return true
    } catch (error) {
      if (config.diagnostics !== false) {
        reportLoad({ event: 'inject-failed', phase, error: String(error?.message ?? error) })
      }
      log(ctx, 'warn', `注入会话上下文失败：${String(error)}`)
      return false
    }
  }

  function injectContext(agent, text, phase) {
    return injectMessage(agent, makeContextMessage(createUserMessage, text), phase)
  }

  /** 上下文文本的**唯一**构造点：档位 + 记忆库 + 解析出的路径（让模型自己核对工作区）。 */
  function contextTextFor(agent, state) {
    const memoryPath = memoryPathFor(agent)
    let entries = []
    try {
      entries = readMemory(memoryPath)
    } catch (error) {
      log(ctx, 'warn', `读取记忆库失败：${String(error)}`)
    }
    return modeContextText(state.mode, entries, { memoryPath, archiveRoot: archiveRootFor(agent) })
  }

  /**
   * 按工作区恢复档位（借鉴 trae-tamer 的每项目持久状态）。
   * 只做一次；工作区持久值优先于 config.mode，让新会话沿用你上次选的档位。
   */
  function restoreMode(agent, state) {
    if (!config.persistMode || state.modeRestored) return
    state.modeRestored = true
    try {
      const saved = savedMode(cwdOf(agent))
      if (saved && saved !== state.mode) {
        state.mode = saved
        log(ctx, 'info', `已恢复该工作区的档位：${saved}`)
      }
    } catch (error) {
      log(ctx, 'warn', `恢复工作区档位失败：${String(error)}`)
    }
  }

  /** 切档后把档位写进工作区状态（`persistMode` 关闭时什么都不做）。 */
  function persistModeOf(agent, state) {
    if (!config.persistMode) return
    try {
      saveWorkspaceState(cwdOf(agent), { mode: state.mode })
    } catch {
      /* 持久化失败不影响切档 */
    }
  }

  /**
   * 首次进入会话的上下文（档位 + 外部记忆库）——**幂等**，已给过就返回 null。
   *
   * 返回消息而不是直接注入，是为了让 `agent/pre-step` 能把它拼进本步的消息批次：
   * 实测 4 次插件加载只有 1 次走到 `agent/created`（见 dsh-tamer-load.log 23:09），
   * 只靠那个事件会让部分会话**静默拿不到档位与记忆库**。
   */
  function ensurePrime(agent, state) {
    if (state.primed) return null
    state.primed = true
    let entries = []
    try {
      entries = readMemory(memoryPathFor(agent))
    } catch (error) {
      log(ctx, 'warn', `读取记忆库失败：${String(error)}`)
    }
    state.memoryHash = hashEntries(entries)
    if (entries.length > 0) log(ctx, 'info', `已注入外部记忆 ${entries.length} 条`)
    return makeContextMessage(
      createUserMessage,
      modeContextText(state.mode, entries, { memoryPath: memoryPathFor(agent), archiveRoot: archiveRootFor(agent) }),
    )
  }

  /** 快路径：`agent/created` 到了就直接注入（正常情况下降落于首个回合）。 */
  function primeAgent(agent) {
    const state = stateOf(agent, config)
    restoreMode(agent, state)
    injectMessage(agent, ensurePrime(agent, state), 'prime')
  }

  /** 记忆库变更时重新注入（每轮边界检查一次，代价极低）。 */
  function syncMemory(agent, state) {
    let entries = []
    try {
      entries = readMemory(memoryPathFor(agent))
    } catch {
      return
    }
    const next = hashEntries(entries)
    if (next === state.memoryHash) return
    state.memoryHash = next
    injectContext(
      agent,
      modeContextText(state.mode, entries, { memoryPath: memoryPathFor(agent), archiveRoot: archiveRootFor(agent) }),
      'memory-sync',
    )
    log(ctx, 'info', '外部记忆库已变更，重新注入')
  }

  // ── 1. 协议注入（系统提示词段落） ────────────────────────────────

  track(ctx.effect(() => ctx.systemPrompt.section({
    name: 'tamer:protocol',
    order: config.protocolOrder,
    // 协议正文是字面量，必须关掉变量插值：
    // 默认 interpolate=true 时，文本里任何未解析的 `{{...}}` 会让整个提示词组装失败
    // （官方 system-prompt README：「unresolved variables fail assembly」），
    // 而协议文本是用户可以随手编辑的。宁可字面输出，也不能让主人的每个请求都挂。
    interpolate: false,
    text: protocolSectionText(),
  })))

  // ── 2. 档位命令（commands 服务可选） ────────────────────────────

  function handleCommand({ agent, rawInput }) {
    const state = stateOf(agent, config)
    const input = String(rawInput ?? '').trim()
    const [head, ...rest] = input.split(/\s+/u)
    const word = (head ?? '').toLowerCase()
    const tail = rest.join(' ').trim()

    if (!input || word === 'help') {
      return {
        kind: 'success',
        text: [
          'dsh-tamer 可用命令：',
          '  /tamer fast | standard | strict   切换档位（也可用中文别名：快速/标准/严格）',
          '  /tamer status                     查看当前档位与记忆库状态',
          '  /tamer memory                     列出外部记忆库',
          '  /tamer remember <内容>            追加一条长期约定',
          '  /tamer forget <关键词>            删除含关键词的约定',
        ].join('\n'),
      }
    }

    if (word === 'status') {
      const path = memoryPathFor(agent)
      const entries = readMemory(path)
      return {
        kind: 'success',
        text: [
          `档位：${state.mode}`,
          `已进行轮次：${state.lastTurn}`,
          `来源校验：${config.censor}（每 ${config.reinjectEvery} 轮重申）`,
          `执行门禁：${config.execGate}`,
          `记忆库：${entries.length} 条 · ${path}`,
          `留痕仓库：${archiveRootFor(agent)}`,
        ].join('\n'),
      }
    }

    if (word === 'memory') {
      const entries = readMemory(memoryPathFor(agent))
      return { kind: 'success', text: entries.length ? entries.join('\n') : '（外部记忆库为空）' }
    }

    if (word === 'remember') {
      if (!tail) return { kind: 'error', text: '用法：/tamer remember <内容>' }
      const path = memoryPathFor(agent)
      appendMemory(path, tail)
      const entries = readMemory(path)
      state.memoryHash = hashEntries(entries)
      injectContext(agent, modeContextText(state.mode, entries), 'remember')
      return { kind: 'success', text: `已记入外部记忆库（长期生效）：${tail}` }
    }

    if (word === 'forget') {
      if (!tail) return { kind: 'error', text: '用法：/tamer forget <关键词>' }
      const path = memoryPathFor(agent)
      const removed = removeMemory(path, tail)
      const entries = readMemory(path)
      state.memoryHash = hashEntries(entries)
      injectContext(agent, modeContextText(state.mode, entries), 'forget')
      return { kind: 'success', text: `已删除 ${removed} 条含「${tail}」的约定` }
    }

    // 档位切换放在**所有子命令之后**：否则 `/tamer remember 严格模式必须列来源`
    // 会先在整串 rawInput 上匹配到「严格模式」而被当成切档，约定丢失；
    // `/tamer forget fast` 同理。冒烟测试覆盖了这两个用例。
    const detected = MODES.includes(word) ? word : detectModeExact(input)
    if (detected) {
      state.mode = normalizeMode(detected, config.mode)
      persistModeOf(agent, state)
      injectContext(agent, contextTextFor(agent, state), 'mode-switch')
      return { kind: 'success', text: `已切换到【${state.mode}】：${modeHintText(state.mode)}` }
    }

    return { kind: 'error', text: `未知子命令：${word}。用 /tamer help 查看用法。` }
  }

  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'tamer',
      description: '切换驯服档位 / 查看状态 / 管理外部记忆库',
      input: { hint: '<fast|standard|strict|status|memory|remember 内容|forget 关键词>' },
      handler: handleCommand,
    })
  })

  // ── 3. 会话生命周期 ──────────────────────────────────────────────

  ctx.on('agent/created', async ({ agent }) => {
    try {
      primeAgent(agent)
    } catch (error) {
      log(ctx, 'warn', `初始化会话失败：${String(error)}`)
    }
  })

  // 记录用户提问；若 `agent/created` 没赶上，就在这里**兜底补齐**首次上下文。
  // 必须严格遵守 waterfall 契约：`next()` 只调用一次，改写下游 decision 时要展开保留其他字段
  // （PreStepDecision = {kind:'reject'} | {kind:'enter', messages, startsRequestSeries?}）。
  ctx.on('agent/pre-step', async (payload, next) => {
    let pendingPrime = null
    try {
      const state = stateOf(payload?.agent, config)
      if (state) {
        restoreMode(payload?.agent, state)
        const text = lastUserText(payload?.messages)
        if (text) {
          // 自然语言切档**只认精确匹配**（整句就是档位词）。
          // 宽松正则会因 FastAPI / fastboot / "TypeScript strict" 误判成快速档，
          // 而快速档经 censor 直接关掉来源打回——那是静默失效，必须避免。
          const detected = detectModeExact(text)
          if (detected) {
            state.mode = detected
            persistModeOf(payload?.agent, state)
          }
          if (text !== state.userText) beginTurn(state, text)
        }
        pendingPrime = ensurePrime(payload?.agent, state)
      }
    } catch (error) {
      log(ctx, 'warn', `pre-step 处理失败：${String(error)}`)
    }

    const decision = await next()
    if (!pendingPrime) return decision
    if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) {
      // 这一步没被接纳（reject 等），上下文没送出去 → 必须回滚 primed，
      // 否则该会话会**永久**失去档位与记忆库（下次不再尝试补注入）。
      try {
        const state = stateOf(payload?.agent, config)
        if (state) state.primed = false
      } catch {
        /* 回滚失败不影响 waterfall 结果 */
      }
      return decision
    }
    if (config.diagnostics !== false) {
      reportLoad({
        event: 'context-injected',
        phase: 'prime-via-step',
        messageId: pendingPrime.id,
        chars: messageChars(pendingPrime),
      })
    }
    return { ...decision, messages: [...decision.messages, pendingPrime] }
  })

  // 累积助手回复（用于来源校验）。
  // 每个 assistant attempt 的 `start` 帧会**清空缓冲**：只保留最近一次尝试的文本，
  // 避免"中途步骤里出现过 URL"污染最终判定，也让打回重做后的判定基于新回复而非拼接结果。
  ctx.on('agent/assistant-stream', (payload) => {
    try {
      const frame = payload?.frame
      const state = stateOf(payload?.agent, config)
      if (!state) return
      if (frame?.type === 'start') {
        state.assistantText = ''
        return
      }
      if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string') {
        state.assistantText += frame.chunk.text
      }
    } catch {
      /* 观测失败不影响流式输出 */
    }
  })

  // 轮次结束时：来源校验（打回） + 每 N 轮重申 + 记忆同步
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    try {
      const state = stateOf(agent, config)
      state.lastTurn = typeof turn === 'number' ? turn : state.lastTurn

      const verdict = evaluateCensor({
        userText: state.userText,
        assistantText: state.assistantText,
        mode: state.mode,
        censor: config.censor,
        retries: state.retries,
        archivedCount: state.archivedThisTurn,
        saidNotFound: state.saidNotFound,
        objectiveWords: config.objectiveWords,
        sourceIndicators: config.sourceIndicators,
      })

      if (verdict.action === 'retry') {
        // censorAction='log'：只记账不打扰（trae-tamer 式"自检优先"的选项），
        // 默认 'steer' 保持强制重做。
        if (config.censorAction === 'log') {
          if (config.diagnostics !== false) {
            reportLoad({ event: 'censor-warn', turn: state.lastTurn, code: verdict.code, reason: verdict.reason })
          }
          log(ctx, 'info', `来源校验告警（未打扰）：${verdict.reason}`)
        } else {
          const correction = makeContextMessage(createUserMessage, correctionText(state.mode))
          if (correction) {
            state.retries += 1
            log(ctx, 'info', `来源校验打回第 ${state.retries} 次：${verdict.reason}`)
            if (config.diagnostics !== false) {
              reportLoad({ event: 'censor-retry', turn: state.lastTurn, retries: state.retries, code: verdict.code, reason: verdict.reason })
            }
            agent?.steer?.(correction)
          } else {
            log(ctx, 'warn', `检出「${verdict.reason}」，但缺少 createUserMessage，无法打回`)
          }
        }
      } else if (verdict.action === 'giveup') {
        if (config.diagnostics !== false) {
          reportLoad({ event: 'censor-giveup', turn: state.lastTurn, code: verdict.code, reason: verdict.reason })
        }
        log(ctx, 'warn', verdict.reason)
      } else if (verdict.code !== 'non-objective' && verdict.code !== 'censor-off' && verdict.code !== 'fast-mode') {
        // 本轮确实涉及客观信息、且判定合规 —— 记账说明"为什么放过"，
        // 让"合法例外"与"漏判"在日志里分得开（可观测性）。
        if (config.diagnostics !== false) {
          reportLoad({ event: 'censor-skip', turn: state.lastTurn, code: verdict.code, reason: verdict.reason })
        }
      }

      if (config.reinjectEvery > 0 && state.lastTurn > 0
        && state.lastTurn % config.reinjectEvery === 0
        && state.lastReinjectTurn !== state.lastTurn) {
        state.lastReinjectTurn = state.lastTurn
        injectContext(agent, reinforceText(state.mode), 'reinforce')
        log(ctx, 'info', `第 ${state.lastTurn} 轮：已注入协议重申`)
      }

      syncMemory(agent, state)

      // 状态快照（原子写，给人和未来的徽标一个稳定读取面；加载日志是追加式的）
      if (config.stateSnapshot !== false) {
        writeSnapshot({
          mode: state.mode,
          cwd: cwdOf(agent),
          turn: state.lastTurn,
          lastCensor: { action: verdict.action, code: verdict.code },
          lastFinalize: state.lastFinalize,
          pendingWarning: state.pendingWarning,
        })
      }
    } catch (error) {
      log(ctx, 'warn', `轮次收尾处理失败：${String(error)}`)
    }
  })

  // ── 4. 工具观测 + 可选执行门禁（默认 off，只观察） ───────────────

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const state = stateOf(exec?.agent, config)
      const toolName = String(exec?.name ?? '')
      if (state) {
        if (config.sourceTools.includes(toolName)) state.sourceToolUsed = true

        if (config.execGate === 'ask'
          && config.mutatingTools.includes(toolName)
          && !state.sourceToolUsed
          && state.userText
          && involvesObjective(state.userText, config)) {
          return {
            kind: 'ask',
            reason: `dsh-tamer: 本轮涉及客观信息（${toolName} 即将执行），但尚未见任何来源检索工具调用。`,
            displayReason: {
              en: 'This turn looks like it needs verifiable sources, but no source lookup ran yet. Run the action anyway?',
              zh: '本轮涉及客观信息，但还没有检索过来源。仍然执行该操作吗？',
            },
          }
        }
      }
    } catch (error) {
      log(ctx, 'warn', `pre-execute 处理失败：${String(error)}`)
    }
    return next()
  })

  // ── 5. 留痕归档工具 ──────────────────────────────────────────────
  //
  // 刻意**不用**宿主的 defineTool。defineTool 来自裸导入 `@deepseek-ai/dsh-tools`，
  // 且它在加载期就会跑参数编译——一旦该说明符解析失败，整个插件在加载期失败，
  // 而 DSH 启动是全有全无的。这里直接写它的**等价产物**（原始 ToolDefinition，
  // parameters 就是 JSON Schema），并已用官方校验器离线验过：
  // assertSupportedJsonSchema 通过、required/type 行为正确（见 README 证据表）。
  // 字段与 defineTool 的输出逐项对齐（对象根不声明 additionalProperties，保持开放）。
  const archiveTool = {
    name: 'tamer_archive',
    description: '把一条信息来源归档到留痕仓库（登记 保存时间/来源/链接/主题/用途），返回登记文件的绝对路径。涉及客观信息的任务结束时使用。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目/任务名，决定留痕仓库下的子文件夹' },
        subject: { type: 'string', description: '信息主题，例如「STM32F103 引脚定义」' },
        source: { type: 'string', description: '来源名称，例如「ST 官方数据手册」' },
        link: { type: 'string', description: '来源链接 URL' },
        note: { type: 'string', description: '用途说明' },
        save_file: { type: 'string', description: '可选：需要一并复制进仓库的本地原文文件绝对路径' },
      },
      required: ['project'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('tamer_archive: 调用已取消')
      const result = archiveSource({
        root: archiveRootFor(exec?.agent),
        project: args.project,
        subject: args.subject,
        source: args.source,
        link: args.link,
        note: args.note,
        saveFile: args.save_file,
        copyFiles: config.archiveCopyFiles,
      })
      // 归档成功即视为本轮的"来源合规凭据"：evaluateCensor / evaluateFinalize 都看这个计数
      const st = stateOf(exec?.agent, config)
      if (st) st.archivedThisTurn += 1
      return result.path
    },
  }

  // 开工自检工具（移植自 trae-tamer 的 tamer_preflight）：
  // 由**模型自己语义声明**本轮是否涉及客观信息，而不是让客户端正则去猜每句话。
  const preflightTool = {
    name: 'tamer_preflight',
    description: '开工自检：声明本轮是否涉及客观信息（硬件/芯片/标准规范/政策法规/行情价格/论文结论等），涉及则返回来源工作流指引。动手检索前调用；不涉及就不必调用。',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'boolean', description: '本轮是否涉及客观信息（由你语义判断，不靠关键词）' },
        task: { type: 'string', description: '一句话说明本轮任务' },
      },
      required: ['objective'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const st = stateOf(exec?.agent, config)
      const objective = args?.objective === true
      if (st) st.declaredObjective = objective
      const { guidance } = runPreflight({ objective, task: args?.task ?? '', mode: st?.mode ?? config.mode })
      // 开工声明记账：没有它就无法统计"模型是否守规矩先声明"（v0.2.0 只有 finalize 有日志）
      if (config.diagnostics !== false) {
        reportLoad({
          event: 'preflight',
          objective,
          task: String(args?.task ?? '').slice(0, 80),
          mode: st?.mode ?? config.mode,
          turn: st?.lastTurn ?? 0,
        })
      }
      return guidance
    },
  }

  // 交付自检工具（移植自 trae-tamer 的 tamer_finalize）：
  // 在**发出最终回复之前**自检，只多一步工具调用，不重跑整轮、不静默改写。
  const finalizeTool = {
    name: 'tamer_finalize',
    description: '交付自检：把即将发出的回复全文交上来，校验来源合规并返回 pass/skip/warn。warn 时必须补齐来源或写明「未找到可靠来源」后重新调用，不许带 warn 收尾。',
    parameters: {
      type: 'object',
      properties: {
        reply_text: { type: 'string', description: '即将发出的回复全文（用于判定是否已给出来源）' },
        said_not_found: { type: 'boolean', description: '是否已在回复中写明「未找到可靠来源」' },
      },
      required: ['reply_text'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const st = stateOf(exec?.agent, config)
      if (st && args?.said_not_found === true) st.saidNotFound = true
      const result = evaluateFinalize({
        // 三态直传：undefined = 本轮尚未 preflight（v0.3.0 修掉的"假通过"关键）
        declaredObjective: st?.declaredObjective,
        archivedCount: st?.archivedThisTurn ?? 0,
        replyText: String(args?.reply_text ?? ''),
        saidNotFound: args?.said_not_found === true || st?.saidNotFound === true,
        mode: st?.mode ?? config.mode,
      })
      if (st) {
        st.lastFinalize = { status: result.status, code: result.code }
        st.pendingWarning = result.status === 'warn' ? `${result.code}: ${result.reason}` : null
      }
      if (config.diagnostics !== false) {
        reportLoad({ event: 'finalize', status: result.status, code: result.code, turn: st?.lastTurn ?? 0 })
      }
      if (config.stateSnapshot !== false && st) {
        writeSnapshot({
          mode: st.mode,
          cwd: cwdOf(exec?.agent),
          turn: st.lastTurn,
          lastFinalize: st.lastFinalize,
          pendingWarning: st.pendingWarning,
        })
      }
      return `【${result.status}】${result.reason}${result.action ? `\n下一步：${result.action}` : ''}`
    },
  }

  ctx.inject(['tools'], (scope) => {
    scope.tools.register(archiveTool)
    scope.tools.register(preflightTool)
    scope.tools.register(finalizeTool)
  })

  // 装配完成的自检记录：与 index.js 的 apply 行配对，证明整个装配真的跑完了
  if (config.diagnostics !== false) {
    reportLoad({
      event: 'wired',
      plugin: 'dsh-tamer',
      section: 'tamer:protocol',
      order: config.protocolOrder,
      command: 'tamer',
      tool: archiveTool.name,
      tools: [archiveTool.name, preflightTool.name, finalizeTool.name].join(','),
      mode: config.mode,
      censor: config.censor,
      censorAction: config.censorAction,
      execGate: config.execGate,
      reinjectEvery: config.reinjectEvery,
      // 消息工厂来源：host = 宿主 API；builtin = 内置等价实现（功能不降级）
      messageFactory: messages.origin,
      processCwd: process.cwd(),
      // 记录**配置值**而非加载期推算的路径：真正的路径按会话 cwd 在运行时解析，
      // 加载期的 process.cwd() 是 profile 目录，写进来会误导排查（20:49 的日志就踩过）。
      memoryFileConfigured: config.memoryFile || '(auto: <会话 cwd>/记忆库/约定.md)',
      archiveRootConfigured: config.archiveRoot || '(auto: <会话 cwd>/留痕仓库)',
    })
  }

  // ── 释放 ─────────────────────────────────────────────────────────
  return () => {
    for (const disposer of disposers) {
      try {
        disposer()
      } catch {
        /* 释放失败不应阻断卸载 */
      }
    }
  }
}

/** 记忆条目哈希（用于变更检测）。 */
export function hashEntries(entries) {
  return Array.isArray(entries) ? entries.join('\u0000') : ''
}

/** 供档位切换回执使用。 */
function modeHintText(mode) {
  const hints = {
    fast: '直接答，不强求方案与来源明细',
    standard: '澄清 + 1~2 方案 + 关键来源',
    strict: '完整可行性 → ≥2 方案 → 来源链接 + 末尾来源集合 → 迭代',
  }
  return hints[normalizeMode(mode)] ?? hints.standard
}

/** execGate 用的客观信息判定（延迟引入以避免循环依赖）。 */
function involvesObjective(text, config) {
  const words = config.objectiveWords ?? null
  if (words) {
    const low = String(text).toLowerCase()
    return words.some((w) => low.includes(String(w).toLowerCase()))
  }
  // 与 censor 内置表同源
  return evaluateCensor({ userText: text, assistantText: '', mode: 'standard', censor: 'warn', retries: 0 }).action !== 'none'
}
