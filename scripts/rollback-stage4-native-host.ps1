$ErrorActionPreference = "Stop"

$installRoot = Join-Path $env:LOCALAPPDATA "CodexRemote\native-host"
$statePath = Join-Path $installRoot "install-state.json"
if (-not (Test-Path -LiteralPath $statePath)) {
  throw "未找到 Native Host 安装状态：$statePath"
}

$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$previousCli = if ($null -eq $state.previousCodexCliPath) { $null } else { [string]$state.previousCodexCliPath }
$previousReal = if ($null -eq $state.previousRealCodexPath) { $null } else { [string]$state.previousRealCodexPath }

[Environment]::SetEnvironmentVariable("CODEX_CLI_PATH", $previousCli, "User")
[Environment]::SetEnvironmentVariable("CODEX_REMOTE_REAL_CODEX_PATH", $previousReal, "User")

Write-Host "已恢复安装前的当前用户环境变量。"
Write-Host "为便于恢复，已安装 EXE、历史备份和状态文件均未删除：$installRoot"
Write-Host "请完全退出并重新启动 Codex Desktop。"
