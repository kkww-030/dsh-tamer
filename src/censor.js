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
 * 判定「已列出信息来源」的指示词。
 * 收紧过：口语化的“仅供参考”不算来源（saddle.py:58-60 的注释说明了原因）。
 */
export const DEFAULT_SOURCE_INDICATORS = [
  '信息来源', '来源：', '来源:', '参考来源', '参考文献', '参考链接', '参考资料',
  '出处', '引用来源', 'http', 'www.', '[1]',
]

/** 文本是否涉及客观信息。 */
export function objectiveIn(text, words = DEFAULT_OBJECTIVE_WORDS) {
  if (typeof text !== 'string' || !text) return false
  const low = text.toLowerCase()
  return words.some((w) => low.includes(String(w).toLowerCase()))
}

/** 文本是否已经列出信息来源。 */
export function sourced(text, indicators = DEFAULT_SOURCE_INDICATORS) {
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
 * @param {string[]|null} [input.objectiveWords]
 * @param {string[]|null} [input.sourceIndicators]
 * @returns {{action: 'none'|'retry'|'giveup', reason: string}}
 */
export function evaluateCensor(input) {
  const {
    userText = '',
    assistantText = '',
    mode = 'standard',
    censor = 'warn',
    retries = 0,
    objectiveWords,
    sourceIndicators,
  } = input

  const words = objectiveWords ?? DEFAULT_OBJECTIVE_WORDS
  const indicators = sourceIndicators ?? DEFAULT_SOURCE_INDICATORS

  if (censor === 'off') return { action: 'none', reason: 'censor=off' }
  if (mode === 'fast') return { action: 'none', reason: '快速档不校验来源' }

  // 标准档只看用户提问；严格档同时看回复正文（回复本身在讲客观事实也算）。
  const objective = mode === 'strict'
    ? objectiveIn(userText, words) || objectiveIn(assistantText, words)
    : objectiveIn(userText, words)
  if (!objective) return { action: 'none', reason: '未涉及客观信息' }

  if (sourced(assistantText, indicators)) return { action: 'none', reason: '已列出信息来源' }

  const limit = censor === 'strict' ? 2 : 1
  if (retries >= limit) return { action: 'giveup', reason: `已打回 ${retries} 次仍未见来源，放过以免死循环` }
  return { action: 'retry', reason: '涉及客观信息但回复未列「信息来源」' }
}

/** 打回时发给模型的纠正指令（与 saddle.py:307-309 的措辞保持一致）。 */
export function correctionText(mode) {
  return (
    '（协议校验拦截）你上一条回复涉及客观信息，但未在末尾整理「信息来源」清单。'
    + '请按协议补充来源（来源名称 + 链接，并说明对应哪条结论）；查不到就明确写「未找到可靠来源」。'
    + `当前档位：${mode}。请重新回答完整。`
  )
}
