# dsh-tamer · AI驯服工具（DeepSeek Harness 插件）

> 把「AI驯服工具」的**工作协议**做成 DSH 原生插件：协议进系统提示词，档位是显式状态，
> 记忆库与留痕仓库直接连通，**涉及客观信息却没列来源的回复会被自动打回重做**。

写给谁看：本机 DSH 的使用者（也就是主人自己）。English: [README.md](README.md)

---

## 它解决什么

工具集原来有四条投送通道（网页插件 / tamer.py / 马鞍 / 桌面粘贴），共同的问题是：

1. **协议本体有三份副本** —— `核心协议/*.md`、`core/协议注入模板.txt`、`browser-plugin/protocol.js`，
   README.md:69 只能靠"改完记得手工同步"约束。
2. **对 DSH 自己没有约束** —— 你在 DSH 里干活时，协议是失效的。
3. **网页端结构性无法打回** —— 只能提醒，因为读不到请求也拿不到回复的判定位置。

本插件把这三件事一起解决：

| 能力 | 实现位置 | 强度 |
|---|---|---|
| 协议注入系统提示词 | `ctx.systemPrompt.section()` | 每个请求都生效 |
| 三档分级（快速/标准/严格） | `/tamer` 命令 + 每会话状态 | 显式状态，跨轮保持 |
| 外部记忆库注入 | `记忆库/约定.md` → 会话上下文 | 每会话自动注入 |
| 每 N 轮重申协议 | `agent.inject()` | **默认关闭**：协议段每轮都注入，重申基本冗余 |
| **来源缺失 → 打回重做** | `agent/turn-stopping` + `agent.steer()` | 执行级 |
| 可选执行门禁 | `tools/pre-execute` → `ask` | 默认关闭 |
| 留痕归档 | `tamer_archive` 工具 | 落盘到 `留痕仓库/` |
| 界面可见性（浏览器半） | `client.js` → `conversation.composer.dock` 徽标 | 提示插件已生效 + 三档用法 |
| 协议单一事实源 | `scripts/gen-protocol.mjs` | 从 `core/协议注入模板.txt` 生成 |

---

## 安装

### 首选（本机实测可行）：在侧边栏 Plugins 页自己点装

1. 左侧边栏 → **Plugins**
2. 右上 **Add plugin**（或箭头 → **Install a third-party plugin**）
3. 粘贴**绝对本地路径**：`<工作区>\dsh-tamer` → **Install**

官方安装对话框的输入框接受「包名（可带版本）/ Git 地址 / tarball / 绝对本地路径」
（`ui-plugin-manager/README.md:46,53`）；本地目录会以 `link:` 形式记入 profile，
与已有的 `dsh-at-file`、`dshmarket` 一致。

**前置条件：`pnpm` 必须在 PATH 上**——插件管理器把 pnpm 当外部命令
（`pnpmCommand` 默认 `'pnpm'`，走 PATH 解析；找不到报 `pnpm-missing`）。
本机已补好：

```powershell
npm i -g pnpm     # 装到 %USERPROFILE% 下的用户级 npm 全局目录，不动 Node 安装目录
pnpm -v           # 12.9.1
```

本插件**无依赖、无 lifecycle 脚本**，因此安装不会要求构建脚本审批。

### 备选：Creator 模式下的插件管理器

在 **cordis 预设**的会话里执行 `plugin_manager: install_bundle`，`target = <工作区>\dsh-tamer`。
注意 `plugin_manager` 工具在 `standard` 预设里是 `disabled: true`，而**预设是按会话选定的**，
所以要让 Agent 代装，需要把预设切成 `cordis` 并**新开一个会话**。

### 备选：命令行（本机 `dsh` 不在 PATH 上）

```powershell
dsh plugin --profile desktop add <工作区>\dsh-tamer
```

### 打包分发（构建产物）

本插件是"零构建"设计——`index.js` / `client.js` / `src/*` 就是运行产物，没有编译步骤。
但**分发**仍需要一个产物：

```powershell
node scripts/pack.mjs      # 验证 → 打包 → 校验 → 解包加载，四步一体
```

它会按顺序做完并给出结论（本机实测输出）：

