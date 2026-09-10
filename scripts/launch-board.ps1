$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$taskData = Join-Path $taskRoot 'data'
$taskLogDir = Join-Path $taskData 'launcher'
$taskUrl = 'http://127.0.0.1:4317'
$taskDesktopProfile = Join-Path $taskData 'desktop-profile'
$taskDesktopReady = Join-Path $taskDesktopProfile 'workspace-ready.json'
$taskServer = Join-Path $taskRoot 'server/index.mjs'
$taskElectron = Join-Path $taskRoot 'node_modules/electron/dist/electron.exe'
$taskMutex = $null
$taskOwnsMutex = $false

. (Join-Path $taskRoot 'scripts/verified-update.ps1')

function Get-BoardListener {
    @(Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue)
}

function Test-BoardService {
    try {
        $taskLock = Get-Content -LiteralPath (Join-Path $taskData 'server.lock') -Raw | ConvertFrom-Json
        $taskListeners = @(Get-BoardListener)
        if ($taskListeners.Count -eq 0 -or @($taskListeners | Where-Object { $_.OwningProcess -ne $taskLock.pid }).Count -gt 0) { return $false }
        $taskBoard = Invoke-RestMethod -Uri ($taskUrl + '/api/board') -TimeoutSec 2
        return $taskBoard.schemaVersion -eq 1 -and $null -ne $taskBoard.projects -and $null -ne $taskBoard.nodes -and $null -ne $taskBoard.revision
    } catch { return $false }
}

function Get-DesktopReadyState {
    try {
        # Windows PowerShell 5 otherwise decodes this UTF-8 JSON with the ANSI
        # code page and corrupts the Chinese workspace path.
        $taskState = Get-Content -LiteralPath $taskDesktopReady -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($taskState.mode -cne 'workspace' -or $taskState.ready -ne $true -or $taskState.url -cne $taskUrl -or $taskState.profile -ine $taskDesktopProfile) { return $null }
        $taskProcess = Get-Process -Id $taskState.pid -ErrorAction Stop
        if ($taskProcess.Path -ine $taskElectron) { return $null }
        if ($taskProcess.MainWindowHandle -eq 0 -or $taskProcess.MainWindowTitle -notlike 'JarviSync*') { return $null }
        return $taskState
    } catch { return $null }
}

function Close-PrePromotionDesktop {
    param($taskState, [string]$taskBuildId, [string]$taskDesktopShellId, [switch]$LegacyOnly)
    if (-not $taskState) { return }
    $taskStateBuildId = if ($taskState.PSObject.Properties['buildId']) { $taskState.buildId } else { $null }
    $taskShellMatches = -not $taskDesktopShellId -or ($taskState.PSObject.Properties['desktopShellId'] -and $taskState.desktopShellId -ceq $taskDesktopShellId)
    if ($LegacyOnly -and $taskState.PSObject.Properties['buildId'] -and $taskShellMatches) { return }
    if ($taskStateBuildId -ceq $taskBuildId -and $taskShellMatches) { return }
    # Re-read and validate the exact workspace/profile/PID before asking the
    # old window to close. Never force-kill it: unsaved UI input must win.
    $taskConfirmed = Get-DesktopReadyState
    if (-not $taskConfirmed -or $taskConfirmed.pid -ne $taskState.pid) { return }
    $taskProcess = Get-Process -Id $taskConfirmed.pid -ErrorAction Stop
    $null = $taskProcess.CloseMainWindow()
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $taskDeadline) {
        try { Get-Process -Id $taskConfirmed.pid -ErrorAction Stop | Out-Null } catch { return }
        Start-Sleep -Milliseconds 200
    }
    throw '看板已加载新版服务，但当前窗口可能有未保存内容，未强制关闭。请先保存或关闭当前 JarviSync 窗口后再次打开。'
}

