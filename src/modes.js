/**
 * dsh-tamer · 三档分级
 *
 * 关键词表与档位说明移植自 saddle/saddle.py:41-50, 369-377 与 core/协议注入模板.txt，
 * 保证插件与既有四端（网页插件 / tamer.py / 马鞍 / 桌面粘贴）行为一致。
 */

export const MODES = ['fast', 'standard', 'strict']

/** 档位 → 一句话说明（注入与重申时携带）。 */
export const MODE_HINT = {
  fast: '快速：直接答，不强求多方案与来源明细',
  standard: '标准：澄清 + 1~2 方案 + 关键来源',
  strict: '严格：完整可行性 → ≥2 方案 → 来源链接 + 末尾来源集合 → 迭代',
}

/** 档位 → 别名（用于 /tamer <alias>）。 */
export const MODE_ALIAS = {
  fast: ['fast', '快速', '快速模式', 'q'],
  standard: ['standard', '标准', '标准模式', '默认', 'n'],
  strict: ['strict', '严格', '严格模式', 's'],
}

/**
 * 宽松关键词表 —— **插件内部不用于自然语言切档**，保留仅为与其他端对齐/参考。
 *
 * ⚠️ 这些正则**未锚定**，一旦跑在整条用户消息上会严重误判：
 *   · `/fast/` 命中 FastAPI、faster、fastboot（嵌入式场景的 fastboot 是高频词）
 *   · `/strict/` 命中 "TypeScript strict"、"C++ strict"
 *   · `/standard/` 命中 "C++ standard library"
 * 而误判成 fast 档会经 censor 的「快速档永不校验」**静默关掉来源打回**——
 * 与插件核心价值直接冲突。所以自然语言只走 `detectModeExact`。
 * browser-plugin / saddle.py 仍用这套宽松表，是否同步收紧由主人决定。
 */
export const MODE_KEYWORDS = [
  { regex: /严格模式|按严格|支严格执行|strict/i, mode: 'strict' },
  { regex: /快速模式|快答|随便(回|答)|quick|fast/i, mode: 'fast' },
  { regex: /标准模式|正常模式|默认(档|模式)|standard/i, mode: 'standard' },
]

/**
 * **精确**解析档位：去掉首尾空白与句末标点后，整串等于某个别名才算。
 * 这是自然语言切档唯一允许的入口——"整句就是档位词"才是主人的真实意图。
 * @param {string} text
 * @returns {'fast'|'standard'|'strict'|null}
 */
export function detectModeExact(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim().replace(/[。！!，,.\s]+$/u, '')
  if (!trimmed) return null
  for (const [mode, aliases] of Object.entries(MODE_ALIAS)) {
    if (aliases.includes(trimmed)) return mode
  }
  return null
}

/**
 * 宽松解析（先精确别名，再跑未锚定正则）。**不要**把它用在用户消息上；
 * 仅用于 `/tamer` 命令的首词判断等受控输入。
 * @param {string} text
 * @returns {'fast'|'standard'|'strict'|null}
 */
export function detectMode(text) {
  const exact = detectModeExact(text)
  if (exact) return exact
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed) return null
  for (const { regex, mode } of MODE_KEYWORDS) {
    if (regex.test(trimmed)) return mode
  }
  return null
}

/** 归一化任意输入为合法档位，非法则返回 fallback。 */
export function normalizeMode(value, fallback = 'standard') {
  return MODES.includes(value) ? value : fallback
}

/** 档位说明，非法档位回落到标准档文案。 */
export function modeHint(mode) {
  return MODE_HINT[normalizeMode(mode)] ?? MODE_HINT.standard
}