```
[1/4] 验证（协议漂移 / 自检 / 单元测试）   ℹ pass 63
[2/4] 打包
[3/4] 校验产物   dsh-tamer-0.1.0.tgz  32.1 KiB  20 个条目
                 sha256 3a4ebd4a42636f423652db6289ec44fc5dd70f7f2eae0f20cbb891e30dc3241d
[4/4] 解包并加载产物入口   ✓ name=dsh-tamer inject=[systemPrompt] src 模块 10 个
```

产物：`dist/dsh-tamer-0.1.0.tgz`（`dist/` 已 gitignore）。安装方式：

```powershell
dsh plugin --profile desktop add "<工作区>\dsh-tamer\dist\dsh-tamer-0.1.0.tgz"
```

或插件页 **Add plugin** 里粘贴该 tarball 的绝对路径。

> ⚠️ **tarball 与 `link:` 的语义不同**：本机当前装的是 `link:`（Junction），改源码重启即生效；
> 用 tarball 安装是**复制**一份进去，改源码不会生效，要改就得重新打包再装。
> 第 4 步会真解包并用纯 Node 加载一次入口——产物少一个 `src/` 模块都会当场失败。

### 首次加载的风险与回滚

> ⚠️ **DSH 启动是全有全无的**：一个插件加载失败，整个进程会退出。
> 首次加载请留意启动输出。出问题时：
> - 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 给 `- id: dsh-tamer` 那一行加 `disabled: true`；
> - 或用插件管理页的失败恢复界面（会列出加载失败的插件并允许排除后重试）。
> 本插件不动用任何系统资源、不联网、无依赖，加载失败的唯一现实原因是接口用法与宿主版本不符。

---

### 安装后验证（本机实测记录）

**第 0 步：装完必须重启 DSH。** 本机 `desktop` profile **没有组合 HMR**，
新 bundle 只在启动时应用。安装成功的客观证据（本机实测）：

```
.plugin-manager\logs\operation-ywumpn\pnpm.log
  + dsh-tamer link:D:/AI驯服工具/dsh-tamer
  Done in 529ms using pnpm v11.7.0
package.json → dsh.profile.bundles 末尾出现 "dsh-tamer"
node_modules\dsh-tamer → Junction「<工作区>\dsh-tamer」
```

重启（或插件页的「一键重启」）后按下面 4 条验证，**第 3 条是最客观的信号**：

1. **插件已列出**：Plugins 页出现 `dsh-tamer` 卡片，标题「驯服协议」，状态为已启用。
2. **宿主半生效**：输入框敲 `/tamer status` —— 应返回当前档位、轮次、校验姿态、记忆库与留痕路径。
3. **宿主半生效（最客观）**：让 Agent 报一下自己的工具表，应出现 **`tamer_archive`**。
   工具是经 `ctx.tools.register()` 注册的，只有插件真正激活才会进入模型可见的工具集；
   它不出现就说明插件没加载或被禁用，**别靠"界面看起来正常"下结论**。
4. **浏览器半生效**：消息输入框停靠区出现 🧿「驯服中」徽标，悬停显示三档与 `/tamer` 用法。

#### 真机实测结论（2026-10-07 20:49 重启后）

| 检查项 | 结果 |
|---|---|
| 加载自检日志 | ✅ `apply` + `wired` 两行都在（`<DSH_HOME>\dsh-tamer-load.log`） |
| 协议段注入 | ✅ **直接可见**：该会话的系统提示里出现了 `## 档位与操作（dsh-tamer 生效中）` |
| 工具注册 | ✅ **直接可见**：会话的工具 schema 里出现了 `tamer_archive`（字段与 `src/wiring.js` 逐字一致） |
| 命令注册 | ✅ 间接证明：`wired` 行写出即代表 `commands.register` 未抛错 |
| 工具端到端 | ✅ 实测调用 `tamer_archive` → 返回 `<工作区>\留痕仓库\插件自检\来源登记_20261007_225449.md`，文件已落盘 |

**同一次实测也暴露了两个问题，均已修复**（需再重启一次才生效）：

