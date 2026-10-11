<#
.SYNOPSIS
  启动马鞍网关（AI驯服工具 · R2：把马鞍接成 DSH 的模型提供方）。

.DESCRIPTION
  马鞍 = saddle.py，一个 OpenAI 兼容的本地代理：协议注入、三档、外部记忆、
  来源缺失自动打回、token 计量。它夹在 DSH 和真实模型之间，因此对 DSH 是
  「执行级」约束，而不是提示词级提醒。

  本脚本只做一件事：按 .env.local 里的配置把马鞍启动起来，
  然后打印「在 DSH 设置里该填什么」。它不会改动你的 DSH 配置。

  需要 Python（本机已装 3.11）与 ..\saddle\saddle.py。

.PARAMETER Port
  马鞍监听端口；留空则用 .env.local 的 SADDLE_PORT（默认 8118）。

.PARAMETER OnlyLocal
  只接本地 Ollama，忽略 .env.local 里的云端密钥。

.PARAMETER CensorOff
  关闭马鞍的来源校验（默认开启）。

.EXAMPLE
  .\启动_马鞍.ps1
  .\启动_马鞍.ps1 -Port 8118 -OnlyLocal
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [switch]$OnlyLocal,
  [switch]$CensorOff
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $here '.env.local'
$envExample = Join-Path $here '.env.example'
$saddlePy = Join-Path (Split-Path -Parent $here) 'saddle\saddle.py'

function Write-Step([string]$text) { Write-Host "  $text" -ForegroundColor Gray }
function Write-Ok([string]$text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Warn2([string]$text) { Write-Host "  [!] $text" -ForegroundColor Yellow }
function Write-Err([string]$text) { Write-Host "  [x] $text" -ForegroundColor Red }

Write-Host ''
Write-Host '  ============================================================' -ForegroundColor Cyan
Write-Host '    AI驯服工具 · 马鞍网关启动器 (R2)' -ForegroundColor Cyan
Write-Host '  ============================================================' -ForegroundColor Cyan

# ── 0. 前置检查 ────────────────────────────────────────────────
if (-not (Test-Path $saddlePy)) {
  Write-Err "找不到马鞍：$saddlePy"
  Write-Step '请确认本脚本位于 AI驯服工具\dsh-tamer\ 目录下。'
  exit 1
}
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command py -ErrorAction SilentlyContinue }
if (-not $python) {
  Write-Err '找不到 Python，请先安装 Python 3 并加入 PATH。'
  exit 1
}
Write-Ok "马鞍：$saddlePy"
Write-Ok "Python：$($python.Source)"

# ── 1. 读取 .env.local ────────────────────────────────────────
$cfg = @{}
if (-not (Test-Path $envFile)) {
  Write-Warn2 "未找到 $envFile"
  Write-Step "请先把它从 .env.example 复制过来，并按注释填写。"
} else {
  # 注意：Windows PowerShell 5.1 的 Get-Content 默认按 ANSI 解码，必须显式 UTF8，
  # 否则中文注释会乱码（值本身是 ASCII，不受影响）。
  foreach ($line in (Get-Content -LiteralPath $envFile -Encoding UTF8)) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
    $idx = $trimmed.IndexOf('=')
    if ($idx -lt 1) { continue }
    $key = $trimmed.Substring(0, $idx).Trim()
    $value = $trimmed.Substring($idx + 1).Trim()
    $cfg[$key] = $value
  }
  Write-Ok "已读取 .env.local（$($cfg.Count) 项）"
}

function Get-Cfg([string]$name, [string]$fallback) {
  if ($cfg.ContainsKey($name) -and $cfg[$name] -ne '') { return $cfg[$name] }
  return $fallback
}
# 占位符形如 <在此填入...> —— 视同未填写
function Test-Placeholder([string]$value) {
  return ($value -match '^<.*>$')
}

if ($Port -le 0) { $Port = [int](Get-Cfg 'SADDLE_PORT' '8118') }
$ollama = Get-Cfg 'OLLAMA_ENDPOINT' 'http://localhost:11434'

# ── 2. 组装路由（马匹） ────────────────────────────────────────
$routes = @()
$routes += "ollama=ollama@$ollama"
Write-Step "本地马：ollama -> $ollama"

