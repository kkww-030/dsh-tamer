import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tamer-home-'))

const {
  loadWorkspaceState,
  savedMode,
  saveWorkspaceState,
  snapshotPath,
  workspaceKey,
  workspaceStatePath,
  writeSnapshot,
  readSnapshot,
} = await import('../src/persist.js')

test('workspaceKey：可读目录名 + 哈希，且不同路径不碰撞', () => {
  const a = workspaceKey('D:\\work\\proj-a')
  const b = workspaceKey('D:\\work\\proj-b')
  assert.match(a, /^proj-a_[0-9a-f]{10}\.json$/u)
  assert.notEqual(a, b)
  // 同名不同路径也必须区分（哈希防碰撞）
  const c = workspaceKey('D:\\other\\proj-a')
  assert.notEqual(a, c)
  assert.match(workspaceKey(''), /^root_[0-9a-f]{10}\.json$/u)
})

test('工作区状态：写入后可读回，且落在 DSH_HOME 下（不进用户项目）', () => {
  const cwd = 'D:\\work\\demo-project'
  assert.equal(loadWorkspaceState(cwd), null)
  assert.equal(savedMode(cwd), null)

  saveWorkspaceState(cwd, { mode: 'strict' })
  assert.equal(savedMode(cwd), 'strict')

  const path = workspaceStatePath(cwd)
  assert.ok(path.startsWith(process.env.DSH_HOME), '状态必须落在 DSH_HOME 下')
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.mode, 'strict')
  assert.ok(raw.updatedAt)
})

test('工作区状态：合并补丁、非法档位回落到 null', () => {
  const cwd = 'D:\\work\\merge-project'
  saveWorkspaceState(cwd, { mode: 'fast' })
  saveWorkspaceState(cwd, { note: 'x' })
  const state = loadWorkspaceState(cwd)
  assert.equal(state.mode, 'fast')
  assert.equal(state.note, 'x')

  saveWorkspaceState(cwd, { mode: 'bogus' })
  assert.equal(savedMode(cwd), null, '非法档位应回落 null 而不是抛错')
})

test('工作区状态：文件损坏时回落 null，不抛错', () => {
  const cwd = 'D:\\work\\corrupt-project'
  const path = workspaceStatePath(cwd)
  saveWorkspaceState(cwd, { mode: 'strict' })
  writeFileSync(path, '{ not json', 'utf8')
  assert.equal(loadWorkspaceState(cwd), null)
  assert.equal(savedMode(cwd), null)
})

test('状态快照：原子写入、可读回、含时间戳', () => {
  assert.equal(readSnapshot(), null)
  const path = writeSnapshot({ mode: 'strict', cwd: 'D:\\work\\snap', turn: 3 })
  assert.equal(path, snapshotPath())
  assert.ok(existsSync(path))
  const snap = readSnapshot()
  assert.equal(snap.mode, 'strict')
  assert.equal(snap.turn, 3)
  assert.equal(typeof snap.ts, 'number')
  // 原子写不应留下 .tmp
  assert.equal(existsSync(`${path}.tmp`), false)
})