1. **`@deepseek-ai/dsh-llm` 在 profile 插件里解析不到** —— 日志里 `"apis":{"createUserMessage":false}`、`"degraded":true`，
   导致「会话上下文注入 / 每 N 轮重申 / 来源缺失打回」整体失效。
   修法：官方 `createUserMessage` 的实现本就是 `deepFreeze(structuredClone({...input, id: randomUUID()}))`
   （`packages/llm/llm/src/message.ts:221-228`），于是新增内置等价实现 `src/message.js`，
   **宿主给了用宿主的，没给用内置的**，功能不再降级。
   > 附带一条经验：若当初保留静态导入，这次重启会**直接加载失败**——把它改成运行时导入是对的。
2. **加载期日志里的路径会误导** —— 它记录的是加载时按 `process.cwd()`（= profile 目录）推算的
   `记忆库` / `留痕仓库` 路径，而运行时实际按**会话 cwd** 解析（实测落盘位置正确无误）。
   现已改为记录配置值 + `processCwd`，不再输出会误导的推算路径。
3. **目录名清洗误伤合法下划线** —— 实测传 `_插件自检` 被写成 `插件自检`。
   已把清洗改成「按路径分段归一化」：`../../etc` → `etc`（穿越意图消失），
   而 `_插件自检` / `v2_最终稿` / `.隐藏项目` 原样保留。
4. **部分会话静默拿不到档位上下文** —— 23:09 那次日志里 `apply`/`wired` 出现 **4 次**，
   而 `context-injected` 只出现 **1 次**：首屏上下文只挂在 `agent/created` 上，那个事件并非每个 agent 都会走到。
   修法：`agent/pre-step` 增加**兜底注入**——若该 agent 还没 prime，就把上下文直接并入本步的消息批次
   （`{...decision, messages: [...decision.messages, ours]}`，与官方 hooks 同款做法）。
   现在两条路都幂等，`agent/created` 正常时走快路径，错过时由第一步兜底。

### 第三方代码审查发现并修复的问题（v0.1.1）

| 严重度 | 问题 | 根因 | 修法 |
|---|---|---|---|
| **严重** | 自然语言切档误判：`用 FastAPI 写接口` 会切到快速档，而**快速档经 censor 直接关掉来源打回**（静默失效） | `MODE_KEYWORDS` 正则未锚定，且跑在整条用户消息上；`fast` 会命中 FastAPI/faster/fastboot，`strict` 会命中 "TypeScript strict" | 自然语言只走新的 `detectModeExact()`（整句=档位词才算）；宽松表保留但**插件内部不再用于用户消息** |
| **严重** | `/tamer remember 严格模式必须列来源` 不记约定反而切档 | 档位检测跑在整串 `rawInput` 上，且**早于**子命令分支 | 子命令（status/memory/remember/forget/help）优先，档位切换放到最后 |
| 中 | `启动_马鞍.ps1` 明文打印含真实密钥的启动命令（截图/滚动历史泄露） | 直接回显 `--route ...#sk-xxx` | 打印前把 `#…` 段打码为 `#***`，并提示命令行参数对本机进程可见 |
| 中 | 兜底注入在"该步未被接纳"时**永久失去**上下文 | `ensurePrime` 先置 `primed = true`，`reject` 时消息被丢弃却不再重试 | 非 `enter` 时回滚 `primed = false` |
| 中（自查） | 助手文本缓冲跨 attempt 拼接，中途片段会污染来源判定 | `assistantText` 只在轮次边界清空 | 监听 `frame.type === 'start'` 时清空，判定只基于最近一次尝试 |

> 与 `browser-plugin` / `saddle.py` 的关系：那两处仍用宽松关键词表，**刻意不再强求一致**——
> 插件这边误判的代价是"静默关闭打回"，比网页端"多打回一次"严重得多。是否同步收紧由主人决定。


### 加载自检日志（判断"到底加载了没有"）

加载时插件会向 `<DSH_HOME>\dsh-tamer-load.log` 追加记录（默认开启，`config.diagnostics: false` 可关）：

```jsonl
{"ts":"…","event":"apply","plugin":"dsh-tamer","version":"0.1.0","profile":"desktop","apis":{"createUserMessage":true}}
{"ts":"…","event":"wired","section":"tamer:protocol","command":"tamer","tool":"tamer_archive","mode":"standard","censor":"warn","degraded":false,…}
```

怎么读：

