/**
 * dsh-tamer · 来源校验（“涉及客观信息却没有列来源”判定）
 *
 * 判定表移植自 saddle/saddle.py:53-64（马鞍收紧后的版本），逻辑上做了一处诚实改进：
 * 判定与**档位**联动——快速档永不校验，标准档只看用户提问，严格档同时看回复正文。
 * 这是启发式判定，不是语义理解：宁可漏判，不可误伤（误伤会触发无意义的打回）。
 */

/** 命中即认为该轮涉及客观事实的关键词。 */
export const DEFAULT_OBJECTIVE_WORDS = [
  '引脚', 'datasheet', '数据手册', '规格书', '规格', '参数', '标准', '规范',
  '政策', '法规', '行情', '价格', '股价', '论文', 'paper', 'GPIO', '寄存器',
  '官方', '汇率', '固件', '版本号', '说明文档', 'spec',
]

/**
 * 「已列出信息来源」的自定义词表 —— **默认判定不再使用它**。
 *
 * 原因（2026-10-11 真机案例）：子串匹配会把"讨论来源"的话当成"列出来源"。
 * 某轮回复里写了「先把几个材料常数的**出处**核验到位」，命中「出处」→ 被判为已列来源
 * → 该打回时静默放过。所以默认走下面的**结构化判定**，只有在配置里显式给出
 * `sourceIndicators` 时才退回词表路径（保留自定义能力）。
 */
export const DEFAULT_SOURCE_INDICATORS = [
  '信息来源', '来源：', '来源:', '参考来源', '参考文献', '参考链接', '参考资料',
  '出处', '引用来源', 'http', 'www.', '[1]',
]

/**
 * 行首标签式的来源行（结构化判定的第三种形态）：
 * 整行就是「信息来源」/「出处」/「参考文献」，或「来源：…」「参考文献: …」。
 * 因为锚定行首，正常行文里出现的"出处核验到位"不会被误判。
 */
export const SOURCE_LABEL_RE = /^[ \t>*+\-]*(信息来源|资料来源|来源|参考来源|参考链接|参考文献|参考资料|出处)[ \t]*([:：]|$)/mu

/** 文本是否涉及客观信息。 */
export function objectiveIn(text, words = DEFAULT_OBJECTIVE_WORDS) {
  if (typeof text !== 'string' || !text) return false
  const low = text.toLowerCase()
  return words.some((w) => low.includes(String(w).toLowerCase()))
}

/**
 * 回复里是否**真的**给出了来源（默认结构化判定）。
 * 满足任一才算：① 有链接 ② 有编号引用 `[n]` ③ 有行首标签式来源行。
 * @param {string} text
 * @param {string[]} [indicators] 显式给出时退回子串匹配（自定义词表兼容路径）
 */
export function sourced(text, indicators) {
  if (typeof text !== 'string' || !text) return false
  if (Array.isArray(indicators) && indicators.length) {
    const low = text.toLowerCase()
    return indicators.some((k) => low.includes(String(k).toLowerCase()))
  }
  if (/https?:\/\/|www\./i.test(text)) return true
  if (/\[\d+\]/.test(text)) return true
  return SOURCE_LABEL_RE.test(text)
}

/**
 * 协议明说「查不到就明说，不编造」——所以**诚实的"未找到来源"是合规结果**，
 * 绝不能打回（否则等于惩罚诚实）。移植自 trae-tamer/src/censor.js:29-37。
 */
export const NOT_FOUND_INDICATORS = [
  '未找到可靠来源', '没有找到可靠来源', '未能找到可靠来源', '查不到可靠来源',
  '未查到可靠来源', '未找到官方来源', '暂无可靠来源', '没有可靠来源',
  'no reliable source found',
]

/** 文本是否声明了"查不到可靠来源"。 */
export function saysNotFound(text, indicators = NOT_FOUND_INDICATORS) {
  if (typeof text !== 'string' || !text) return false
  const low = text.toLowerCase()
  return indicators.some((k) => low.includes(String(k).toLowerCase()))
}