if (-not $OnlyLocal) {
  $dsKey = Get-Cfg 'DEEPSEEK_API_KEY' ''
  if ($dsKey -eq '' ) {
    Write-Step 'DeepSeek 官方：未配置（跳过）'
  } elseif (Test-Placeholder $dsKey) {
    Write-Warn2 'DeepSeek 官方：.env.local 里还是占位符 <...>，已跳过 —— 需要就填上真实 Key'
  } else {
    $dsEndpoint = Get-Cfg 'DEEPSEEK_ENDPOINT' 'https://api.deepseek.com/v1'
    $routes += "deepseek=openai@$dsEndpoint#$dsKey"
    Write-Ok "DeepSeek 官方：已接入（$dsEndpoint）"
  }

  $dbKey = Get-Cfg 'DOUBAO_API_KEY' ''
  if ($dbKey -eq '') {
    Write-Step '豆包/方舟：未配置（跳过）'
  } elseif (Test-Placeholder $dbKey) {
    Write-Warn2 '豆包/方舟：.env.local 里还是占位符 <...>，已跳过'
  } else {
    $dbEndpoint = Get-Cfg 'DOUBAO_ENDPOINT' 'https://ark.cn-beijing.volces.com/api/v3'
    $routes += "doubao=openai@$dbEndpoint#$dbKey"
    Write-Ok "豆包/方舟：已接入（$dbEndpoint）"
  }
}

# ── 3. 启动马鞍 ────────────────────────────────────────────────
$saddleArgs = @($saddlePy, '--port', "$Port")
foreach ($route in $routes) { $saddleArgs += @('--route', $route) }
$saddleArgs += @('--default', 'ollama')
if ($CensorOff) { $saddleArgs += @('--censor', 'off') }

Write-Host ''
# 打印时**给密钥打码**：route 形如 `名字=类型@地址#真实密钥`，
# 原样回显会泄露到终端滚动历史、截图和共享日志里。
$displayArgs = $saddleArgs | ForEach-Object { $_ -replace '#.+$', '#***' }
Write-Host "  启动命令：python $($displayArgs -join ' ')" -ForegroundColor DarkGray
Write-Host '  （上面密钥已打码；真实密钥只作为参数传给马鞍，本脚本不回显、不落盘）' -ForegroundColor DarkGray
Write-Host '  ⚠️ 命令行参数对本机其他进程可见（Windows 无 argv 隐藏）；介意的话请改用只读当前用户的包装脚本。' -ForegroundColor DarkGray
Write-Host '  （按 Ctrl+C 停止马鞍）' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  ------------------------------------------------------------' -ForegroundColor Cyan
Write-Host '  接下来在 DSH 里做这三步（本脚本不会替你改配置）：' -ForegroundColor Cyan
Write-Host '  ------------------------------------------------------------' -ForegroundColor Cyan
Write-Host "   1) 打开 设置 -> 模型 -> 添加提供方" -ForegroundColor White
Write-Host "   2) 自定义 baseURL 填： http://127.0.0.1:$Port/v1" -ForegroundColor White
Write-Host '      API Key 随便填（例如 saddle；真正的密钥在 .env.local 里，由马鞍持有）' -ForegroundColor Gray
Write-Host '   3) 模型名用「马名/真实模型名」选马，例如：' -ForegroundColor White
Write-Host '        ollama/qwen2.5        -> 本地 Ollama' -ForegroundColor Gray
if ($routes.Count -gt 1) { Write-Host '        deepseek/deepseek-chat -> DeepSeek 官方' -ForegroundColor Gray }
Write-Host '' -ForegroundColor Gray
Write-Host "   验证：浏览器打开 http://127.0.0.1:$Port/v1/models 与 /v1/token-stats" -ForegroundColor Gray
Write-Host '   详细说明见同目录 接入指引_R2.md' -ForegroundColor Gray
Write-Host ''

# 让 Python 的 stdio 固定为 UTF-8。原因（本机实测）：
# 马鞍的启动横幅里有 🧿（saddle.py:429）；一旦 stdout 不是交互式控制台
# （重定向到管道/文件、被别的进程接管），Python 会退回 locale 编码 cp936，
# 该字符编码不了就抛 UnicodeEncodeError 直接退出，马鞍根本起不来。
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

& $python.Source @saddleArgs
