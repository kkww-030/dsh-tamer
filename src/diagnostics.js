/**
 * dsh-tamer · 加载自检（诊断日志）
 *
 * ## 为什么需要它
 *
 * DSH 启动是**全有全无**的，而"插件究竟有没有被加载"从外部很难判断：
 * 工具表、提示词、界面都只是间接信号，而插件行还可能是 failed / pending / active。
 * 于是这里在加载时向 `<DSH_HOME>/dsh-tamer-load.log` **追加一行事实**：
 * 时间、插件版本、profile、pid，以及哪些可选宿主 API 解析成功。
 *
 * 有了它，「插件加载了没有、缺了哪个 API」一眼可查——这是本轮排查里最缺的东西。
 *
 * ## 边界
 *
 * - 任何失败都被吞掉：诊断绝不能影响插件加载。
 * - 可用 `config.diagnostics: false` 关闭。
 * - 日志只追加、不轮转；每行 ~200 字节，一次启动两行。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Harness 数据根：显式 `DSH_HOME` 优先，其次 `~/.dsh`（与 dsh-home-paths 的规则一致）。 */
export function resolveDshHome(env = process.env) {
  const explicit = env?.DSH_HOME
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  return join(homedir(), '.dsh')
}

/** 自检日志的绝对路径。 */
export function loadLogPath(env = process.env) {
  return join(resolveDshHome(env), 'dsh-tamer-load.log')
}

/**
 * 追加一条自检记录。
 * @param {object} entry - 任意可 JSON 序列化的事实
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null} 写入的文件路径；失败返回 null
 */
export function reportLoad(entry, env = process.env) {
  try {
    const path = loadLogPath(env)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8')
    return path
  } catch {
    return null
  }
}
