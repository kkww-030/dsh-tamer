/**
 * dsh-tamer · 外部记忆库
 *
 * 读写逻辑移植自 local-model/tamer.py:49-80，文件格式与 记忆库/约定.md 完全兼容：
 * 只把 `- ` 开头的行当作长期约定，`#` 注释与说明行一律忽略。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** 从记忆库文件全文里提取约定行（数组，保持原顺序）。 */
export function parseMemory(text) {
  if (typeof text !== 'string' || !text.trim()) return []
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
}

/** 记忆库文件是否存在。 */
export function memoryExists(path) {
  return typeof path === 'string' && path.length > 0 && existsSync(path)
}

/** 读取记忆库，返回约定行数组；文件不存在返回空数组。 */
export function readMemory(path) {
  if (!memoryExists(path)) return []
  try {
    return parseMemory(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/** 追加一条约定。返回是否写入成功。 */
export function appendMemory(path, text) {
  const value = String(text ?? '').trim()
  if (!value) return false
  const line = value.startsWith('- ') ? value : `- ${value}`
  const existing = memoryExists(path) ? readFileSync(path, 'utf8') : '# AI驯服工具 · 外部记忆库（长期约定）\n'
  const separator = existing.endsWith('\n') ? '' : '\n'
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${existing}${separator}${line}\n`, 'utf8')
  return true
}

/** 删除包含关键词的约定行，返回删除条数。 */
export function removeMemory(path, keyword) {
  const needle = String(keyword ?? '').trim()
  if (!needle || !memoryExists(path)) return 0
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u)
  const kept = lines.filter((line) => !(line.trim().startsWith('- ') && line.includes(needle)))
  const removed = lines.length - kept.length
  if (removed > 0) writeFileSync(path, kept.join('\n'), 'utf8')
  return removed
}

/**
 * 解析记忆库路径：显式配置优先；否则在会话工作目录下找 `记忆库/约定.md`，
 * 再逐级向上找（最多 4 层），最后回落到 cwd 下的默认位置。
 * @param {object} input
 * @param {string} input.configured - config.memoryFile
 * @param {string} input.cwd - 会话工作目录
 * @returns {string}
 */
export function resolveMemoryPath({ configured = '', cwd = process.cwd() } = {}) {
  if (configured) return isAbsolute(configured) ? configured : resolve(cwd, configured)
  let dir = resolve(cwd)
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(dir, '记忆库', '约定.md')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return join(resolve(cwd), '记忆库', '约定.md')
}

/** 生成注入进上下文的记忆块文本；无约定时返回空串。 */
export function memoryBlock(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  return `## 外部记忆库（主人长期约定，务必遵守）\n${entries.join('\n')}`
}
