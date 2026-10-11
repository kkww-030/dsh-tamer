<#
.SYNOPSIS
  验证马鞍（saddle.py）真的在做事——端到端、可重复、失败即非零退出。

.DESCRIPTION
  马鞍是 R2 的核心：把 DSH 的模型请求接到本地代理上，从而获得执行级约束。
  本脚本在本机起一个"假马"（scripts/fake-backend.py，会把每个上游请求完整记进 JSONL），
  再起马鞍指向它，然后逐条断言：

    A1 马鞍 /health 正常
    A2 /v1/models 列出可用的马
    A3 涉及客观信息的提问 → 上游被调用 2 次（第 2 次是打回重做）
    A4 打回那一次的 user 消息里带了校验指令（「校验拦截」）
    A5 注入的 system 消息里确实有协议正文与档位说明
    A6 纯闲聊 → 只调用 1 次（不误触发打回）
    A7 回复已列出来源 → 不触发打回
    A8 说「严格模式」→ 注入的 system 档位变成严格档
    A9 流式请求 → 前端拿到 SSE 且以 [DONE] 结束
    A10 token 日志行数 = 上游调用次数，且含一条 retry=true；/v1/token-stats 可用

  与 saddle/_selftest.sh 的关系：那个脚本是 bash+curl 版（本机是 Windows，跑不通）；
  这里用 PowerShell 重写并**加强**——断言的是"上游实际收到了什么"，而不是日志里有没有字。

  本脚本只读 ../saddle/ 下的文件、只在临时目录写日志、结束后杀掉自己起的进程。

.EXAMPLE
  .\scripts\verify-saddle.ps1
  .\scripts\verify-saddle.ps1 -SaddlePort 8123 -FakePort 12322
#>
[CmdletBinding()]
param(
  [int]$SaddlePort = 8122,
  [int]$FakePort = 12321
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginRoot = Split-Path -Parent $here
$repoRoot = Split-Path -Parent $pluginRoot
$saddlePath = Join-Path $repoRoot 'saddle\saddle.py'
$fakePath = Join-Path $here 'fake-backend.py'

$script:pass = 0
$script:fail = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) {
    Write-Host ('  [PASS] ' + $name) -ForegroundColor Green
    $script:pass++
  } else {
    Write-Host ('  [FAIL] ' + $name) -ForegroundColor Red
    if ($detail) { Write-Host ('         ' + $detail) -ForegroundColor DarkGray }
    $script:fail++
  }
}

if (-not (Test-Path $saddlePath)) { Write-Host ('找不到马鞍: ' + $saddlePath) -ForegroundColor Red; exit 2 }
if (-not (Test-Path $fakePath)) { Write-Host ('找不到假后端: ' + $fakePath) -ForegroundColor Red; exit 2 }
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $python) { Write-Host '找不到 python' -ForegroundColor Red; exit 2 }

# 必须让 Python 的 stdio 固定为 UTF-8：马鞍的启动横幅里有 🧿（saddle.py:429），
# 当 stdout 被重定向到管道/文件时 Python 会退回本机 locale 编码（cp936），
# 编码不了该字符就直接 UnicodeEncodeError 退出——本脚本正是重定向输出，会踩到。
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

