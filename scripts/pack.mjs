#!/usr/bin/env node
/**
 * dsh-tamer · 打包（构建产物）
 *
 * 本插件是"零构建"设计——`index.js` / `client.js` / `src/*` 就是运行产物本身，
 * 没有编译步骤。但**分发**仍需要一个产物：把包打成 tarball，才能
 * `dsh plugin add <tarball>` 或走插件市场的"tarball 地址"安装。
 *
 * 本脚本一次跑完，任何一步失败即非零退出：
 *   1) 协议漂移检查 + 四合一自检 + 全部单元测试（坏东西不许打进去）
 *   2) npm pack 出 tarball 到 dist/
 *   3) 打印 sha256 与包内文件清单，并核对必需文件都在
 *   4) 解包到 dist/unpacked/，用纯 Node **真正 import 一次入口**，
 *      证明产物自包含（少了 src/ 之类会立刻失败）
 *
 * 用法：node scripts/pack.mjs
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const dist = join(root, 'dist')
const unpacked = join(dist, 'unpacked')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.status !== 0) {
    console.error(`\n✗ 失败：${command} ${args.join(' ')}`)
    if (result.error) console.error(String(result.error))
    if (result.stdout) console.error(result.stdout.trim())
    if (result.stderr) console.error(result.stderr.trim())
    process.exit(result.status ?? 1)
  }
  return result
}

/**
 * Windows 上的 npm 是 npm.cmd，而 Node 18+ 出于安全考虑**不允许不带 shell 直接 spawn .cmd**
 * （会抛 EINVAL）。所以优先用 node 直接跑 npm 的 CLI 脚本，找不到再退回 shell 方式。
 */
function npmRunner() {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(cli)) return { command: process.execPath, prefix: [cli] }
  console.warn('      ! 未找到 npm-cli.js，回退到 shell 方式调用 npm')
  return { command: 'npm', prefix: [], shell: true }
}
const NPM = npmRunner()
const runNpm = (args) => run(NPM.command, [...NPM.prefix, ...args], NPM.shell ? { shell: true } : {})

/* 1. 先验证，再打包 */
console.log('[1/4] 验证（协议漂移 / 自检 / 单元测试）')
run(process.execPath, [join(here, 'gen-protocol.mjs'), '--check'])
run(process.execPath, [join(here, 'check.mjs')])
const tests = run(process.execPath, ['--test', 'tests/*.test.mjs'])
const passLine = tests.stdout.split('\n').find((line) => line.includes('pass '))?.trim() ?? ''
console.log(`      ${passLine}`)

/* 2. 打包 */
console.log('[2/4] 打包')
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
const packed = runNpm(['pack', '--pack-destination', dist, '--silent'])
const tarballName = packed.stdout.trim().split('\n').pop().trim()
const tarball = join(dist, tarballName)
if (!existsSync(tarball)) {
  console.error(`✗ 未生成 tarball：${tarball}`)
  process.exit(1)
}

/* 3. 校验产物 */
console.log('[3/4] 校验产物')
const bytes = readFileSync(tarball)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const listing = run('tar', ['-tzf', tarball]).stdout
  .split('\n').map((line) => line.trim()).filter(Boolean)
const required = [
  'package/package.json',
  'package/index.js',
  'package/client.js',
  'package/cordis.patch.yml',
  'package/dsh.plugin.json',
  'package/icon.svg',
  'package/locale/zh.json',
  'package/locale/en.json',
  'package/src/wiring.js',
  'package/src/protocol.js',
  'package/src/diagnostics.js',
  'package/README.zh.md',
]
const missing = required.filter((entry) => !listing.includes(entry))
if (missing.length > 0) {
  console.error(`✗ 产物缺少必需文件：${missing.join(', ')}`)
  process.exit(1)
}
console.log(`      ${tarballName}  ${(bytes.length / 1024).toFixed(1)} KiB  ${listing.length} 个条目`)
console.log(`      sha256 ${sha256}`)

/* 4. 真正加载一次产物，证明自包含 */
console.log('[4/4] 解包并加载产物入口')
rmSync(unpacked, { recursive: true, force: true })
mkdirSync(unpacked, { recursive: true })
run('tar', ['-xzf', tarball, '-C', unpacked])
const entry = join(unpacked, 'package', 'index.js')
const mod = await import(pathToFileURL(entry).href)
if (mod.name !== 'dsh-tamer' || typeof mod.apply !== 'function' || !Array.isArray(mod.inject)) {
  console.error('✗ 产物入口导出不符合插件契约（name / inject / apply）')
  process.exit(1)
}
const srcCount = readdirSync(join(unpacked, 'package', 'src')).filter((n) => n.endsWith('.js')).length
console.log(`      ✓ 入口可加载：name=${mod.name} inject=[${mod.inject.join(', ')}] src 模块 ${srcCount} 个`)

console.log(`\n✓ 构建产物就绪：${tarball}`)
console.log('  安装：dsh plugin --profile <profile> add "' + tarball + '"')
console.log('  或插件页 Add plugin 里粘贴该绝对路径')