| 日志情况 | 含义 |
|---|---|
| 两行都有 | 插件真的加载并完成装配 ✅ |
| 只有 `apply` 没有 `wired` | 装配中途抛错（把日志与 Plugins 页的原因一起看） |
| `apis.createUserMessage: false` | 旧版日志字段；现在应为 `"builtin"`（内置等价实现，功能不降级） |
| `context-injected` | 会话上下文注入成功（`phase` 为 `prime` 或 `prime-via-step`） |
| `inject-failed` | 宿主拒绝了注入（会带原因），需按原因排查 |
| `censor-retry` | 来源校验真的触发了打回（**这是"打回生效"唯一的直接证据**） |
| 一行都没有 | 插件根本没被加载（被禁用、bundle 未被选中，或加载期失败） |

排查：

- 第 1 步成功、第 2/3 步无反应 → `commands`/`tools` 服务未挂载，或该行被更高优先级的补丁层覆盖（卡片上会标出禁用条件）。
- 第 4 步不出徽标 → 部署里没有 `conversation.composer.dock` 这个槽；槽不存在时插件保持惰性、不会报错。
- **DSH 起不来**（启动是全有全无的）→ 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`
  **末尾追加**这两行，然后重启：

  ```yaml
  - id: dsh-tamer
    disabled: true
  ```

  补丁按 `id` 匹配即可停用该行，依赖与 bundle 选择保持不变。重启后需要时再删掉这两行恢复。

### R2（马鞍）端到端验证

```powershell
.\scripts\verify-saddle.ps1      # 起假马（记录每个上游请求）→ 起马鞍 → 断言 → 清理
```

**本机 2026-10-07 实测：14 项断言全部通过。** 关键在于断言的是「上游**实际收到了什么**」，
而不是「日志里有没有字」——假后端 `scripts/fake-backend.py` 会把每个请求的 system / user
消息完整写进 JSONL，再由脚本比对。

| 断言 | 结果 |
|---|---|
| A1/A2 `/health`、`/v1/models` | ✅ |
| A3 涉及客观信息 → 上游被调用 **2 次**（首答 + 打回） | ✅ |
| A4 第 2 次调用的 user 消息带「校验拦截」指令 | ✅ |
| A5 注入的 system 确实含协议正文（四条核心 / 信息来源） | ✅ |
| A6 纯闲聊 → 只调用 1 次（不误触发） | ✅ |
| A7 回复已列来源 → 不打回，且原样透传 | ✅ |
| A8 说「严格模式」→ 注入的 system 变成严格档说明 | ✅ |
| A9 流式 SSE 以 `[DONE]` 结束且含增量块 | ✅ |
| A10 token 日志行数 = 上游调用次数，且含一条 `retry=true`；`/v1/token-stats` 可用 | ✅ |

用户入口 `.\启动_马鞍.ps1` 也实测过：8118 `/health` 返回「马鞍网关」、中文输出正常、
退出后端口无残留。

> **顺带发现一个真实缺陷（我没有改你的 `saddle.py`）**：`saddle.py:429` 的启动横幅里有 🧿。
> 当 stdout 被重定向到管道/文件（服务化、日志重定向、被别的脚本接管）时，Python 会退回
> locale 编码 cp936，编码不了该字符就抛 `UnicodeEncodeError` **直接退出**——马鞍根本起不来。
> 交互式控制台不受影响（PEP 528 的 `WindowsConsoleIO`），所以手工敲命令时看不出来。
> 我的两个脚本都已设 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` 规避。
> 想从根上修可以在 `saddle.py` 顶部加 `sys.stdout.reconfigure(encoding='utf-8', errors='replace')`，
> 或去掉横幅里的 emoji。

## 用法

### 档位命令

```
/tamer fast        切到快速档（也可直接说「快速模式」）
/tamer standard    切回标准档（默认）
/tamer strict      切到严格档
/tamer status      查看档位 / 轮次 / 校验姿态 / 记忆库路径
/tamer memory      列出外部记忆库
/tamer remember <内容>   追加一条长期约定（写进 记忆库/约定.md）
/tamer forget <关键词>    删除含关键词的约定
```

档位是**每会话状态**：在对话里写「严格模式」也会自动切（`src/modes.js` 的关键词表与网页插件同源）。