/**
 * 综合判定本轮是否需要打回重做。
 * @param {object} input
 * @param {string} input.userText - 本轮用户消息
 * @param {string} input.assistantText - 本轮助手回复全文
 * @param {'fast'|'standard'|'strict'} input.mode - 当前档位
 * @param {'off'|'warn'|'strict'} input.censor - 校验姿态
 * @param {number} input.retries - 本轮已打回次数
 * @param {number} [input.archivedCount] - 本轮已归档条数（>0 即视为合规，移植自 trae-tamer）
 * @param {boolean} [input.saidNotFound] - 模型是否显式声明过"查不到"
 * @param {string[]|null} [input.objectiveWords]
 * @param {string[]|null} [input.sourceIndicators]
 * @returns {{action: 'none'|'retry'|'giveup', code: string, reason: string}}
 */
export function evaluateCensor(input) {
  const {
    userText = '',
    assistantText = '',
    mode = 'standard',
    censor = 'warn',
    retries = 0,
    archivedCount = 0,
    saidNotFound = false,
    objectiveWords,
    sourceIndicators,
  } = input

  const words = objectiveWords ?? DEFAULT_OBJECTIVE_WORDS

  if (censor === 'off') return { action: 'none', code: 'censor-off', reason: 'censor=off' }
  if (mode === 'fast') return { action: 'none', code: 'fast-mode', reason: '快速档不校验来源' }

  // 标准档只看用户提问；严格档同时看回复正文（回复本身在讲客观事实也算）。
  const objective = mode === 'strict'
    ? objectiveIn(userText, words) || objectiveIn(assistantText, words)
    : objectiveIn(userText, words)
  if (!objective) return { action: 'none', code: 'non-objective', reason: '未涉及客观信息' }

  // ① 已归档即合规：来源已落进留痕仓库，可追溯性已满足（借鉴 trae-tamer 的 archivedCount）
  if (archivedCount > 0) {
    return { action: 'none', code: 'archived', reason: `本轮已归档 ${archivedCount} 条来源` }
  }
  // ② 结构化判定"回复里真的给了来源"
  if (sourced(assistantText, sourceIndicators)) {
    return { action: 'none', code: 'sources-in-reply', reason: '已列出信息来源' }
  }
  // ③ 诚实"查不到"是协议允许的结果，不能打回（否则等于惩罚诚实）
  if (saidNotFound === true || saysNotFound(assistantText)) {
    return { action: 'none', code: 'honest-not-found', reason: '已诚实声明未找到可靠来源（协议允许）' }
  }

  const limit = censor === 'strict' ? 2 : 1
  if (retries >= limit) {
    return { action: 'giveup', code: 'giveup', reason: `已打回 ${retries} 次仍未见来源，放过以免死循环` }
  }
  return { action: 'retry', code: 'missing-sources', reason: '涉及客观信息但回复未列「信息来源」' }
}

/**
 * 开工自检（移植自 trae-tamer/src/censor.js:61-83）：由**模型自己声明**本轮是否涉及
 * 客观信息（语义判断），而不是让客户端正则去猜每一句话——这从根上避免了猜测型误判。
 * @returns {{objective: boolean, guidance: string}}
 */
export function runPreflight({ objective = false, task = '', mode = 'standard' } = {}) {
  if (objective !== true) {
    return {
      objective: false,
      guidance: '本轮按非客观信息任务处理：正常完成即可。若中途发现其实涉及客观事实（硬件/标准/政策/行情/论文等），请补调一次 tamer_preflight(objective=true)。',
    }
  }
  const strict = mode === 'strict'
  return {
    objective: true,
    guidance: [
      '本轮涉及客观信息，按协议执行：',
      '1. 只用官方/可靠来源（优先取一手资料）；',
      '2. 正文结论就近标注来源名称与链接；',
      '3. 重要结论用 tamer_archive 归档到留痕仓库（可直接满足来源合规）；',
      '4. 发出最终回复前调用 tamer_finalize 自检，warn 必须补齐后重检，不许带 warn 收尾；',
      strict
        ? '5. 当前为严格档：需要 ≥2 个方案，末尾必须有「信息来源」清单（名称+链接+对应结论）。'
        : '5. 查不到可靠来源时，明确写「未找到可靠来源」，不要编造或用相近内容顶替（这样写会通过自检）。',
    ].join('\n'),
  }
}

