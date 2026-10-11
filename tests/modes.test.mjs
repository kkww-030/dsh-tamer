import test from 'node:test'
import assert from 'node:assert/strict'
import { detectMode, detectModeExact, modeHint, normalizeMode, MODE_ALIAS, MODES } from '../src/modes.js'

test('detectMode 识别英文档位名与别名', () => {
  assert.equal(detectMode('fast'), 'fast')
  assert.equal(detectMode('strict'), 'strict')
  assert.equal(detectMode('standard'), 'standard')
  assert.equal(detectMode('q'), 'fast')
  assert.equal(detectMode('n'), 'standard')
  assert.equal(detectMode('s'), 'strict')
})

test('detectMode 识别中文档位词（带标点）', () => {
  assert.equal(detectMode('严格模式'), 'strict')
  assert.equal(detectMode('严格模式。'), 'strict')
  assert.equal(detectMode('快速模式！'), 'fast')
  assert.equal(detectMode('标准模式'), 'standard')
})

test('detectMode 在普通问句里不误判', () => {
  assert.equal(detectMode('帮我看看这个引脚定义'), null)
  assert.equal(detectMode(''), null)
  assert.equal(detectMode(undefined), null)
  assert.equal(detectMode('标准库怎么用'), null)
})

test('每个档位都有别名与文案，且 MODES 无遗漏', () => {
  for (const mode of MODES) {
    assert.ok(MODE_ALIAS[mode]?.length > 0, `${mode} 缺少别名`)
    assert.equal(typeof modeHint(mode), 'string')
  }
})

test('normalizeMode 对非法值回落到 fallback', () => {
  assert.equal(normalizeMode('strict'), 'strict')
  assert.equal(normalizeMode('bogus'), 'standard')
  assert.equal(normalizeMode('bogus', 'fast'), 'fast')
  assert.equal(normalizeMode(undefined, 'strict'), 'strict')
})

/* ── 精确匹配：自然语言切档的唯一入口 ─────────────────────────────── */

test('detectModeExact 只认整句档位词', () => {
  assert.equal(detectModeExact('严格模式'), 'strict')
  assert.equal(detectModeExact('严格模式。'), 'strict')
  assert.equal(detectModeExact('  快速模式  '), 'fast')
  assert.equal(detectModeExact('s'), 'strict')
  assert.equal(detectModeExact('标准'), 'standard')
})

test('detectModeExact 不再误判嵌入词（FastAPI / fastboot / TypeScript strict / C++ standard）', () => {
  assert.equal(detectModeExact('用 FastAPI 写接口'), null)
  assert.equal(detectModeExact('fastboot 刷机流程'), null)
  assert.equal(detectModeExact('TypeScript strict 模式怎么开'), null)
  assert.equal(detectModeExact('C++ standard library 的用法'), null)
  assert.equal(detectModeExact('严格模式：帮我看看这个'), null, '整句匹配才算，句首带词但另有内容不切档')
})

test('宽松 detectMode 仍会命中这些词——这正是插件内部不再用它做自然语言切档的原因', () => {
  assert.equal(detectMode('用 FastAPI 写接口'), 'fast')
  assert.equal(detectMode('TypeScript strict 模式'), 'strict')
  assert.equal(detectMode('C++ standard library'), 'standard')
  // 受控输入（命令首词）仍然好用
  assert.equal(detectMode('严格模式'), 'strict')
})