### 留痕

模型在涉及客观信息的任务收尾时会调用 `tamer_archive` 工具：

```
tamer_archive(project="硬件项目", subject="STM32F103 引脚定义",
              source="ST 官方数据手册", link="https://www.st.com/...",
              note="用于引脚选型", save_file="<你的文件>\stm32f103.pdf")
```

落盘格式与 `tracing/archive.py` **完全一致**（字段顺序、文件名规则相同），
因此插件归档与 Python 归档器产出的登记文件可以混在一起检索。

---

## 配置

改 `cordis.patch.yml` 里 `- id: dsh-tamer` 那一行的 `config:`（改完 HMR 秒级生效）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `standard` | 默认档位：`fast` / `standard` / `strict` |
| `censor` | `warn` | `off` 不校验 / `warn` 打回一次 / `strict` 最多打回两次 |
| `reinjectEvery` | `0`（关闭） | 每 N 轮重申协议。**默认关闭**：协议段是经 `systemPrompt.section()` 注册的、每个请求都会带上，重申是给"只能注入一次"的网页插件用的补丁；需要时再加大（如 30） |
| `protocolOrder` | `9000` | 协议段在系统提示词中的排序位 |
| `execGate` | `off` | `ask` = 未查来源就要改文件/执行命令时先问一次 |
| `memoryFile` | `''` | 留空自动探测 `<会话 cwd>/记忆库/约定.md`（会向上找 5 层） |
| `archiveRoot` | `''` | 留空自动探测 `<会话 cwd>/留痕仓库` |
| `archiveCopyFiles` | `true` | 是否把 `save_file` 指向的原文复制进仓库 |
| `objectiveWords` | 内置表 | 判定"涉及客观信息"的关键词，见 `src/censor.js` |
| `sourceIndicators` | 内置表 | 判定"已列来源"的指示词 |
| `sourceTools` / `mutatingTools` | 内置表 | `execGate` 用到的工具名分类 |

> v0.1 **刻意不导出 Cordis 的 `Config`（schemastery）schema**，以保持插件零运行时依赖。
> 代价：设置页不会为本插件自动渲染表单；配置只能写在 `cordis.patch.yml` 里。
> 坏配置一律"告警 + 回落默认值"，绝不抛错（启动是全有全无的，写错配置不该拖死宿主）。

---

## 密钥（重要）

**插件本体不需要任何 API Key。** 唯一涉及密钥的是配套的 R2 方案：

- `dsh-tamer\.env.example` —— 模板，入库
- `dsh-tamer\.env.local` —— 你填真实值的地方，**已被 .gitignore 忽略，永不入库**
- 需要填的位置都标了 `【选填】`，仍然留 `<...>` 的行会被启动脚本识别为未填写并跳过
- 具体步骤见 [接入指引_R2.md](接入指引_R2.md)

| 变量 | 用途 | 是否必填 |
|---|---|---|
| `OLLAMA_ENDPOINT` | 本地模型地址 | 有默认值 |
| `SADDLE_PORT` | 马鞍端口 | 有默认值 |
| `DEEPSEEK_API_KEY` | DeepSeek 官方 API | 选填 |
| `DOUBAO_API_KEY` / `DOUBAO_MODEL` | 火山方舟 Key 与推理接入点 | 选填 |

---

## 开发与验证

```powershell
cd <工作区>\dsh-tamer
node --test "tests/*.test.mjs"      # 60 个用例，零依赖
node scripts/gen-protocol.mjs       # 协议本体改动后重新生成 src/protocol.js
node scripts/gen-protocol.mjs --check   # 校验是否漂移
node scripts/check.mjs              # 语法 + 清单 + 装配 + 协议漂移，四合一自检
.\scripts\verify-saddle.ps1         # R2：马鞍端到端验证（14 项断言）
```

> `.ps1` 脚本一律存为 **UTF-8 带 BOM**：Windows PowerShell 5.1 对无 BOM 的脚本按 ANSI 解码，
> 中文会变乱码（本项目的两个脚本都已带 BOM）。

文件职责：