/**
 * 交付自检（移植自 trae-tamer/src/censor.js:95-142；v0.3.0 起修掉"假通过"）。
 *
 * **声明的三态**（关键）：
 *   - `declaredObjective === undefined`：本轮**尚未调用** tamer_preflight
 *   - `true` / `false`：模型显式声明涉及 / 不涉及客观信息
 *
 * v0.2.0 的缺陷：状态默认 `false`，于是"没声明"与"声明为非客观"不可区分，
 * 客观任务的 finalize 也拿到 `pass/non-objective`（真机实测 5 次假通过）。
 * 现在：未声明 + 正文像客观信息 → `warn/undeclared-objective`。
 *
 * @returns {{status:'skip'|'pass'|'warn', code: string, reason: string, action?: string}}
 */
export function evaluateFinalize(input) {
  const {
    declaredObjective,
    archivedCount = 0,
    replyText = '',
    saidNotFound = false,
    mode = 'standard',
  } = input

  if (mode === 'fast') return { status: 'skip', code: 'fast-mode', reason: '快速档不做来源自检' }

  const declared = declaredObjective === true
  const explicitlyNonObjective = declaredObjective === false
  const looksObjective = objectiveIn(replyText)

  // ① 未声明却像客观任务 → 不放行（让"偷懒不声明"有代价）
  if (declaredObjective === undefined && looksObjective) {
    return {
      status: 'warn',
      code: 'undeclared-objective',
      reason: '尚未调用 tamer_preflight 声明本轮性质，但回复正文涉及客观信息关键词',
      action: '先调 tamer_preflight(objective=true) 声明并检索可靠来源；若确认不涉及客观信息，请调 tamer_preflight(objective=false) 显式声明后重新 finalize。',
    }
  }

  // ② 严格档兜底：显式声明"非客观"，但正文明显在讲规格/手册
  if (mode === 'strict' && explicitlyNonObjective && looksObjective) {
    return {
      status: 'warn',
      code: 'backstop-objective',
      reason: 'preflight 声明为非客观任务，但回复正文涉及客观信息关键词',
      action: '请补调 tamer_preflight(objective=true)，检索可靠来源、在末尾列「信息来源」后重新 finalize；若确认不涉及，请在回复中说明依据。',
    }
  }

  // ③ 非客观任务（未声明且正文不像客观，或标准档信任显式声明）
  if (!declared) return { status: 'pass', code: 'non-objective', reason: '非客观信息任务，无需来源清单' }

  if (archivedCount > 0) return { status: 'pass', code: 'archived', reason: `本轮已归档 ${archivedCount} 条来源` }
  if (sourced(replyText)) return { status: 'pass', code: 'sources-in-reply', reason: '回复中已包含链接、编号引用或行首来源标签' }
  if (saidNotFound === true || saysNotFound(replyText)) {
    return { status: 'pass', code: 'honest-not-found', reason: '已诚实声明未找到可靠来源（协议允许）' }
  }
  return {
    status: 'warn',
    code: 'missing-sources',
    reason: '本轮涉及客观信息，但未见归档、回复里也没有来源链接或「未找到可靠来源」声明',
    action: '发出最终回复前：① 用可靠来源核实并在末尾列「信息来源」清单，重要结论用 tamer_archive 归档；或 ② 明确写「未找到可靠来源」。补齐后重新调用 tamer_finalize。',
  }
}

/** 打回时发给模型的纠正指令（与 saddle.py:307-309 的措辞保持一致）。 */
export function correctionText(mode) {
  return (
    '（协议校验拦截）你上一条回复涉及客观信息，但未在末尾整理「信息来源」清单。'
    + '请按协议补充来源（来源名称 + 链接，并说明对应哪条结论）；查不到就明确写「未找到可靠来源」。'
    + `当前档位：${mode}。请重新回答完整。`
  )
}
