/**
 * dsh-tamer · 配置解析
 *
 * 设计取舍（v0.1）：**不导出 Cordis 的 `Config`（schemastery schema）**，
 * 以保持插件零运行时依赖。代价是设置页不会为本插件自动渲染表单，
 * 配置只能写在插件行的 `config:` 里（见 cordis.patch.yml）。
 *
 * 坏配置一律「告警 + 回落默认值」，**绝不抛错**：DSH 启动是全有全无的，
 * 一个插件抛异常会让整个 Harness 起不来。宁可降级运行，也不能拖死宿主。
 */

export const MODES = ['fast', 'standard', 'strict']
export const CENSOR_LEVELS = ['off', 'warn', 'strict']
export const EXEC_GATES = ['off', 'ask']
/** 判定为"缺来源"时的动作：steer 强制重做（默认）/ log 只记账不打扰 */
export const CENSOR_ACTIONS = ['steer', 'log']

/** 默认配置。每一项都在 README「配置」一节里有说明。 */
export const DEFAULTS = {
  /** 默认档位：fast | standard | strict */
  mode: 'standard',
  /** 来源校验姿态：off 不校验 / warn 打回一次 / strict 最多打回两次 */
  censor: 'warn',
  /**
   * 判定为"缺来源"时做什么。
   *   - `steer`（默认）：注入纠正指令，强制模型重做一步（DSH 独有的执行级能力）
   *   - `log`：只在自检日志里记 `censor-warn`，不打扰对话
   *     （对应 trae-tamer 的"自检优先"路线：不静默重生成、决策权留在主人）
   */
  censorAction: 'steer',
  /**
   * 每 N 轮重申协议；0 = 关闭（**默认关闭**）。
   *
   * 为什么默认关：协议段是经 `ctx.systemPrompt.section()` 注册的，**每个请求都会带上**
   * （且文本稳定、不破坏提供方前缀缓存）。「每 N 轮重申」原本是给"只能注入一次"的
   * 网页插件用的补丁；在插件里它基本冗余，只会在超长上下文、注意力衰减时才有边际价值，
   * 却要额外付 token。需要时把它加大（例如 30）即可。
   */
  reinjectEvery: 0,
  /** 协议段在系统提示词中的排序位；外部贡献可用任意有限值 */
  protocolOrder: 9000,
  /** 涉及客观信息却尚未查来源就要动文件/执行命令时：off 只观察 / ask 先问一下 */
  execGate: 'off',
  /** 外部记忆库路径；留空表示自动探测 <会话 cwd>/记忆库/约定.md */
  memoryFile: '',
  /** 留痕仓库根目录；留空表示自动探测 <会话 cwd>/留痕仓库（可填绝对路径做全局仓库） */
  archiveRoot: '',
  /** 留痕时是否把 --save-file 指向的原文复制进仓库 */
  archiveCopyFiles: true,
  /**
   * 档位是否**按工作区持久化**（借鉴 trae-tamer 的每项目状态）。
   * 默认开：新会话沿用你上次在该工作区选的档位，不用每次重切；
   * 关掉则每个会话回到 config.mode。
   */
  persistMode: true,
  /**
   * 是否把当前状态原子写一份到 `<DSH_HOME>/dsh-tamer-state.json`。
   * 给人和未来的徽标一个稳定读取面（加载日志是追加式的，不适合当"当前状态"读）。
   */
  stateSnapshot: true,
  /** 客观信息关键词；留空用内置表 */
  objectiveWords: null,
  /** “已列出信息来源”的判定词；留空用内置表 */
  sourceIndicators: null,
  /** 视为“在查来源”的工具名 */
  sourceTools: ['web_search', 'web_fetch', 'read', 'grep', 'glob', 'bash'],
  /** 视为“会改动外部状态”的工具名（execGate 用） */
  mutatingTools: ['write', 'edit', 'bash', 'run_code', 'str_replace_editor'],
  /** 是否在加载时向 <DSH_HOME>/dsh-tamer-load.log 追加自检记录（诊断用，见 src/diagnostics.js） */
  diagnostics: true,
}