$tmp = Join-Path $env:TEMP ('dsh-tamer-verify-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$reqLog = Join-Path $tmp 'requests.jsonl'
$tokLog = Join-Path $tmp 'tokens.jsonl'
$saddleBase = 'http://127.0.0.1:' + $SaddlePort
$chatUrl = $saddleBase + '/v1/chat/completions'
$fakeBase = 'http://127.0.0.1:' + $FakePort

function Get-Json([string]$url) {
  return Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 5
}
function Get-Records([string]$path) {
  if (-not (Test-Path $path)) { return @() }
  $lines = Get-Content -LiteralPath $path -Encoding UTF8 | Where-Object { $_.Trim() -ne '' }
  return @($lines | ForEach-Object { $_ | ConvertFrom-Json })
}
function Get-CallCount {
  try { return [int](Get-Json ($fakeBase + '/health')).calls } catch { return -1 }
}
function Send-Chat([object]$body) {
  $json = $body | ConvertTo-Json -Depth 10 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Uri $chatUrl -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 30
}
function New-ChatBody([string]$text, [switch]$Stream) {
  return @{
    model = 'fake/m1'
    stream = [bool]$Stream
    messages = @(@{ role = 'user'; content = $text })
  }
}

$fakeProc = $null
$saddleProc = $null
try {
  Write-Host ''
  Write-Host '=== 启动假马与马鞍 ===' -ForegroundColor Cyan
  $fakeProc = Start-Process -FilePath $python -ArgumentList @($fakePath, $reqLog, "$FakePort") -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $tmp 'fake.out') -RedirectStandardError (Join-Path $tmp 'fake.err')
  $saddleProc = Start-Process -FilePath $python -ArgumentList @(
    $saddlePath, '--route', ('fake=openai@http://127.0.0.1:' + $FakePort + '/v1'), '--port', "$SaddlePort", '--token-log', $tokLog
  ) -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $tmp 'saddle.out') -RedirectStandardError (Join-Path $tmp 'saddle.err')

  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try { $null = Get-Json ($fakeBase + '/health'); $null = Get-Json ($saddleBase + '/health'); $ready = $true; break } catch { }
  }
  if (-not $ready) {
    Write-Host '马鞍或假马 10 秒内未就绪；stderr 摘录如下：' -ForegroundColor Red
    foreach ($f in 'saddle.err', 'fake.err', 'saddle.out') {
      $p = Join-Path $tmp $f
      if (Test-Path $p) { Write-Host ("--- " + $f + " ---"); Get-Content $p -Encoding UTF8 -Tail 15 }
    }
    exit 2
  }
  Write-Host ('  临时目录: ' + $tmp) -ForegroundColor DarkGray

  Write-Host ''
  Write-Host '=== A1/A2 健康与模型列表 ===' -ForegroundColor Cyan
  try { $h = Get-Json ($saddleBase + '/health'); Check 'A1 马鞍 /health 返回 ok' ($h.status -eq 'ok') ($h | ConvertTo-Json -Compress) } catch { Check 'A1 马鞍 /health 返回 ok' $false $_.Exception.Message }
  try { $m = Get-Json ($saddleBase + '/v1/models'); $ids = @($m.data | ForEach-Object { $_.id }); Check 'A2 /v1/models 列出 fake 马' (($ids -join ',') -match 'fake') ($ids -join ',') } catch { Check 'A2 /v1/models 列出 fake 马' $false $_.Exception.Message }

  Write-Host ''
  Write-Host '=== A3/A4/A5 客观信息 + 无来源 → 打回重做 ===' -ForegroundColor Cyan
  $before = Get-CallCount
  $null = Send-Chat (New-ChatBody '帮我查某芯片 GPIO 引脚定义')
  $after = Get-CallCount
  $delta = $after - $before
  Check 'A3 上游被调用 2 次（首答 + 打回）' ($delta -eq 2) ('实际 ' + $delta + ' 次')
  $records = Get-Records $reqLog
  $first = $records[$before]
  $second = $records[$before + 1]
  if ($second) {
    Check 'A4 第 2 次调用带校验拦截指令' ($second.last_user -match '校验拦截') ($second.last_user)
  } else { Check 'A4 第 2 次调用带校验拦截指令' $false '没有第 2 条记录' }
  if ($first) {
    $sysOk = ($first.system -match '信息来源') -and ($first.system -match '四条核心')
    Check 'A5 注入的 system 含协议正文' $sysOk ($first.system.Substring(0, [Math]::Min(80, $first.system.Length)))
  } else { Check 'A5 注入的 system 含协议正文' $false '没有第 1 条记录' }

  Write-Host ''
  Write-Host '=== A6 闲聊不误触发 ===' -ForegroundColor Cyan
  $before = Get-CallCount
  $null = Send-Chat (New-ChatBody '你好，今天天气不错')
  $delta = (Get-CallCount) - $before
  Check 'A6 纯闲聊只调用 1 次' ($delta -eq 1) ('实际 ' + $delta + ' 次')

  Write-Host ''
  Write-Host '=== A7 已列来源不打回 ===' -ForegroundColor Cyan
  $before = Get-CallCount
  $r = Send-Chat (New-ChatBody '该芯片引脚定义是什么 [SOURCED]')
  $delta = (Get-CallCount) - $before
  Check 'A7 回复已含来源 → 只调用 1 次' ($delta -eq 1) ('实际 ' + $delta + ' 次')
  Check 'A7b 回复原样透传给前端' ($r.choices[0].message.content -match '信息来源') ('')

  Write-Host ''
  Write-Host '=== A8 档位切换（严格模式）===' -ForegroundColor Cyan
  $before = Get-CallCount
  $body = @{
    model = 'fake/m1'
    messages = @(
      @{ role = 'user'; content = '严格模式' },
      @{ role = 'user'; content = '该寄存器的规格参数是什么' }
    )
  }
  $null = Send-Chat $body
  $records = Get-Records $reqLog
  $strict = $records[$before]
  if ($strict) {
    Check 'A8 严格档说明已注入 system' ($strict.system -match '完整可行性') ('system 尾部: ' + $strict.system.Substring([Math]::Max(0, $strict.system.Length - 60)))
  } else { Check 'A8 严格档说明已注入 system' $false '没有记录' }

  Write-Host ''
  Write-Host '=== A9 流式 ===' -ForegroundColor Cyan
  $sseText = ''
  try {
    $json = (New-ChatBody '随便聊聊' -Stream) | ConvertTo-Json -Depth 10 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $sse = Invoke-WebRequest -Uri $chatUrl -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 30 -UseBasicParsing
    $sseText = [string]$sse.Content
  } catch { $sseText = ''; Write-Host ('         ' + $_.Exception.Message) -ForegroundColor DarkGray }
  Check 'A9 SSE 以 [DONE] 结束' ($sseText -match '\[DONE\]') ($sseText.Substring(0, [Math]::Min(80, $sseText.Length)))
  Check 'A9b SSE 含增量内容块' ($sseText -match '"delta"') ''

  Write-Host ''
  Write-Host '=== A10 token 计量 ===' -ForegroundColor Cyan
  $calls = Get-CallCount
  $tokRecords = Get-Records $tokLog
  Check 'A10 日志行数 = 上游调用次数' ($tokRecords.Count -eq $calls) ('日志 ' + $tokRecords.Count + ' 行 / 调用 ' + $calls + ' 次')
  $retries = @($tokRecords | Where-Object { $_.retry -eq $true })
  Check 'A10b 至少一条 retry=true（打回被记账）' ($retries.Count -ge 1) ('retry 条数 ' + $retries.Count)
  try { $stats = Get-Json ($saddleBase + '/v1/token-stats'); Check 'A10c /v1/token-stats 返回总数' ($stats.total.total_tokens -gt 0) ($stats.total.total_tokens) } catch { Check 'A10c /v1/token-stats 返回总数' $false $_.Exception.Message }

  Write-Host ''
  Write-Host '===================================================' -ForegroundColor Cyan
  if ($script:fail -eq 0) { Write-Host ('  全部通过：' + $script:pass + ' 项') -ForegroundColor Green } else { Write-Host ('  通过 ' + $script:pass + ' 项，失败 ' + $script:fail + ' 项') -ForegroundColor Red }
  Write-Host ('  日志留档: ' + $tmp) -ForegroundColor DarkGray
  Write-Host ''
}
finally {
  foreach ($p in @($saddleProc, $fakeProc)) {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
}
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
