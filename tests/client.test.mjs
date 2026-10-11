import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 浏览器半的结构测试。
 *
 * 没有浏览器可用，所以这里验证的是「加载协议是否被正确遵守」：
 * 模块 id、factory 产出的客户端插件形状、注册的槽位与字典键集。
 * 真实的视觉呈现**不在**这里的覆盖范围内（README 已声明）。
 */
const here = dirname(fileURLToPath(import.meta.url))
const clientPath = resolve(here, '..', 'client.js')

let loadCount = 0

async function loadClientModule() {
  let captured = null
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
  try {
    // ESM 会缓存模块，加查询参数强制重新执行，保证每个用例都拿到一次真实的加载过程
    loadCount += 1
    await import(`${pathToFileURL(clientPath).href}?case=${loadCount}`)
  } finally {
    globalThis.window = previous
  }
  assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load')
  return captured
}

function reactShim() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
  }
}

test('client.js 以包名注册模块，factory 返回 { inject, apply }', async () => {
  const spec = await loadClientModule()
  assert.equal(spec.id, 'dsh-tamer')
  assert.equal(typeof spec.factory, 'function')

  const mod = spec.factory((name) => {
    if (name === 'react') return reactShim()
    throw new Error(`未声明的运行时依赖：${name}`)
  })
  assert.deepEqual(mod.inject, ['slots', 'locale'])
  assert.equal(typeof mod.apply, 'function')
})

test('apply 注册字典（zh/en 键集一致）与 composer 停靠槽', async () => {
  const spec = await loadClientModule()
  const mod = spec.factory(() => reactShim())

  const seen = { dicts: [], slots: [], registration: null, effects: 0 }
  const ctx = {
    effect(fn) {
      seen.effects += 1
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      register(ns, dict) {
        seen.dicts.push({ ns, dict })
        return () => {}
      },
      bind() {
        return (key) => `translated:${key}`
      },
    },
    slots: {
      inject(name, callback) {
        seen.slots.push(name)
        callback()
      },
      register(options, component) {
        seen.registration = { options, component }
        return () => {}
      },
    },
  }

  mod.apply(ctx)

  assert.equal(seen.dicts.length, 1)
  assert.equal(seen.dicts[0].ns, 'dsh-tamer')
  const { zh, en } = seen.dicts[0].dict
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh 与 en 的键集必须一致')
  assert.ok(zh['dock.label'] && en['dock.label'])

  assert.deepEqual(seen.slots, ['conversation.composer.dock'])
  assert.equal(seen.registration.options.name, 'conversation.composer.dock')
  assert.equal(seen.registration.options.id, 'dsh-tamer')
  assert.equal(typeof seen.registration.options.order, 'number')
  assert.ok(seen.effects >= 1, '字典注册必须包在 ctx.effect 里以便卸载时回收')
})

test('徽标组件可渲染、走文案服务、不拦截指针事件', async () => {
  const spec = await loadClientModule()
  const mod = spec.factory(() => reactShim())

  let component = null
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => `translated:${key}` },
    slots: { inject: (_n, cb) => cb(), register: (_o, c) => { component = c; return () => {} } },
  }
  mod.apply(ctx)

  const vnode = component()
  assert.equal(vnode.type, 'div')
  assert.equal(vnode.props.title, 'translated:dock.hint')
  assert.equal(vnode.props['aria-label'], 'translated:dock.aria')
  assert.equal(vnode.props.style.pointerEvents, 'none')
  assert.equal(vnode.props.style.color, 'inherit')

  // 文案服务不可用时退回本地字典，而不是渲染失败
  let fallbackComponent = null
  const brokenCtx = {
    effect: (fn) => fn(),
    locale: {
      register: () => () => {},
      bind() { throw new Error('locale service unavailable') },
    },
    slots: { inject: (_n, cb) => cb(), register: (_o, c) => { fallbackComponent = c; return () => {} } },
  }
  mod.apply(brokenCtx)
  const fallback = fallbackComponent()
  assert.equal(fallback.props.title.includes('信息来源'), true, '应回落到中文文案')
})
