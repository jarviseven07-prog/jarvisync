$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$taskSource = Join-Path $taskRoot 'desktop/Launcher.cs'
$taskIcon = Join-Path $taskRoot 'desktop/assets/jarvisync.ico'
$taskOutput = Join-Path $taskRoot 'desktop/JarviSync.exe'
if (-not (Test-Path -LiteralPath $taskCompiler -PathType Leaf)) { throw 'Windows .NET Framework C# compiler is unavailable.' }
& $taskCompiler /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll ('/win32icon:' + $taskIcon) ('/out:' + $taskOutput) $taskSource
if ($LASTEXITCODE -ne 0) { throw 'JarviSync launcher compilation failed.' }
Get-FileHash -LiteralPath $taskOutput -Algorithm SHA256
