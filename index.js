/**
 * dsh-tamer · 宿主半入口（DSH 加载的就是本文件）
 *
 * ## 为什么这里**一个静态导入都没有**
 *
 * 本插件原先在模块顶层写 `import { createUserMessage } from '@deepseek-ai/dsh-llm'`，
 * 与已装社区插件 dsh-at-file 的构建产物同款写法（它的 lib/index.js:15898 就是这么写的）。
 * 但静态导入在**模块被加载时**就要解析，而 DSH 启动是**全有全无**的：
 * 一旦某个裸说明符在本机的运行时解析里不可用，整行插件会在加载期失败。
 * 本机无法离线验证 `@deepseek-ai/dsh-tools` 是否在拦截层里（`@deepseek-ai/dsh-llm`
 * 有 dsh-at-file 作为先例，`dsh-tools` 没有），所以这里改为：
 *
 *   1. **运行时动态导入**，各自 try/catch；
 *   2. 拿不到 `createUserMessage` → 只是少掉"会话上下文注入 / 每 N 轮重申 / 来源打回"，
 *      协议注入、档位命令、留痕工具照常工作，并在日志里明确告警；
 *   3. 留痕工具**完全不依赖任何导入**——wiring.js 里直接写原始 ToolDefinition
 *      （已用官方 json-schema 校验器离线验过 schema 合法）。
 *
 * 结果：无论解析成功与否，插件都能加载；最坏情况只是功能降级，而不是把 Harness 拖死。
 */
import { applyTamer } from './src/wiring.js'
import { reportLoad } from './src/diagnostics.js'

/** Cordis 插件名，必须与 cordis.patch.yml 里的 `name` 一致。 */
export const name = 'dsh-tamer'

/** 与 package.json 的 version 保持一致（scripts/check.mjs 会校验）。 */
export const VERSION = '0.3.0'

/**
 * 必需服务：只有系统提示词注册表是硬依赖（协议要挂进去）。
 * 其余能力（commands / tools / agents 事件）通过 ctx.inject / ctx.on 按需挂载，
 * 缺失时插件照常加载，只是少一项能力——避免插件因可选服务缺席而整体挂起。
 */
export const inject = ['systemPrompt']

/**
 * 尝试加载一个可选的宿主 API。**失败只记录，绝不抛出**。
 * 返回 `{ value, error }`：`error` 会写进加载自检日志——这是排查"为什么降级"的唯一线索
 * （桌面版没有控制台日志，只靠 ctx.logger.warn 是查不到的，20:49 那次就吃了这个亏）。
 * @param {string} specifier
 * @param {string} exportName
 * @returns {Promise<{value: Function|null, error: string|null}>}
 */
async function optionalApi(specifier, exportName) {
  try {
    const mod = await import(specifier)
    const value = mod?.[exportName]
    if (typeof value === 'function') return { value, error: null }
    return { value: null, error: `${specifier} 未导出 ${exportName}` }
  } catch (error) {
    return { value: null, error: `${specifier}: ${String(error?.message ?? error)}` }
  }
}

/**
 * @param {any} ctx - Cordis 上下文
 * @param {unknown} config - 插件行 `config:`（见 cordis.patch.yml）
 * @returns {Promise<() => void>} 释放函数（Plugin.Function 的返回类型是 any，async 合法）
 */
export async function apply(ctx, config) {
  const host = await optionalApi('@deepseek-ai/dsh-llm', 'createUserMessage')
  if (host.error) {
    // 有内置等价实现兜底，这里只是告知，不再是"功能降级"
    ctx?.logger?.info?.(`dsh-tamer: 未采用宿主 createUserMessage（${host.error}），使用内置实现`)
  }

  // 加载自检：本行是"插件到底有没有被加载、为什么降级"最直接的证据（见 src/diagnostics.js）
  if (config?.diagnostics !== false) {
    reportLoad({
      event: 'apply',
      plugin: name,
      version: VERSION,
      profile: process.env.DSH_PROFILE ?? null,
      pid: process.pid,
      apis: { createUserMessage: host.value ? 'host' : 'builtin' },
      ...(host.error ? { apiErrors: { createUserMessage: host.error } } : {}),
    })
  }

  return applyTamer(ctx, config, { createUserMessage: host.value })
}
