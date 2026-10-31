/**
 * dsh-tamer · 按工作区持久化 + 状态快照
 *
 * 借鉴 trae-tamer/src/state.js 与 src/heartbeat.js：
 *   · 状态按**工作区**存到 `<DSH_HOME>/dsh-tamer/workspaces/<目录名>_<sha1前10>.json`，
 *     不进用户项目目录（不在项目里留痕迹）；文件名带哈希防同名目录碰撞。
 *   · 快照文件 `<DSH_HOME>/dsh-tamer-state.json` 用**原子写**（tmp + rename），
 *     给人和未来的徽标一个稳定的读取面（不会读到半截 JSON）。
 *
 * 这里只持久化"跨会话有意义"的东西：档位。其余（本轮声明、计数）每轮重置，不落盘。
 * 所有 IO 一律吞错：持久化失败最多丢一次档位记忆，绝不能影响对话。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from './diagnostics.js'
import { normalizeMode } from './modes.js'

/** 原子写：先写 `.tmp` 再 rename，读者永远只看到完整 JSON。 */
function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, value, 'utf8')
  renameSync(tmp, path)
}

/** 工作区状态目录。 */
export function workspacesDir(env = process.env) {
  return join(resolveDshHome(env), 'dsh-tamer', 'workspaces')
}

/** 项目路径 → 状态文件名（可读目录名 + sha1 前 10 位防碰撞）。 */
export function workspaceKey(cwd) {
  const abs = String(cwd ?? '')
  const hash = createHash('sha1').update(abs, 'utf8').digest('hex').slice(0, 10)
  const base = abs.split(/[\\/]/u).filter(Boolean).pop() || 'root'
  const safe = base.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/gu, '_').slice(0, 40) || 'root'
  return `${safe}_${hash}.json`
}

export function workspaceStatePath(cwd, env = process.env) {
  return join(workspacesDir(env), workspaceKey(cwd))
}

/** 读工作区状态；不存在/损坏一律返回 null（回落默认）。 */
export function loadWorkspaceState(cwd, env = process.env) {
  try {
    const path = workspaceStatePath(cwd, env)
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  } catch {
    return null
  }
}

/** 合并补丁并落盘；返回最新状态（失败返回 null）。 */
export function saveWorkspaceState(cwd, patch, env = process.env) {
  try {
    const previous = loadWorkspaceState(cwd, env) ?? {}
    const next = { version: 1, ...previous, ...patch, updatedAt: new Date().toISOString() }
    writeAtomic(workspaceStatePath(cwd, env), `${JSON.stringify(next, null, 2)}\n`)
    return next
  } catch {
    return null
  }
}

/** 该工作区上次使用的档位；没有或非法返回 null。 */
export function savedMode(cwd, env = process.env) {
  const state = loadWorkspaceState(cwd, env)
  if (!state || typeof state.mode !== 'string') return null
  return normalizeMode(state.mode, null)
}

/** 状态快照文件路径（给人 / 给未来的徽标读）。 */
export function snapshotPath(env = process.env) {
  return join(resolveDshHome(env), 'dsh-tamer-state.json')
}

/**
 * 写状态快照（原子）。
 * 多窗口时最后写入者获胜——这是"插件活着/当前档位"的粗粒度信号，与 trae-tamer 的取舍一致。
 */
export function writeSnapshot(snapshot, env = process.env) {
  try {
    writeAtomic(snapshotPath(env), `${JSON.stringify({ ts: Date.now(), ...snapshot })}\n`)
    return snapshotPath(env)
  } catch {
    return null
  }
}

/** 读状态快照（诊断用）。 */
export function readSnapshot(env = process.env) {
  try {
    return JSON.parse(readFileSync(snapshotPath(env), 'utf8'))
  } catch {
    return null
  }
}
