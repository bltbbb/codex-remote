param(
  [string]$NativeHostPath
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $NativeHostPath) {
  $NativeHostPath = Join-Path $projectRoot "artifacts\native-host-win-x64\codex-remote-native-host.exe"
}

$nativeHost = (Resolve-Path -LiteralPath $NativeHostPath).Path
$worker = Join-Path $PSScriptRoot "complete-stage4-native-host-install.ps1"
$externalPowerShell = (Get-Command pwsh.exe -ErrorAction Stop).Source
$escapedWorker = $worker.Replace("'", "''")
$escapedNativeHost = $nativeHost.Replace("'", "''")
$command = "& '$escapedWorker' -NativeHostPath '$escapedNativeHost'"
$encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$arguments = "-NoProfile -EncodedCommand $encodedCommand"

$process = Start-Process -FilePath $externalPowerShell -ArgumentList $arguments -WindowStyle Normal -PassThru
Write-Host "外部安装助手已打开（PID $($process.Id)）。"
Write-Host "请切换到新窗口查看提示，然后完全退出 Codex Desktop。"
