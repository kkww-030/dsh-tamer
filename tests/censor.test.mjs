import test from 'node:test'
import assert from 'node:assert/strict'
import {
  correctionText,
  DEFAULT_OBJECTIVE_WORDS,
  DEFAULT_SOURCE_INDICATORS,
  evaluateCensor,
  evaluateFinalize,
  objectiveIn,
  runPreflight,
  saysNotFound,
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

/* ── 结构化判定 + 移植自 trae-tamer 的两条合规豁免 ─────────────────── */

test('sourced 是结构化判定：链接 / [n] 编号 / 行首来源标签才算', () => {
  assert.equal(sourced('见 https://www.st.com/x.pdf'), true)
  assert.equal(sourced('引脚定义见 [1] ST 手册'), true)
  assert.equal(sourced('来源：ST 官方数据手册'), true)
  assert.equal(sourced('信息来源\n- ST 手册'), true)
  assert.equal(sourced('  - 参考文献: ST 手册'), true)
})

test('sourced 不再被"讨论来源"的行文骗到（2026-10-11 真机误判回归）', () => {
  // 原文：回复里写了「先把几个材料常数的出处核验到位」，当时因子串命中「出处」被判为已列来源
  assert.equal(sourced('先把几个材料常数的出处核验到位。'), false)
  assert.equal(sourced('这类结论我不给来源，仅供参考。'), false)
  assert.equal(sourced('来源可靠与否还需要核验。'), false)
})

test('saysNotFound 认得协议允许的诚实声明', () => {
  assert.equal(saysNotFound('这个型号未找到可靠来源。'), true)
  assert.equal(saysNotFound('链接如下 https://x'), false)
  assert.equal(saysNotFound(''), false)
})

test('诚实的「未找到可靠来源」判合规，不打回', () => {
  const verdict = evaluateCensor({
    userText: '这个芯片的引脚定义是什么',
    assistantText: '未找到可靠来源，不敢编造。',
    mode: 'strict',
    censor: 'strict',
    retries: 0,
  })
  assert.equal(verdict.action, 'none')
  assert.equal(verdict.code, 'honest-not-found')
})

test('本轮已归档 ≥1 条 → 视为来源合规（借鉴 trae-tamer）', () => {
  const verdict = evaluateCensor({
    userText: '这个芯片的引脚定义是什么',
    assistantText: '引脚定义如下。',
    mode: 'standard',
    censor: 'warn',
    retries: 0,
    archivedCount: 2,
  })
  assert.equal(verdict.action, 'none')
  assert.equal(verdict.code, 'archived')
})

test('判定结果带稳定的 code（便于日志区分"合法放过"与"漏判"）', () => {
  assert.equal(evaluateCensor({ userText: '随便聊聊', assistantText: '好', retries: 0 }).code, 'non-objective')
  assert.equal(evaluateCensor({ userText: '某芯片引脚', assistantText: '好', retries: 0 }).code, 'missing-sources')
  assert.equal(evaluateCensor({ userText: '某芯片引脚', assistantText: '好', censor: 'off', retries: 0 }).code, 'censor-off')
  assert.equal(evaluateCensor({ userText: '某芯片引脚', assistantText: '好', mode: 'fast', retries: 0 }).code, 'fast-mode')
  assert.equal(evaluateCensor({ userText: '某芯片引脚', assistantText: '好', retries: 1 }).code, 'giveup')
  assert.equal(
    evaluateCensor({ userText: '某芯片引脚', assistantText: '来源：ST 手册', retries: 0 }).code,
    'sources-in-reply',
  )
})

test('runPreflight：非客观不打扰 / 客观给工作流 / 严格档加码', () => {
  assert.match(runPreflight({ objective: false }).guidance, /非客观信息任务/u)
  const on = runPreflight({ objective: true, mode: 'strict' })
  assert.equal(on.objective, true)
  assert.match(on.guidance, /tamer_finalize/u)
  assert.match(on.guidance, /≥2 个方案/u)
})

test('evaluateFinalize：交付自检的各条分支', () => {
  assert.equal(evaluateFinalize({ mode: 'fast' }).status, 'skip')
  assert.equal(evaluateFinalize({ declaredObjective: false, replyText: '随便聊聊' }).status, 'pass')
  assert.equal(evaluateFinalize({ declaredObjective: true, archivedCount: 1, replyText: 'x' }).status, 'pass')
  assert.equal(evaluateFinalize({ declaredObjective: true, replyText: '未找到可靠来源' }).status, 'pass')
  assert.equal(evaluateFinalize({ declaredObjective: true, replyText: '来源：ST 手册 https://st.com' }).status, 'pass')

  const warn = evaluateFinalize({ declaredObjective: true, replyText: '大概是 3.3V。' })
  assert.equal(warn.status, 'warn')
  assert.equal(warn.code, 'missing-sources')
  assert.match(warn.action, /信息来源/u)

  // 严格档兜底：显式声明"非客观"，但正文在讲规格
  const backstop = evaluateFinalize({ mode: 'strict', declaredObjective: false, replyText: '该寄存器规格为 72MHz。' })
  assert.equal(backstop.status, 'warn')
  assert.equal(backstop.code, 'backstop-objective')
})

/* ── v0.3.0：声明的三态（修掉"未声明 = 非客观"的假通过）─────────── */

test('evaluateFinalize：未声明（undefined）+ 正文像客观 → warn/undeclared-objective', () => {
  const verdict = evaluateFinalize({ replyText: '据 arXiv:1103.4601，该参数约为 0.3。' })
  assert.equal(verdict.status, 'warn')
  assert.equal(verdict.code, 'undeclared-objective')
  assert.match(verdict.action, /tamer_preflight/u)
  // 标准档与严格档都不放行
  assert.equal(evaluateFinalize({ mode: 'strict', replyText: '该寄存器规格为 72MHz。' }).code, 'undeclared-objective')
})

test('evaluateFinalize：未声明但正文不像客观 → 仍 pass（不打扰闲聊）', () => {
  const verdict = evaluateFinalize({ replyText: '这段代码可以这样重构。' })
  assert.equal(verdict.status, 'pass')
  assert.equal(verdict.code, 'non-objective')
})

test('evaluateFinalize：显式声明 false 在标准档算信任（pass），严格档才兜底', () => {
  const reply = '据 arXiv:1103.4601，该参数约为 0.3。'
  assert.equal(evaluateFinalize({ mode: 'standard', declaredObjective: false, replyText: reply }).status, 'pass')
  assert.equal(evaluateFinalize({ mode: 'strict', declaredObjective: false, replyText: reply }).code, 'backstop-objective')
})
