/**
 * dsh-tamer · 留痕归档
 *
 * 落盘格式与 tracing/archive.py:15-59 完全一致（同一套字段与文件名规则），
 * 这样插件归档出来的登记文件与既有 Python 归档器产出的文件可以互相对照、统一检索。
 */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

/** 把 `project` 归一化成安全的单段目录名，避免穿越出留痕仓库。 */
export function sanitizeSegment(value, fallback = '未命名') {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  const cleaned = raw
    // 按路径分隔符切段，丢弃空段与 `.` / `..`，再用 `_` 拼回单段：
    // 穿越意图由此直接消失，而合法的下划线、中文、空格原样保留
    // （早期实现用正则把 `..` 换成 `_` 再削前导 `[.\s_]`，会误伤 `_插件自检` 这种合法名字）。
    .split(/[\\/]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('_')
    .replace(/[:*?"<>|]/gu, '_')
    .replace(/[.\s]+$/u, '')
  return cleaned || fallback
}

/** 时间戳：文件名用 `YYYYMMDD_HHMMSS`（与 archive.py:49 一致）。 */
export function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(
    date.getMinutes(),
  )}${p(date.getSeconds())}`
}

/** 登记文件正文（字段顺序与 archive.py 一致，便于 diff）。 */
export function buildMark({ project, subject, source, link, note, saveFileName, now = new Date() }) {
  const p = (n) => String(n).padStart(2, '0')
  const lines = [
    '# 信息来源留痕',
    '',
    `- 保存时间: ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(
      now.getMinutes(),
    )}:${p(now.getSeconds())}`,
    `- 项目/任务: ${project}`,
  ]
  if (subject) lines.push(`- 主题: ${subject}`)
  if (source) lines.push(`- 来源名称: ${source}`)
  if (link) lines.push(`- 来源链接: ${link}`)
  if (note) lines.push(`- 用途: ${note}`)
  if (saveFileName) lines.push(`- 存档原文: ${saveFileName}`)
  lines.push('', '（本记录由 dsh-tamer 插件自动生成，用于结论追溯。）')
  return `${lines.join('\n')}\n`
}

/** 解析留痕仓库根目录：显式配置优先，否则用会话工作目录下的 `留痕仓库/`。 */
export function resolveArchiveRoot({ configured = '', cwd = process.cwd() } = {}) {
  if (configured) return isAbsolute(configured) ? configured : resolve(cwd, configured)
  return join(resolve(cwd), '留痕仓库')
}

/**
 * 归档一条来源。
 * @param {object} input
 * @param {string} input.root - 留痕仓库根目录
 * @param {string} input.project - 项目/任务名（决定子文件夹）
 * @param {string} [input.subject] @param {string} [input.source]
 * @param {string} [input.link] @param {string} [input.note]
 * @param {string} [input.saveFile] - 需要一并复制进仓库的原文文件
 * @param {boolean} [input.copyFiles]
 * @param {Date} [input.now]
 * @returns {{path: string, dir: string, bytes: number, savedFile: string|null}}
 */
export function archiveSource(input) {
  const { root, project, subject = '', source = '', link = '', note = '', saveFile = '', copyFiles = true } = input
  const now = input.now instanceof Date ? input.now : new Date()
  const dir = join(resolve(root), sanitizeSegment(project))

  let savedFile = null
  let saveFileName = ''
  if (copyFiles && saveFile && existsSync(saveFile)) {
    saveFileName = basename(saveFile)
    savedFile = saveFileName
  }

  const body = buildMark({ project, subject, source, link, note, saveFileName, now })
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `来源登记_${stamp(now)}.md`)
  writeFileSync(path, body, 'utf8')

  if (savedFile) {
    copyFileSync(saveFile, join(dir, saveFileName))
  }

  return { path, dir, bytes: Buffer.byteLength(body, 'utf8'), savedFile, totalBytes: statSync(path).size }
}
