/**
 * dsh-tamer · 用户消息构造（内置兜底）
 *
 * ## 为什么插件要自己造消息
 *
 * 注入上下文、每 N 轮重申、"来源缺失打回"都必须构造一条 user 消息，
 * 官方做法是从 `@deepseek-ai/dsh-llm` 取 `createUserMessage`。但本机实测
 * （`<DSH_HOME>/dsh-tamer-load.log`，2026-10-07 20:49 那次重启）：
 *
 *     {"event":"apply", "apis":{"createUserMessage":false}}
 *     {"event":"wired", "degraded":true}
 *
 * 即 **`@deepseek-ai/dsh-llm` 在 profile 装进来的插件里解析不到**——
 * 于是插件的核心功能（打回）被降级掉了。既然官方实现本身就是
 * `deepFreeze(structuredClone({ ...input, id: randomUUID() }))`（见
 * `packages/llm/llm/src/message.ts:221-228`，`createUserMessage` 只是加了 `role: 'user'`），
 * 这里就照做一份等价实现：**优先用宿主给的，拿不到就用内置的**，功能不再降级。
 *
 * 消息来源标记 `{ kind: 'dsh-tamer' }` 是合法的：会话格式只拒绝已废弃的
 * `{ kind: 'plugin', plugin }` 包装（见 docs/cookbook/adding-a-tool.md）。
 */
import { randomUUID } from 'node:crypto'

/** 与官方 `deepFreeze` 等价：递归冻结，已冻结的跳过。 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * 构造一条带稳定身份、冻结的 user 消息（官方 `createUserMessage` 的等价物）。
 * @param {{content: unknown[], source: {kind: string}}} input
 */
export function createUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/**
 * 选一个消息工厂：宿主提供的优先，缺失时用内置的。
 * @param {{createUserMessage?: Function}} api
 * @returns {{factory: Function, origin: 'host'|'builtin'}}
 */
export function resolveMessageFactory(api) {
  if (typeof api?.createUserMessage === 'function') {
    return { factory: api.createUserMessage, origin: 'host' }
  }
  return { factory: createUserMessage, origin: 'builtin' }
}