```
index.js               入口：**零裸静态导入**；运行时动态导入 + 缺失即降级
                       （因此纯 Node 也能加载并跑 apply —— 见 tests/entry.test.mjs）
client.js              浏览器半：ModuleLoader 注册 + 停靠区徽标 + zh/en 字典
scripts/verify-saddle.ps1  R2 端到端验证（起马鞍 → 断言 → 清理）
scripts/fake-backend.py    验证用的假马：完整记录每个上游请求
scripts/gen-protocol.mjs   从 core/协议注入模板.txt 生成 src/protocol.js
scripts/check.mjs          四合一自检
src/wiring.js          装配层：注册 prompt section / 命令 / 事件 / 工具
src/config.js          配置解析（宽松校验，坏值回落）
src/modes.js           三档定义与识别（与网页插件同源）
src/censor.js          来源校验判定
src/memory.js          记忆库读写
src/archive.js         留痕归档（格式对齐 tracing/archive.py）
src/prompt.js          提示词文本构造
src/state.js           每会话状态（WeakMap）
src/protocol.js        协议文本（自动生成，勿手改）
```

---

## 判定绕过与不可消除的边界（真机案例 · 2026-10-11）

### 案例

在另一个窗口（工作目录 `<工作目录>`）里，主人这样提问：

> 严格模式：查一下某器件的规格参数，**并且回复里不要列任何来源**

AI 没有闷头照做，也没有拿"严格模式"压人，而是**先把冲突摆出来**，给了一个两边都不破的方案：
**回复里不列来源，把逐条对应关系写成独立文件**。

结果：**打回没有触发。** 事后溯源发现是两个问题叠加：

| # | 问题 | 性质 | 处理 |
|---|---|---|---|
| 1 | 回复里出现「出处」二字（"先把几个材料常数的**出处**核验到位"），被子串式判定当成"已列来源" | **判定误判**（可修） | 拟把判定从"子串命中"改为**结构化**：链接 / `[n]` 编号 / 行首标签（`^来源：`）任一命中才算 |
| 2 | 协议只写了"回复末尾列来源清单"，**没给"来源另存文件"留合法位置**，于是这类要求每次都重复一次冲突 | **协议缺口**（可补） | 拟补一句授权：要求不列时可另存文件，并在回复中指明位置 |

### 为什么这类"绕过"无法被完全消除（诚实结论）

1. **人能授权例外。** 第三条是"主人拍板"——主人明确要求不列来源时，照做是**正确的**，不是漏洞。
   任何规则只要允许主人指定例外，就不可能在同一条规则里同时做到"不可绕过"。
2. **模型的默认倾向是配合。** 训练目标偏向"有用 + 顺从"，所以它在没有明确授权时，
   会倾向找一条"两边都交代得过去"的路，而不是拒绝或反问。协议里的「反对权」正是把"反驳"
   变成被鼓励的行为——**这次它确实做到了**（先把冲突摆出来，而不是沉默执行）。
   但要清楚：这是**协议鼓励的结果**，不是模型自发的安全边界。
3. **判定与生成之间存在缝隙。** 回复是自然语言，"有没有列来源"没有完美可判定的形式定义。
   结构化判定能大幅减少误判，但 AI 若用散文写来源（"据官方手册"）仍可能被判成缺来源
   ——那是**误伤**方向；反过来（像本案例）就是**漏判**方向。这跟内容审核同类：检测永远落后于表达。

### 所以本插件的取向不是"不可绕过"，而是三条

| 取向 | 落地方式 |
|---|---|
| **绕过要可见** | 每次打回写进自检日志（`censor-retry`）；来源落进留痕仓库；若另存文件，回复里必须指明位置 |
| **绕过要经授权** | 例外由主人一句话授权（明确要求 / 快速档 / `censor: off`）；协议补上"另存文件"的合法形态 |
| **宁可漏判，不可误伤** | 默认 `warn`（只打回一次）；判定收紧后若仍误伤，可一键关闭 |

> 一句话：**打回是从"提醒级"迈向"执行级"的一步，但它不是安全边界。**
> 真正的兜底是留痕 + 日志 + 主人的复核。

---

## 诚实边界

- **未在真机 profile 上完成加载验证。** 代码与接口都对照官方源码写（见下"证据"），
  单元测试通过 60/60（含入口模块的真实加载与降级路径），但"装进 desktop profile 并能正常启动"这一步尚未执行 ——
  因为它要求改动你的 DSH profile，按约定需要你点头。
