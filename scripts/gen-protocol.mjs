#!/usr/bin/env node
/**
 * dsh-tamer · 协议文本生成器（单一事实源）
 *
 * 读 `../core/协议注入模板.txt`，生成 `../src/protocol.js`。
 * 这样「协议本体」只有一处可改：core/协议注入模板.txt，
 * 不再需要像 README.md:69 描述的那样手工同步三份副本。
 *
 * 用法：node scripts/gen-protocol.mjs [--check]
 *   --check  只校验生成结果是否为最新（CI/提交前用），不写文件
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
// 独立分享副本：优先用自带的 protocol/协议注入模板.txt，
// 这样无论放在工具集仓库里、还是被单独压缩分发，生成物的 PROTOCOL_SOURCE 都一致，
// 收件人跑 `--check` 也不会因为布局不同而报漂移。
const sourceCandidates = [
  resolve(root, 'protocol', '协议注入模板.txt'),
  resolve(root, '..', 'core', '协议注入模板.txt'),
]
const sourcePath = sourceCandidates.find((candidate) => existsSync(candidate)) ?? sourceCandidates[0]
const targetPath = join(root, 'src', 'protocol.js')

const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/gu, '\n').trimEnd()
const sha256 = createHash('sha256').update(source, 'utf8').digest('hex')
const relSource = relative(root, sourcePath).replace(/\\/gu, '/')

const banner = `/**
 * dsh-tamer · 协议文本（自动生成，请勿手改）
 *
 * 单一事实源：${relSource}
 * 内容 SHA-256：${sha256}
 * 重新生成：node scripts/gen-protocol.mjs
 */
`

const body = `${banner}
/** 协议正文（与 core/协议注入模板.txt 逐字节一致，仅去掉结尾换行）。 */
export const PROTOCOL_TEXT = ${JSON.stringify(source)}

/** 生成时所依据的源文件（相对插件目录）与内容哈希，用于漂移检测。 */
export const PROTOCOL_SOURCE = ${JSON.stringify(relSource)}
export const PROTOCOL_SHA256 = ${JSON.stringify(sha256)}
`

const check = process.argv.includes('--check')

if (check) {
  let current = ''
  try {
    // 容忍检出时的换行转换（见 .gitattributes）：只比较内容，不比较 CRLF/LF
    current = readFileSync(targetPath, 'utf8').replace(/\r\n/gu, '\n')
  } catch {
    console.error('✗ 缺少 src/protocol.js，请运行：node scripts/gen-protocol.mjs')
    process.exit(1)
  }
  if (current !== body) {
    console.error('✗ src/protocol.js 已过期（协议本体改动后未重新生成）')
    process.exit(1)
  }
  console.log(`✓ src/protocol.js 与 ${relSource} 一致（sha256 ${sha256.slice(0, 12)}…）`)
} else {
  writeFileSync(targetPath, body, 'utf8')
  console.log(`✓ 已生成 src/protocol.js（来自 ${relSource}，sha256 ${sha256.slice(0, 12)}…）`)
}
