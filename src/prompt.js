/**
 * dsh-tamer · 提示词文本构造
 *
 * 三层文本，职责分明：
 *  1. 协议段（全局、静态）——进系统提示词，所有 Agent 共享，保持字节稳定以利前缀缓存。
 *  2. 会话上下文（每 Agent）——当前档位 + 外部记忆库，用 agent.inject 注入。
 *  3. 重申文本——每 N 轮注入一次，缓解长会话遗忘。
 */
import { PROTOCOL_TEXT } from './protocol.js'
import { modeHint, normalizeMode } from './modes.js'
import { memoryBlock } from './memory.js'

/** 插件自述片段：告诉模型「档位怎么切、来源清单怎么列」。 */
export const PLUGIN_NOTES = [
  '## 档位与操作（dsh-tamer 生效中）',
  '- 主人可用 `/tamer fast|standard|strict` 切换档位，命令即时生效。',
  '- 当前档位会在每次请求的会话上下文中告知你；未特别说明时按该档位执行。',
  '- 涉及客观信息时，回复末尾必须整理「信息来源」清单（名称 + 链接 + 对应结论）；查不到就写「未找到可靠来源」。',
  '- 主人的长期约定存放在 `记忆库/约定.md`，会自动注入；不要绕过它。',
].join('\n')

/**
 * 系统提示词里的协议段。**刻意保持纯静态**：文本一变，提供方前缀缓存即失效。
 * @returns {string}
 */
export function protocolSectionText() {
  return `${PROTOCOL_TEXT}\n\n${PLUGIN_NOTES}`
}

/**
 * 会话上下文块（档位 + 记忆库），通过 agent.inject 成为模型可见的上下文。
 * @param {string} mode
 * @param {string[]} memoryEntries
 * @returns {string}
 */
export function modeContextText(mode, memoryEntries = []) {
  const normalized = normalizeMode(mode)
  const lines = [`（dsh-tamer 会话上下文）当前档位：${modeHint(normalized)}。`]
  const block = memoryBlock(memoryEntries)
  if (block) lines.push('', block)
  return lines.join('\n')
}

/** 每 N 轮重申文本（措辞与 saddle.py:387-390 一致）。 */
export function reinforceText(mode) {
  const normalized = normalizeMode(mode)
  return (
    '（协议重申）请继续遵守工作协议：①信息不清先澄清；'
    + '②客观信息只用官方/可靠来源、正文标注来源、回复末尾列「信息来源」清单、查不到明说不编造；'
    + '③你决策，我只推荐与执行；④实现→我测试→你再迭代。'
    + `当前档位：${modeHint(normalized)}。若本条涉及客观信息，请在末尾整理信息来源。`
  )
}
