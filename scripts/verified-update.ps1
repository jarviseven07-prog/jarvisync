Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-JarviSyncSha256 {
    param([Parameter(Mandatory)][string]$Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()
}

function Get-JarviSyncPathUnderRoot {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$RelativePath)
    if ([IO.Path]::IsPathRooted($RelativePath) -or $RelativePath -match '(^|[\\/])\.\.([\\/]|$)') {
        throw "已验证构建包含不安全的文件路径：$RelativePath"
    }
    $rootPath = [IO.Path]::GetFullPath($Root)
    $target = [IO.Path]::GetFullPath((Join-Path $rootPath $RelativePath))
    if (-not $target.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "已验证构建包含根目录外的文件路径：$RelativePath"
    }
    $target
}

function Get-JarviSyncBuildIdentity {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$DistDir, [string]$NodeExecutable)
    if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source }
    $result = & $NodeExecutable (Join-Path $Root 'server/build-identity.mjs') $Root $DistDir
    if ($LASTEXITCODE -ne 0) { throw '无法计算构建标识。' }
    $result | ConvertFrom-Json
}

function Get-JarviSyncHealthBuildId {
    param($Health)
    if ($Health -and $Health.PSObject.Properties['buildId']) { return $Health.buildId }
    $null
}

function Test-JarviSyncInvalidCandidate {
    param($Candidate)
    $Candidate -and $Candidate.PSObject.Properties['Invalid'] -and $Candidate.Invalid
}

function Assert-JarviSyncManagedDirectory {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
    $rootPath = [IO.Path]::GetFullPath($Root)
    $target = [IO.Path]::GetFullPath($Path)
    if (-not $target.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "$Label 不在当前仓库内。" }
    if (Test-Path -LiteralPath $target) {
        $item = Get-Item -LiteralPath $target -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label 是重解析点，已停止替换。" }
    }
    $target
}

function Get-JarviSyncVerifiedCandidate {
    param([Parameter(Mandatory)][string]$Root, [string]$NodeExecutable)
    $rootPath = [IO.Path]::GetFullPath($Root)
    $evidence = Join-Path $rootPath 'artifacts/agent-onboarding-qa'
    $manifestPath = Join-Path $evidence 'verified-files.json'
    $buildPath = Join-Path $rootPath 'artifacts/agent-onboarding-build'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $buildPath -PathType Container)) { return $null }
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $items = @($manifest.files)
        if ($items.Count -eq 0) { throw '已验证构建没有文件清单。' }
        $manifestEntries = @{}
        $canonical = foreach ($item in $items) {
            if ($item.path -isnot [string] -or $item.sha256 -isnot [string] -or $item.sha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw '已验证构建清单格式无效。' }
            $relative = $item.path.Replace('/', '\')
            $path = Get-JarviSyncPathUnderRoot -Root $rootPath -RelativePath $relative
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "已验证文件不存在：$relative" }
            $actual = Get-JarviSyncSha256 -Path $path
            if ($actual -cne $item.sha256.ToUpperInvariant()) { throw "已验证文件发生变化，请重新核对后更新：$relative" }
            $manifestEntries[$relative.ToLowerInvariant()] = $actual
            "$($relative.ToLowerInvariant())`n$actual"
        }
        $identity = Get-JarviSyncBuildIdentity -Root $rootPath -DistDir $buildPath -NodeExecutable $NodeExecutable
        foreach ($input in @($identity.inputs)) {
            $manifestPathForInput = if ($input.path -like 'frontend/*') { ('artifacts\agent-onboarding-build\' + $input.path.Substring(9)).Replace('/', '\').ToLowerInvariant() } else { $input.path.Replace('/', '\').ToLowerInvariant() }
            if ($manifestEntries[$manifestPathForInput] -cne $input.sha256.ToUpperInvariant()) { throw "已验证构建未覆盖或不匹配运行时输入：$manifestPathForInput" }
        }
        if ($manifest.buildId -isnot [string] -or $manifest.buildId -cne $identity.buildId) { throw '已验证构建标识与运行时文件不一致。' }
        $desktopShellId = $null
        if ($manifest.PSObject.Properties['desktopShellId']) {
            $shellNode = if ($NodeExecutable) { $NodeExecutable } else { (Get-Command node.exe -ErrorAction Stop).Source }
            $desktopShellId = & $shellNode (Join-Path $rootPath 'desktop/shell-identity.cjs') $rootPath
            if ($LASTEXITCODE -ne 0 -or $desktopShellId -cne $manifest.desktopShellId) { throw '桌面版本标识与已验证文件不一致。' }
        }
        $verifiedAt = if ($manifest.PSObject.Properties['verifiedAt']) { $manifest.verifiedAt } else { $null }
        [pscustomobject]@{ Root = $rootPath; Evidence = $evidence; ManifestPath = $manifestPath; BuildPath = $buildPath; BuildId = $identity.buildId; DesktopShellId = $desktopShellId; FileCount = $items.Count; VerifiedAt = $verifiedAt }
    } catch {
        [pscustomobject]@{ Root = $rootPath; Evidence = $evidence; ManifestPath = $manifestPath; BuildPath = $buildPath; Invalid = $true; Reason = $_.Exception.Message }
    }
}

