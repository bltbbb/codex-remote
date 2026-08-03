param(
  [string]$Hostname = "codex-remote.bltbbbego.store",
  [int]$Port = 18791
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$healthUrl = "http://127.0.0.1:$Port/healthz"
try {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
  if ($health.ok) {
    Write-Host "Cloudflare Bridge 已在运行：https://$Hostname/"
    exit 0
  }
} catch {}

$script = Join-Path $PSScriptRoot "start-cloudflare-tunnel.ps1"
$arguments = @("-NoProfile", "-File", $script, "-Hostname", $Hostname, "-Port", [string]$Port)
Start-Process -FilePath "pwsh.exe" -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(45)
do {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    if ($health.ok) {
      Write-Host "Cloudflare Bridge 已后台启动：https://$Hostname/"
      exit 0
    }
  } catch {}
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

throw "Cloudflare Bridge 未在 45 秒内启动"
