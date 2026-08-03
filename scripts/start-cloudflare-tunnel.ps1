param(
  [string]$TunnelName = "codex-remote",
  [string]$Hostname = "codex-remote.bltbbbego.store",
  [int]$Port = 18791,
  [string]$PipeName = "\\.\pipe\codex-remote-cloudflare",
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$isolatedConfig = Join-Path $PSScriptRoot "cloudflare-isolated.yml"
$cloudflared = Get-Command cloudflared -ErrorAction Stop
$tunnels = @(& $cloudflared.Source --config $isolatedConfig tunnel list --output json | ConvertFrom-Json)
$tunnel = $tunnels | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1
if (-not $tunnel) { throw "找不到 Cloudflare Tunnel：$TunnelName。请先运行 pnpm setup:cloudflare" }

$credential = Join-Path $env:USERPROFILE ".cloudflared\$($tunnel.id).json"
if (-not (Test-Path -LiteralPath $credential)) { throw "找不到 Tunnel 凭据：$credential" }
$webIndex = Join-Path $projectRoot "apps\web\dist\index.html"
if (-not (Test-Path -LiteralPath $webIndex)) { throw "Web 构建不存在，请先运行 pnpm build" }

Write-Host "Cloudflare Tunnel: $TunnelName ($($tunnel.id))"
Write-Host "公开地址: https://$Hostname/"
Write-Host "本机源站: http://127.0.0.1:$Port/"
Write-Host "Bridge 仅监听回环地址，并继续强制设备配对。"
if ($CheckOnly) { exit 0 }

$env:CODEX_REMOTE_HOST = "127.0.0.1"
$env:CODEX_REMOTE_PORT = [string]$Port
$env:CODEX_REMOTE_AUTH_MODE = "required"
$env:CODEX_REMOTE_TRAY = "1"
$env:CODEX_REMOTE_PIPE = $PipeName
$env:CODEX_REMOTE_PUBLIC_URL = "https://$Hostname"
$env:CODEX_REMOTE_DEVICE_STORE = Join-Path $env:LOCALAPPDATA "CodexRemote\cloudflare-devices.dat"

$tunnelArguments = @(
  "--config", $isolatedConfig,
  "tunnel",
  "--no-autoupdate",
  "--protocol", "http2",
  "--credentials-file", $credential,
  "--url", "http://127.0.0.1:$Port",
  "run", [string]$tunnel.id
)
$tunnelProcess = Start-Process -FilePath $cloudflared.Source -ArgumentList $tunnelArguments -PassThru -WindowStyle Hidden

Push-Location $projectRoot
try {
  & pnpm start:bridge
  exit $LASTEXITCODE
} finally {
  Pop-Location
  if (-not $tunnelProcess.HasExited) { Stop-Process -Id $tunnelProcess.Id }
}