try {
    [IO.Directory]::CreateDirectory($taskLogDir) | Out-Null
    $taskHash = [Security.Cryptography.SHA256]::Create()
    try { $taskKey = [BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 16) }
    finally { $taskHash.Dispose() }
    $taskMutex = New-Object Threading.Mutex($false, ('Local\JarviSync.Launcher.' + $taskKey))
    try { $taskOwnsMutex = $taskMutex.WaitOne(30000) }
    catch [Threading.AbandonedMutexException] { $taskOwnsMutex = $true }
    if (-not $taskOwnsMutex) { throw '看板正在启动，请稍等片刻再双击。' }

    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist/index.html') -PathType Leaf)) {
        throw '看板页面文件尚未准备好。请让维护者在 nodeboard 目录运行 npm run build 后再打开。'
    }

    $taskNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $taskNode) { $taskNode = Join-Path $env:ProgramFiles 'nodejs/node.exe' }
    if (-not (Test-Path -LiteralPath $taskNode -PathType Leaf)) { throw '没有找到 Node.js，暂时无法启动看板。请让维护者检查 Node.js 安装。' }
    $taskDesktopBeforePromotion = if (Test-Path -LiteralPath $taskElectron -PathType Leaf) { Get-DesktopReadyState } else { $null }
    $taskPromotion = $null
    $taskCandidateAlreadyLoaded = $false
    $taskCandidate = Get-JarviSyncVerifiedCandidate -Root $taskRoot -NodeExecutable $taskNode
    if (-not $taskCandidate) {
        $taskRunning = Get-JarviSyncRuntimeState -DataDir $taskData -Port 4317 -ServerEntry $taskServer
        if (-not $taskRunning) { throw '没有发现已验证的待加载构建，且没有可核对的现有服务；未启动当前开发文件。' }
    } elseif (Test-JarviSyncInvalidCandidate $taskCandidate) {
        # A stale manifest must never promote the files currently on disk.  An
        # already-running, identity-checked board remains safe to open.
        $taskRunning = Get-JarviSyncRuntimeState -DataDir $taskData -Port 4317 -ServerEntry $taskServer
        if (-not $taskRunning) { throw ('已验证候选构建不再匹配，未启动开发中的文件：' + $taskCandidate.Reason) }
    } elseif ($taskCandidate) {
        $taskRunning = Get-JarviSyncRuntimeState -DataDir $taskData -Port 4317 -ServerEntry $taskServer
        if (-not $taskRunning -or (Get-JarviSyncHealthBuildId $taskRunning.Health) -cne $taskCandidate.BuildId) {
            # A verified candidate is only loaded through the shared routine:
            # validate, backup, replace the frontend, restart, then read back.
            $taskPromotion = Invoke-JarviSyncVerifiedUpdate -Candidate $taskCandidate -DataDir $taskData -Port 4317 -NodeExecutable $taskNode -ServerEntry $taskServer
        } else {
            $taskCandidateAlreadyLoaded = $true
        }
    }

    $taskStarted = $null
    if (-not (Test-BoardService)) {
        throw '现有服务无法通过身份核对，且没有成功加载已验证构建。没有启动任何替代服务。'
    }

    if (-not (Test-Path -LiteralPath $taskElectron -PathType Leaf)) {
        throw '没有找到 JarviSync 桌面运行组件。请让维护者检查当前安装，不要重新下载或改动 data 目录。'
    }
    if ($taskPromotion -and $taskPromotion.Status -eq 'loaded') {
        Close-PrePromotionDesktop -taskState $taskDesktopBeforePromotion -taskBuildId $taskPromotion.BuildId -taskDesktopShellId $taskCandidate.DesktopShellId
    } elseif ($taskCandidateAlreadyLoaded) {
        # A manually loaded current service can still have one old desktop
        # window from before ready-state build IDs existed. Close only that
        # legacy window; a newer window reloads through Electron's second-instance path.
        Close-PrePromotionDesktop -taskState $taskDesktopBeforePromotion -taskBuildId $taskCandidate.BuildId -taskDesktopShellId $taskCandidate.DesktopShellId -LegacyOnly
    }
    [IO.Directory]::CreateDirectory($taskDesktopProfile) | Out-Null
    $taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $taskDesktopOut = Join-Path $taskLogDir ($taskStamp + '-desktop.log')
    $taskDesktopErr = Join-Path $taskLogDir ($taskStamp + '-desktop-error.log')
    $taskHadElectronRunAsNode = Test-Path Env:ELECTRON_RUN_AS_NODE
    $taskOldElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
    $taskOldDesktopMode = $env:NODEBOARD_DESKTOP_MODE
    $taskOldDesktopDataDir = $env:NODEBOARD_DESKTOP_DATA_DIR
    try {
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        $env:NODEBOARD_DESKTOP_MODE = 'workspace'
        $env:NODEBOARD_DESKTOP_DATA_DIR = $taskDesktopProfile
        # wscript.exe already keeps this PowerShell launcher hidden. Electron is a
        # GUI executable, and SW_HIDE would also suppress its BrowserWindow.
        $taskDesktop = Start-Process -FilePath $taskElectron -ArgumentList ('"' + $taskRoot + '"') -WorkingDirectory $taskRoot -RedirectStandardOutput $taskDesktopOut -RedirectStandardError $taskDesktopErr -PassThru
    } finally {
        if ($taskHadElectronRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $taskOldElectronRunAsNode } else { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
        if ($null -eq $taskOldDesktopMode) { Remove-Item Env:NODEBOARD_DESKTOP_MODE -ErrorAction SilentlyContinue } else { $env:NODEBOARD_DESKTOP_MODE = $taskOldDesktopMode }
        if ($null -eq $taskOldDesktopDataDir) { Remove-Item Env:NODEBOARD_DESKTOP_DATA_DIR -ErrorAction SilentlyContinue } else { $env:NODEBOARD_DESKTOP_DATA_DIR = $taskOldDesktopDataDir }
    }

    $taskDeadline = [DateTime]::UtcNow.AddSeconds(25)
    $taskExitedAt = $null
    $taskDesktopState = Get-DesktopReadyState
    while ($null -eq $taskDesktopState) {
        $taskDesktop.Refresh()
        if ($taskDesktop.HasExited -and $null -eq $taskExitedAt) { $taskExitedAt = [DateTime]::UtcNow }
        if ($null -ne $taskExitedAt -and [DateTime]::UtcNow -ge $taskExitedAt.AddSeconds(3)) {
            $taskReason = Get-Content -LiteralPath $taskDesktopErr -Raw -ErrorAction SilentlyContinue
            throw ("JarviSync 桌面窗口没有启动成功，后台服务和原有数据未受影响。`r`n" + $taskReason)
        }
        if ([DateTime]::UtcNow -ge $taskDeadline) {
            $taskReason = Get-Content -LiteralPath $taskDesktopErr -Raw -ErrorAction SilentlyContinue
            throw ("JarviSync 桌面窗口加载时间比平时长。后台服务仍在运行，请稍后再次双击。`r`n" + $taskReason)
        }
        Start-Sleep -Milliseconds 200
        $taskDesktopState = Get-DesktopReadyState
    }

    [IO.File]::WriteAllText((Join-Path $taskLogDir 'last-error.txt'), '', [Text.Encoding]::Unicode)
} catch {
    try {
        [IO.Directory]::CreateDirectory($taskLogDir) | Out-Null
        [IO.File]::WriteAllText((Join-Path $taskLogDir 'last-error.txt'), $_.Exception.Message, [Text.Encoding]::Unicode)
    } catch { }
    exit 1
} finally {
    if ($taskOwnsMutex) { $taskMutex.ReleaseMutex() }
    if ($taskMutex) { $taskMutex.Dispose() }
}
