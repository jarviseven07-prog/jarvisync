param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskData = Join-Path $taskRoot 'data'
$taskServer = Join-Path $taskRoot 'server/index.mjs'
$taskEvidence = Join-Path $taskRoot 'artifacts/agent-onboarding-qa'

. (Join-Path $taskRoot 'scripts/verified-update.ps1')

$taskNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $taskNode) { $taskNode = Join-Path $env:ProgramFiles 'nodejs/node.exe' }
if (-not (Test-Path -LiteralPath $taskNode -PathType Leaf)) { throw '没有找到 Node.js，暂时无法核对已验证构建。' }
$taskCandidate = Get-JarviSyncVerifiedCandidate -Root $taskRoot -NodeExecutable $taskNode
if (-not $taskCandidate) { throw '没有发现待加载的已验证构建。' }
if (Test-JarviSyncInvalidCandidate $taskCandidate) { throw ('待加载构建未通过核对：' + $taskCandidate.Reason) }

if ($ValidateOnly) {
    $taskRuntime = Get-JarviSyncRuntimeState -DataDir $taskData -Port 4317 -ServerEntry $taskServer
    $taskRunningPid = if ($taskRuntime) { $taskRuntime.Lock.pid } else { $null }
    $taskRunningBuildId = if ($taskRuntime) { Get-JarviSyncHealthBuildId $taskRuntime.Health } else { $null }
    [pscustomobject]@{ verified = $true; buildId = $taskCandidate.BuildId; files = $taskCandidate.FileCount; runningPid = $taskRunningPid; runningBuildId = $taskRunningBuildId; pending = (-not $taskRuntime -or $taskRunningBuildId -cne $taskCandidate.BuildId) } | ConvertTo-Json -Compress
    return
}

$taskLoaded = Invoke-JarviSyncVerifiedUpdate -Candidate $taskCandidate -DataDir $taskData -Port 4317 -NodeExecutable $taskNode -ServerEntry $taskServer
$taskLoaded | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskEvidence 'production-loaded.json') -Encoding UTF8
Write-Output '已加载已验证构建，原看板记录保持不变。通过日常开始菜单入口打开 JarviSync。'