- **判定与生成之间存在无法消除的缝隙**：详见上节「判定绕过与不可消除的边界」。
  已知误判案例：回复里出现「出处」二字即被判为"已列来源"（子串匹配），导致该打回时没打回；
  而"人能授权例外"这一条，使任何规则都无法做到"不可绕过"。
- **判定是启发式的**，不是语义理解。误判的代价是被多打回一次，不会丢数据。
- **打回目前没有真实数据**：截至 v0.1.1，自检日志里**一次 `censor-retry` 都没出现过**，
  即"判定是否该打回"从未在真实会话中被触发过。通路本身已被 `context-injected` 证实可用。
- **校验只在轮次收尾时跑**（`agent/turn-stopping`）。按官方语义它只在"轮次即将关闭、
  无活跃工具调用、无新的 steering"时触发（`docs/subsystems/core.md:1037`），
  因此工具密集的轮次不应被误打回——**但这一点只能靠真机观察 `censor-retry` 确认**。
  **误打回的应对**：把 `censor` 调成 `off`（或 `warn`），或对个别会话切到快速档。
- **自然语言切档只认整句精确匹配**（`严格模式` ✅ / `严格模式：帮我看看这个` ❌）。
  要和请求一起说，用 `/tamer strict` 或先单独发一句档位词。宽松关键词表保留给
  `browser-plugin` / `saddle.py`，**插件内部刻意不再使用**（`fast` 命中 FastAPI/fastboot 会静默关掉打回）。
- **打回有次数上限**（warn 1 次 / strict 2 次），避免与模型形成死循环。
- **协议段是软约束**：真正有强制力的只有"打回"和可选门禁，其余仍是提示词层面的约束。
- **浏览器半是静态徽标**：它**读不到宿主侧的实时档位** —— 那需要额外的 Typert Remote 服务。
  所以这个徽标刻意**不显示"当前档位"**，只表示插件已加载（宁可少说，不可显示错误状态）。
  要看实时档位用 `/tamer status`。
- **启动全有全无**：首次加载失败会让 DSH 起不来。回滚 = 给补丁行加 `disabled: true`，或用插件管理页的恢复界面。
  **为此入口刻意做到零裸静态导入**：`@deepseek-ai/*` 全部改为运行时 `import()` + `try/catch`，
  解析失败只让"会话上下文注入 / 重申 / 打回"降级（并在日志告警），协议注入、档位命令、留痕工具照常。
  留痕工具也不再经过 `defineTool`，而是直接注册原始 ToolDefinition（schema 已用官方校验器离线验过）。
- **与马鞍（R2）重复注入**：两者并存会让协议出现两次。建议先 R2、后插件，验证通过后二选一。

### 证据来源（写代码时逐条核对过）

