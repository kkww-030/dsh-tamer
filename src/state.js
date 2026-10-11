/**
 * dsh-tamer · 每个 Agent 的会话状态
 *
 * 状态挂在 WeakMap 上（键是 Agent 对象），agent 被回收时状态自然消失，
 * 不会像 saddle.py 的类变量那样跨进程残留、也不会在长跑进程里泄漏。
 */

/** @type {WeakMap<object, object>} */
const store = new WeakMap()

function freshState(config) {
  return {
    mode: config.mode,
    /** 最近一次见过的轮次号（来自 agent/turn-stopping payload） */
    lastTurn: 0,
    lastReinjectTurn: -1,
    /** 本轮已打回次数 */
    retries: 0,
    /** 本轮用户消息（用于客观信息判定） */
    userText: '',
    /** 本轮助手回复累积文本 */
    assistantText: '',
    /** 本轮是否调用过“查来源”的工具 */
    sourceToolUsed: false,
    /** 已注入的记忆块哈希，用于变更时重新注入 */
    memoryHash: '',
    /** 是否已完成首次上下文注入（记忆 + 档位） */
    primed: false,
  }
}

/** 取（必要时创建）某个 agent 的状态。 */
export function stateOf(agent, config) {
  if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return freshState(config)
  let state = store.get(agent)
  if (!state) {
    state = freshState(config)
    store.set(agent, state)
  }
  return state
}

/** 读取已有状态，没有则返回 undefined（不会创建）。 */
export function peekState(agent) {
  if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return undefined
  return store.get(agent)
}

/** 新一轮开始：清空轮内累积量，但保留档位与记忆哈希。 */
export function beginTurn(state, userText) {
  state.retries = 0
  state.userText = userText ?? ''
  state.assistantText = ''
  state.sourceToolUsed = false
}
