/**
 * dsh-tamer · 浏览器半（Web GUI）
 *
 * 由 Web 服务在 /plugins/dsh-tamer/client.js 提供。格式由 DSH 客户端模块加载器约定：
 * `window.__ModuleLoader__.load({ id, factory })`，**id 必须等于包名**，
 * factory 返回一个 `{ inject, apply }` 的客户端插件（参考官方模板
 * templates/decoration/client.js 与本机已装插件 dsh-at-file）。
 *
 * 本文件贡献一个 composer 停靠区的小徽标，让「驯服协议正在生效」这件事在界面上可见，
 * 并把三个档位和 /tamer 用法作为悬停提示。
 *
 * 诚实边界（刻意为之）：浏览器半**读不到宿主侧的实时档位**——那需要额外的
 * Typert Remote 服务（见 README 的「下一步」）。所以这个徽标**不宣称当前档位**，
 * 只表示插件已加载。宁可少说，不可显示错误状态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tamer',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 语言命名空间 id：与包名一致，避免与其他插件撞键。 */
    const NS = 'dsh-tamer'

    // 扁平点分键；zh 是产品文案的键集来源，en 必须键集完整（与 dsh-at-file 的约定一致）。
    const zh = {
      'dock.label': '驯服中',
      'dock.aria': 'AI驯服工具已生效',
      'dock.hint':
        'AI驯服工具已生效：工作协议已注入系统提示词。\n'
        + '· /tamer fast|standard|strict 切换档位（每会话状态）\n'
        + '· 涉及客观信息时，回复末尾必须列「信息来源」\n'
        + '· 未列来源的回复会被自动打回重做（warn：1 次 / strict：2 次）',
    }

    const en = {
      'dock.label': 'Taming',
      'dock.aria': 'AI Taming Tool is active',
      'dock.hint':
        'AI Taming Tool is active: the work protocol is injected into the system prompt.\n'
        + '· /tamer fast|standard|strict switches the mode (per session)\n'
        + '· Whenever factual claims are involved, sources must be listed at the end\n'
        + '· An answer without sources is sent back for revision (warn: once / strict: twice)',
    }

    /**
     * 取翻译函数：优先用客户端 locale 服务，服务不可用时退回本文件的字典
     * （宁可显示原文，也不能因缺服务而让徽标渲染失败）。
     */
    function makeTranslator(ctx) {
      try {
        const bound = ctx.locale.bind(NS)
        if (typeof bound === 'function') {
          return (key) => {
            const text = bound(key)
            return text === undefined || text === null || text === key ? (zh[key] ?? en[key] ?? key) : text
          }
        }
      } catch {
        /* 退回本地字典 */
      }
      return (key) => zh[key] ?? en[key] ?? key
    }

    function createDock(t) {
      /** 纯展示徽标：不拦截指针事件，不改动宿主容器样式，颜色继承主题。 */
      return function TamerDock() {
        return h(
          'div',
          {
            title: t('dock.hint'),
            'aria-label': t('dock.aria'),
            role: 'status',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
              lineHeight: 1.4,
              color: 'inherit',
              opacity: 0.72,
              pointerEvents: 'none',
              userSelect: 'none',
              whiteSpace: 'nowrap',
            },
          },
          h('span', { 'aria-hidden': true }, '\uD83E\uDDED'),
          h('span', null, t('dock.label')),
        )
      }
    }

    return {
      /** 需要的客户端服务：槽位系统与文案服务。 */
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 字典注册是拥有型副作用：卸载插件时随之移除
        ctx.effect(() => ctx.locale.register(NS, { zh, en }))
        const t = makeTranslator(ctx)
        // conversation.composer.dock 是官方模板选定的停靠槽：它自身已分配空间，
        // 不需要围绕宿主控件做定位。槽不存在时 inject 不会触发，插件保持惰性，不会报错。
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: NS, order: 30 },
          createDock(t),
        ))
      },
    }
  },
})