function Get-JarviSyncListeners {
    param([Parameter(Mandatory)][int]$Port)
    @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Get-JarviSyncRuntimeState {
    param([Parameter(Mandatory)][string]$DataDir, [Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$ServerEntry)
    try {
        $lock = Get-Content -LiteralPath (Join-Path $DataDir 'server.lock') -Raw -Encoding UTF8 | ConvertFrom-Json
        $listeners = @(Get-JarviSyncListeners -Port $Port)
        if ($listeners.Count -eq 0 -or @($listeners | Where-Object { $_.OwningProcess -ne $lock.pid }).Count -gt 0) { return $null }
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $lock.pid)
        if (-not $process -or $process.Name -ne 'node.exe' -or $process.CommandLine -notlike ('*' + $ServerEntry + '*')) { return $null }
        $board = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/api/board') -TimeoutSec 2
        if ($board.schemaVersion -ne 1 -or $null -eq $board.projects -or $null -eq $board.nodes -or $null -eq $board.revision) { return $null }
        $health = $null
        $legacy = $false
        try {
            $healthResponse = $null
            try { $healthResponse = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/api/health') -TimeoutSec 2 -UseBasicParsing }
            catch {
                if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { $legacy = $true }
                else { return $null }
            }
            if ($healthResponse -and $healthResponse.StatusCode -ge 200 -and $healthResponse.StatusCode -lt 300) {
                $candidateHealth = $healthResponse.Content | ConvertFrom-Json
                if ($candidateHealth.product -ne 'JarviSync') { return $null }
                $identityPath = Join-Path $DataDir 'instance.json'
                if (Test-Path -LiteralPath $identityPath -PathType Leaf) {
                    $identity = Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ($candidateHealth.boardInstanceId -cne $identity.boardInstanceId) { return $null }
                }
                $health = $candidateHealth
            } elseif (-not $legacy) { return $null }
        } catch { return $null }
        [pscustomobject]@{ Lock = $lock; Process = $process; Health = $health; Board = $board; Legacy = $legacy }
    } catch { $null }
}

function New-JarviSyncUpdateBackup {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$DataDir, [Parameter(Mandatory)][string]$DistDir)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $backup = Join-Path $Root ('artifacts/agent-onboarding-release/' + $stamp)
    $backupData = Join-Path $backup 'data'
    New-Item -ItemType Directory -Path $backupData -Force | Out-Null

    # Electron owns this browser userData directory while its window is open. It
    # contains no board, identity, Agent integration, history, or upload data;
    # retain it in place and record the intentional exclusion with the backup.
    $desktopProfile = Join-Path $DataDir 'desktop-profile'
    $backupRecord = [pscustomobject]@{
        excludedDataEntries = @([pscustomobject]@{
            path = 'desktop-profile'
            reason = 'Electron browser userData remains in place while the desktop window is open.'
            present = (Test-Path -LiteralPath $desktopProfile -PathType Container)
        })
    }
    $backupRecord | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backup 'backup-record.json') -Encoding UTF8 -ErrorAction Stop

    # Copy every other top-level data item individually. Do not catch copy
    # failures: a board or Agent-data copy error must stop the update before any
    # service is stopped or frontend files are replaced.
    foreach ($item in @(Get-ChildItem -LiteralPath $DataDir -Force -ErrorAction Stop)) {
        if ($item.Name -ieq 'desktop-profile') { continue }
        Copy-Item -LiteralPath $item.FullName -Destination $backupData -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $DistDir -PathType Container) { Copy-Item -LiteralPath $DistDir -Destination (Join-Path $backup 'dist') -Recurse -Force -ErrorAction Stop }
    $backup
}