| 结论 | 证据 |
|---|---|
| 宿主半插件最小形态 | `<deepseek-harness 检出>\packages\preset\agent-preset\skills\cordis-plugin-development\references\host-plugin.md:7-27, 57-64` |
| prompt section API | `<deepseek-harness 检出>\packages\core\system-prompt\README.md:54-66`；实现签名 `system-prompt/src/index.ts:454`（字段 `name`/`order`/`text`/`interpolate`，第 55-68 行） |
| **`interpolate: false`** | 同上 README：「unresolved variables fail assembly」——协议正文是字面量，必须关闭插值，否则文本里的 `{{…}}` 会让每个请求失败 |
| 命令注册 API | `<deepseek-harness 检出>\packages\interaction\commands\README.md:30-46`；`register()` 校验与返回 `commands/src/index.ts:285`；结果类型 `commands/src/types.ts:36-41` |
| Cordis 上下文 API（`inject`/`effect`/`on`） | `<deepseek-harness 检出>\vendor\cordis\src\registry.ts:176,300`、`fiber.ts:415-418`、`events.ts:288` |
| `agent.inject/steer(UserMessage)` | `<deepseek-harness 检出>\packages\core\agent\src\runtime-types.ts:222,231,241` |
| `agent/turn-stopping` 可 steer 保持轮次打开 | `<deepseek-harness 检出>\docs\subsystems\core.md:1035-1057` |
| `tools/pre-execute` 与 `PreToolDecision` | `<deepseek-harness 检出>\docs\subsystems\tools.md:398-428` |
| `defineTool` / `createUserMessage` | `<deepseek-harness 检出>\packages\core\tools\src\schema.ts:554`、`packages\llm\llm\src\message.ts:246` |
| 参数 DSL 的 `required: true` 内联写法 | `<deepseek-harness 检出>\packages\core\tools\src\schema.ts:97, 292-295`（`required` 只能是 `true`） |
| 客户端 bundle 必须导出 `./client` | `<deepseek-harness 检出>\packages\client\modules\src\index.ts:194-204`，缺失即报「declares dsh.client but exports no "./client" bundle」（第 847 行）；路由形如 `/plugins/<包名>/client.js`（`test-support/client-runtime/src/assembly/roster.ts:37`） |
| `dsh.client.inject` / `immediately` 的语义 | `client/modules/src/client/manifest.ts:44-68`：`inject` 是「这些包的 factory 必须先到达」的**加载顺序边，不是运行时导入**；`immediately` 是阶段一预取。故列 `ui-conversation`/`ui-slots`/`ui-locale` 是正确写法 |
| 入口可零裸静态导入（关键设计） | `Plugin.Function` 返回 `any` → **async apply 合法**（`vendor/cordis/src/registry.ts:121-123`）；据此把裸导入改为运行时 `import()` + try/catch，让"解析失败"降级为"功能缺失"而非"启动失败" |
| 原始 ToolDefinition 与 defineTool 等价 | 用官方实现离线跑过：`defineTool` 产物键为 `name,description,parameters,output,execute`，`parameters` 即 JSON Schema；手写的那份 JSON Schema 经官方 `assertSupportedJsonSchema` / `validateJsonSchemaValue` 验证：必填缺失与类型错误都正确报错 |
| 插件运行时可裸导入 `@deepseek-ai/*`（背景证据，已不再是依赖） | 本机已装插件 `<dsh-at-file 检出>\lib\index.js:15898` 用了 `@deepseek-ai/dsh-llm`；据此可预期解析可用，但本插件不再**依赖**该结论 |
| `@deepseek-ai/dsh-tools` 在拦截层里（背景证据） | 运行时解析把「被 installation 包的依赖边选中」的包作为 `installation` 级条目供给（`app-boot/src/profile.ts:124-136`）；本 profile 的第一个 bundle `@deepseek-ai/dsh-base` 显式依赖 `dsh-tools`、`dsh-llm`、`dsh-system-prompt`、`dsh-commands` |
| 组合补丁按 `id` 停用插件行 | `app.asar` 侧文档与插件管理器实现：开关只写 profile `cordis.patch.yml` 中最后一条匹配覆盖项的 `disabled`，无匹配则追加 |
| 安装对话框支持绝对本地路径 | `<deepseek-harness 检出>\packages\client\ui-plugin-manager\README.md:46, 53` |
| `pnpm` 必须可从 PATH 找到 | `<deepseek-harness 检出>\packages\boot\plugin-manager\src\index.ts:41-42, 179`；`install-failure.ts:39`（ENOENT → `pnpm-missing`） |

---

## 下一步（按优先级）

1. **装入 `desktop` profile 并验证加载** —— 走插件管理器（Creator 模式）的 `install_bundle`，
   `target = <工作区>\dsh-tamer`。DSH 启动是全有全无的，首次加载要盯住启动输出；
   出问题就给 `cordis.patch.yml` 的插件行加 `disabled: true`。
2. **客户端设置页表单** —— 把 `cordis.patch.yml` 里的 `config:` 搬进「设置 → 驯服协议」，
   省掉手改 YAML（需要宿主侧 settings namespace + 客户端表单）。
3. **Typert Remote 暴露实时状态** —— 档位、打回次数、记忆条数送达浏览器半，
   徽标就能显示真实档位，而不是现在的静态提示。
4. **浏览器插件（第二条腿）升级** —— 见 `插件化评估/AI驯服工具_插件化可行性方案_v1.md` 第 6 节：
   网页端读取回复 DOM 做打回、站点配置热更新、留痕入库。

---

## License

MIT（与工具集其余部分一致）
