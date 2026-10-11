#!/usr/bin/env node
/**
 * dsh-tamer · 自检
 *
 * 三类检查，全部零依赖：
 *   1) 语法：对每个 .js / .mjs 跑一遍 `node --check`（ESM 按 package.json 的 type: module 解析）
 *   2) 清单：package.json / cordis.patch.yml / dsh.plugin.json / index.js 的 name 与导出是否自洽
 *   3) 装配：动态 import 每个 src 模块，确认没有顶层错误
 *
 * 用法：node scripts/check.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const failures = []
const notes = []

const ok = (msg) => console.log(`  \u2713 ${msg}`)
const bad = (msg) => {
  failures.push(msg)
  console.log(`  \u2717 ${msg}`)
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (['.js', '.mjs'].includes(extname(entry.name))) out.push(full)
  }
  return out
}

/* 1. 语法 */
console.log('[1/4] 语法检查')
const files = [
  ...walk(join(root, 'src')),
  ...walk(join(root, 'scripts')),
  ...walk(join(root, 'tests')),
  join(root, 'index.js'),
  join(root, 'client.js'),
]
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) bad(`语法错误 ${file.replace(root, '.')}\n${result.stderr?.trim()}`)
}
if (failures.length === 0) ok(`${files.length} 个 JS 文件语法通过`)

/* 2. 清单自洽 */
console.log('[2/4] 清单检查')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const descriptor = JSON.parse(readFileSync(join(root, 'dsh.plugin.json'), 'utf8'))
const entrySource = readFileSync(join(root, 'index.js'), 'utf8')

const entryName = entrySource.match(/export const name = '([^']+)'/u)?.[1]
if (!entryName) bad('index.js 缺少 export const name')
if (entryName !== pkg.name) bad(`index.js name(${entryName}) 与 package.json name(${pkg.name}) 不一致`)
const entryVersion = entrySource.match(/export const VERSION = '([^']+)'/u)?.[1]
if (!entryVersion) bad('index.js 缺少 export const VERSION')
else if (entryVersion !== pkg.version) bad(`index.js VERSION(${entryVersion}) 与 package.json version(${pkg.version}) 不一致`)
if (!descriptor.entry?.name?.startsWith(pkg.name)) notes.push('dsh.plugin.json 的 entry.name 与包名不同（可选，仅供展示）')

if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') bad('package.json 缺少 dsh.bundle.patch 声明')
if (!patch.includes(`name: ${pkg.name}`)) bad(`cordis.patch.yml 未引用包名 ${pkg.name}`)
if (!/id:\s*dsh-tamer/u.test(patch)) bad('cordis.patch.yml 缺少 id: dsh-tamer')
if (!/export (async )?function apply/u.test(entrySource)) bad('index.js 缺少 export function apply（async 亦可）')
if (!entrySource.includes('export const inject')) bad('index.js 缺少 export const inject')

// 入口不得有**裸**静态导入：静态导入在模块加载期解析，失败会让整行插件失败，
// 而 DSH 启动是全有全无的。相对导入（./src/…）与 node: 内置模块不受影响。
for (const match of entrySource.matchAll(/^\s*import\s+(?:type\s+)?[^'"]*from\s*['"]([^'"]+)['"]/gmu)) {
  const specifier = match[1]
  if (!specifier.startsWith('.') && !specifier.startsWith('node:')) {
    bad(`index.js 出现裸静态导入 "${specifier}"；请改为运行时 import()`)
  }
}

// 浏览器半：模块 id 必须等于包名，且必须走 ModuleLoader 注册
const clientSource = readFileSync(join(root, 'client.js'), 'utf8')
if (pkg.dsh?.client?.platform !== 'web') bad('package.json 缺少 dsh.client.platform = "web"')
if (pkg.exports?.['./client'] !== './client.js') bad('package.json 缺少 "./client" 导出')
if (!clientSource.includes(`id: '${pkg.name}'`)) bad(`client.js 的模块 id 必须等于包名 ${pkg.name}`)
if (!clientSource.includes('__ModuleLoader__.load')) bad('client.js 必须通过 window.__ModuleLoader__.load 注册')
if (!pkg.files?.includes('client.js')) bad('package.json 的 files 缺少 client.js')
if (!/export const PROTOCOL_TEXT/u.test(readFileSync(join(root, 'src', 'protocol.js'), 'utf8'))) {
  bad('src/protocol.js 未生成（先跑 node scripts/gen-protocol.mjs）')
}
for (const key of ['title', 'description']) {
  for (const locale of ['en', 'zh']) {
    const file = join(root, 'locale', `${locale}.json`)
    if (!existsSync(file)) {
      bad(`缺少 locale/${locale}.json`)
      continue
    }
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    if (!doc.meta?.[key]) bad(`locale/${locale}.json 缺少 meta.${key}`)
  }
}
if (!existsSync(join(root, 'icon.svg'))) bad('缺少 icon.svg')
if (failures.length === 0) ok('package.json / cordis.patch.yml / dsh.plugin.json / locale / icon 自洽')

/* 3. 装配（动态 import 每个 src 模块） */
console.log('[3/4] 模块装配检查')
const modules = readdirSync(join(root, 'src')).filter((n) => n.endsWith('.js'))
for (const name of modules) {
  try {
    await import(pathToFileURL(join(root, 'src', name)).href)
  } catch (error) {
    bad(`src/${name} 装配失败：${String(error)}`)
  }
}
if (failures.length === 0) ok(`${modules.length} 个 src 模块装配正常`)

/* 4. 协议单一事实源 */
console.log('[4/4] 协议漂移检查')
const check = spawnSync(process.execPath, [join(root, 'scripts', 'gen-protocol.mjs'), '--check'], { encoding: 'utf8' })
process.stdout.write(`  ${check.stdout?.trim() ?? ''}\n`)
if (check.status !== 0) bad('src/protocol.js 与 core/协议注入模板.txt 已漂移（跑 npm run gen）')

/* 汇总 */
console.log('')
if (notes.length > 0) for (const note of notes) console.log(`  · ${note}`)
if (failures.length > 0) {
  console.error(`\u2717 自检失败：${failures.length} 项`)
  process.exit(1)
}
console.log('\u2713 自检全部通过')