function Invoke-JarviSyncVerifiedUpdate {
    param(
        [Parameter(Mandatory)]$Candidate,
        [Parameter(Mandatory)][string]$DataDir,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][string]$NodeExecutable,
        [Parameter(Mandatory)][string]$ServerEntry
    )
    if (Test-JarviSyncInvalidCandidate $Candidate) { throw ('已验证构建不可加载：' + $Candidate.Reason) }
    $root = $Candidate.Root
    $data = [IO.Path]::GetFullPath($DataDir)
    $dist = Assert-JarviSyncManagedDirectory -Root $root -Path (Join-Path $root 'dist') -Label '现有前端目录'
    $stage = Assert-JarviSyncManagedDirectory -Root $root -Path ($dist + '.verified-next') -Label '前端暂存目录'
    $candidateBuild = Assert-JarviSyncManagedDirectory -Root $root -Path $Candidate.BuildPath -Label '已验证前端目录'
    $server = [IO.Path]::GetFullPath($ServerEntry)
    $node = [IO.Path]::GetFullPath($NodeExecutable)
    if (-not (Test-Path -LiteralPath $data -PathType Container) -or -not (Test-Path -LiteralPath (Join-Path $data 'board.json') -PathType Leaf)) { throw '找不到原看板数据，已停止加载。' }
    if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $server -PathType Leaf)) { throw '找不到当前看板运行组件，已停止加载。' }
    $beforeHash = Get-JarviSyncSha256 -Path (Join-Path $data 'board.json')
    $beforeBoard = Get-Content -LiteralPath (Join-Path $data 'board.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $identity = $null
    $identityPath = Join-Path $data 'instance.json'
    if (Test-Path -LiteralPath $identityPath -PathType Leaf) { $identity = Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    $running = Get-JarviSyncRuntimeState -DataDir $data -Port $Port -ServerEntry $server
    if ($running -and $identity -and (Get-JarviSyncHealthBuildId $running.Health) -ceq $Candidate.BuildId -and $running.Health.boardInstanceId -ceq $identity.boardInstanceId) {
        return [pscustomobject]@{ Status = 'already-loaded'; BuildId = $Candidate.BuildId; Pid = $running.Lock.pid; BoardInstanceId = $identity.boardInstanceId; BoardSha256 = $beforeHash; Revision = $running.Board.revision }
    }
    if (@(Get-JarviSyncListeners -Port $Port).Count -gt 0 -and -not $running) { throw "本机 $Port 端口服务身份不匹配，已停止加载且没有关闭任何进程。" }
    $backup = New-JarviSyncUpdateBackup -Root $root -DataDir $data -DistDir $dist
    if ((Get-JarviSyncSha256 -Path (Join-Path $backup 'data/board.json')) -cne $beforeHash -or (Get-JarviSyncSha256 -Path (Join-Path $data 'board.json')) -cne $beforeHash) { throw '备份期间看板发生变化；本次未停止服务，请重新运行。' }
    # Re-hash the candidate immediately before the first stop.  This closes
    # the ordinary edit-during-backup window; a later external file mutation
    # still remains an explicitly documented filesystem race.
    $confirmedCandidate = Get-JarviSyncVerifiedCandidate -Root $root -NodeExecutable $node
    if (-not $confirmedCandidate -or (Test-JarviSyncInvalidCandidate $confirmedCandidate) -or $confirmedCandidate.BuildId -cne $Candidate.BuildId) {
        throw '已验证候选构建在备份期间发生变化；本次未停止服务，请重新核对。'
    }
    $Candidate = $confirmedCandidate
    $candidateBuild = Assert-JarviSyncManagedDirectory -Root $root -Path $Candidate.BuildPath -Label '已验证前端目录'
    if ($running) {
        $now = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $running.Lock.pid)
        if (-not $now -or $now.CommandLine -cne $running.Process.CommandLine -or $now.CreationDate -cne $running.Process.CreationDate) { throw '服务进程已变化；本次未停止它，请重新运行。' }
        Stop-Process -Id $running.Lock.pid -ErrorAction Stop
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        while (@(Get-JarviSyncListeners -Port $Port).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
        if (@(Get-JarviSyncListeners -Port $Port).Count -gt 0) { throw '原端口尚未释放，未启动其他服务。请保留现场核对。' }
    }
    Remove-Item -LiteralPath $stage -Force -Recurse -ErrorAction SilentlyContinue
    try {
        Copy-Item -LiteralPath $candidateBuild -Destination $stage -Recurse -ErrorAction Stop
        if (Test-Path -LiteralPath $dist -PathType Container) { Remove-Item -LiteralPath $dist -Force -Recurse -ErrorAction Stop }
        Move-Item -LiteralPath $stage -Destination $dist -ErrorAction Stop
    } catch {
        throw ('前端构建替换失败；备份保留在 ' + $backup + '。' + $_.Exception.Message)
    }
    $logDir = Join-Path $data 'launcher'
    [IO.Directory]::CreateDirectory($logDir) | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $oldPort = $env:PORT; $oldData = $env:NODEBOARD_DATA_DIR
    try {
        $env:PORT = [string]$Port
        $env:NODEBOARD_DATA_DIR = $data
        $started = Start-Process -FilePath $node -ArgumentList ('"' + $server + '"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir ($stamp + '-server.log')) -RedirectStandardError (Join-Path $logDir ($stamp + '-error.log')) -PassThru
    } finally {
        if ($null -eq $oldPort) { Remove-Item Env:PORT -ErrorAction SilentlyContinue } else { $env:PORT = $oldPort }
        if ($null -eq $oldData) { Remove-Item Env:NODEBOARD_DATA_DIR -ErrorAction SilentlyContinue } else { $env:NODEBOARD_DATA_DIR = $oldData }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    $ready = $null
    while (-not $ready -and [DateTime]::UtcNow -lt $deadline) {
        $started.Refresh()
        if ($started.HasExited) { throw ('新版服务没有启动成功，备份和日志已保留在 ' + $backup) }
        $ready = Get-JarviSyncRuntimeState -DataDir $data -Port $Port -ServerEntry $server
        if (-not $ready) { Start-Sleep -Milliseconds 200 }
    }
    if (-not $ready) { throw ('新版服务尚未就绪，备份和日志已保留在 ' + $backup) }
    $newIdentity = if (Test-Path -LiteralPath $identityPath -PathType Leaf) { Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    if (-not $newIdentity -or $ready.Lock.pid -ne $started.Id -or (Get-JarviSyncHealthBuildId $ready.Health) -cne $Candidate.BuildId) { throw '新版服务身份或构建标识不一致，请保留现场核对。' }
    if (($identity -and $newIdentity.boardInstanceId -cne $identity.boardInstanceId) -or $ready.Health.boardInstanceId -cne $newIdentity.boardInstanceId -or (Get-JarviSyncSha256 -Path (Join-Path $data 'board.json')) -cne $beforeHash) { throw '新版服务或数据回读不一致，请保留现场核对。' }
    [pscustomobject]@{ Status = 'loaded'; BuildId = $Candidate.BuildId; Pid = $started.Id; BoardInstanceId = $newIdentity.boardInstanceId; BoardSha256 = $beforeHash; Revision = $ready.Board.revision; Backup = $backup }
}