function warn(logger, message) {
  try {
    logger?.warn?.(`dsh-tamer: ${message}`)
  } catch {
    /* 日志失败绝不能影响加载 */
  }
}

function pickEnum(value, allowed, fallback, key, logger) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && allowed.includes(value)) return value
  warn(logger, `config.${key} 取值 ${JSON.stringify(value)} 非法（应为 ${allowed.join(' | ')}），已回落 ${fallback}`)
  return fallback
}

function pickInt(value, fallback, { min = 0, key }, logger) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'number' && Number.isInteger(value) && value >= min) return value
  warn(logger, `config.${key} 取值 ${JSON.stringify(value)} 非法（应 ≥ ${min} 的整数），已回落 ${fallback}`)
  return fallback
}

function pickNumber(value, fallback, key, logger) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'number' && Number.isFinite(value)) return value
  warn(logger, `config.${key} 取值 ${JSON.stringify(value)} 非法（应为有限数），已回落 ${fallback}`)
  return fallback
}

function pickString(value, fallback, key, logger) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string') return value
  warn(logger, `config.${key} 取值类型非法（应为字符串），已回落默认值`)
  return fallback
}

function pickStringList(value, fallback, key, logger) {
  if (value === undefined || value === null) return fallback
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)) return value
  warn(logger, `config.${key} 应为非空字符串数组，已回落默认值`)
  return fallback
}

/**
 * 把插件行里的原始 config 规范化为可用配置。
 * @param {unknown} raw - 插件行 `config:` 的原始值
 * @param {{warn?: (m: string) => void}} [logger] - 通常传 ctx.logger
 * @returns {typeof DEFAULTS}
 */
export function normalizeConfig(raw, logger) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    warn(logger, 'config 不是对象，已整块回落默认值')
  }
  return {
    mode: pickEnum(input.mode, MODES, DEFAULTS.mode, 'mode', logger),
    censor: pickEnum(input.censor, CENSOR_LEVELS, DEFAULTS.censor, 'censor', logger),
    censorAction: pickEnum(input.censorAction, CENSOR_ACTIONS, DEFAULTS.censorAction, 'censorAction', logger),
    reinjectEvery: pickInt(input.reinjectEvery, DEFAULTS.reinjectEvery, { min: 0, key: 'reinjectEvery' }, logger),
    protocolOrder: pickNumber(input.protocolOrder, DEFAULTS.protocolOrder, 'protocolOrder', logger),
    execGate: pickEnum(input.execGate, EXEC_GATES, DEFAULTS.execGate, 'execGate', logger),
    memoryFile: pickString(input.memoryFile, DEFAULTS.memoryFile, 'memoryFile', logger),
    archiveRoot: pickString(input.archiveRoot, DEFAULTS.archiveRoot, 'archiveRoot', logger),
    archiveCopyFiles: typeof input.archiveCopyFiles === 'boolean' ? input.archiveCopyFiles : DEFAULTS.archiveCopyFiles,
    persistMode: typeof input.persistMode === 'boolean' ? input.persistMode : DEFAULTS.persistMode,
    stateSnapshot: typeof input.stateSnapshot === 'boolean' ? input.stateSnapshot : DEFAULTS.stateSnapshot,
    objectiveWords: pickStringList(input.objectiveWords, DEFAULTS.objectiveWords, 'objectiveWords', logger),
    sourceIndicators: pickStringList(input.sourceIndicators, DEFAULTS.sourceIndicators, 'sourceIndicators', logger),
    sourceTools: pickStringList(input.sourceTools, DEFAULTS.sourceTools, 'sourceTools', logger),
    mutatingTools: pickStringList(input.mutatingTools, DEFAULTS.mutatingTools, 'mutatingTools', logger),
    diagnostics: typeof input.diagnostics === 'boolean' ? input.diagnostics : DEFAULTS.diagnostics,
  }
}
