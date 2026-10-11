import test from 'node:test'
import assert from 'node:assert/strict'
import {
  correctionText,
  DEFAULT_OBJECTIVE_WORDS,
  DEFAULT_SOURCE_INDICATORS,
  evaluateCensor,
  objectiveIn,
  sourced,
} from '../src/censor.js'

test('objectiveIn 命中客观信息关键词', () => {
  assert.equal(objectiveIn('STM32F103 的 GPIO 引脚定义'), true)
  assert.equal(objectiveIn('帮我写一首诗'), false)
  assert.equal(objectiveIn(''), false)
  assert.equal(objectiveIn(undefined), false)
})

test('sourced 只认明确的来源字样与链接', () => {
  assert.equal(sourced('http://example.com'), true)
  assert.equal(sourced('来源：ST 官方数据手册'), true)
  assert.equal(sourced('信息来源\n- ST 手册'), true)
  assert.equal(sourced('仅供参考，仅代表个人经验'), false)
})

test('快速档永不触发校验', () => {
  const verdict = evaluateCensor({
    userText: '查一下某芯片引脚定义',
    assistantText: '大概是 3.3V。',
    mode: 'fast',
    censor: 'strict',
    retries: 0,
  })
  assert.equal(verdict.action, 'none')
})

test('censor=off 永不触发校验', () => {
  const verdict = evaluateCensor({
    userText: '查一下某芯片引脚定义',
    assistantText: '大概是 3.3V。',
    mode: 'strict',
    censor: 'off',
    retries: 0,
  })
  assert.equal(verdict.action, 'none')
})

test('标准档：只按用户提问判定，回复无来源 → 打回一次后放过（warn）', () => {
  const base = { userText: '这个芯片的引脚定义是什么', assistantText: '据我所知是这样。', mode: 'standard', censor: 'warn' }
  assert.equal(evaluateCensor({ ...base, retries: 0 }).action, 'retry')
  assert.equal(evaluateCensor({ ...base, retries: 1 }).action, 'giveup')
})

test('严格档：最多打回两次', () => {
  const base = { userText: '这个芯片的引脚定义是什么', assistantText: '据我所知是这样。', mode: 'strict', censor: 'strict' }
  assert.equal(evaluateCensor({ ...base, retries: 0 }).action, 'retry')
  assert.equal(evaluateCensor({ ...base, retries: 1 }).action, 'retry')
  assert.equal(evaluateCensor({ ...base, retries: 2 }).action, 'giveup')
})

test('已列出来源则不打回', () => {
  const verdict = evaluateCensor({
    userText: '这个芯片的引脚定义是什么',
    assistantText: '引脚定义如下……\n\n信息来源：ST 官方数据手册 https://www.st.com/x.pdf',
    mode: 'strict',
    censor: 'strict',
    retries: 0,
  })
  assert.equal(verdict.action, 'none')
})

test('严格档额外看回复正文（用户提问不含客观词，但回复在讲规格）', () => {
  const verdict = evaluateCensor({
    userText: '帮我看看这个',
    assistantText: '该寄存器规格如下，参数为 72MHz。',
    mode: 'strict',
    censor: 'warn',
    retries: 0,
  })
  assert.equal(verdict.action, 'retry')
})

test('自定义词表可覆盖内置表', () => {
  const verdict = evaluateCensor({
    userText: '关于「量子纠缠」的结论',
    assistantText: '结论是……',
    mode: 'standard',
    censor: 'warn',
    retries: 0,
    objectiveWords: ['量子纠缠'],
    sourceIndicators: ['出处'],
  })
  assert.equal(verdict.action, 'retry')
  assert.ok(DEFAULT_OBJECTIVE_WORDS.length > 0 && DEFAULT_SOURCE_INDICATORS.length > 0)
})

test('打回文案包含档位与来源要求', () => {
  const text = correctionText('strict')
  assert.match(text, /信息来源/u)
  assert.match(text, /strict/u)
})
