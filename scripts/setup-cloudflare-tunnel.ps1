param(
  [string]$TunnelName = "codex-remote",
  [string]$Hostname = "codex-remote.bltbbbego.store"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$isolatedConfig = Join-Path $PSScriptRoot "cloudflare-isolated.yml"
$cloudflared = Get-Command cloudflared -ErrorAction Stop
$tunnels = @(& $cloudflared.Source --config $isolatedConfig tunnel list --output json | ConvertFrom-Json)
$tunnel = $tunnels | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1
if (-not $tunnel) {
  & $cloudflared.Source --config $isolatedConfig tunnel create $TunnelName
  if ($LASTEXITCODE -ne 0) { throw "创建 Cloudflare Tunnel 失败" }
  $tunnels = @(& $cloudflared.Source --config $isolatedConfig tunnel list --output json | ConvertFrom-Json)
  $tunnel = $tunnels | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1
}
if (-not $tunnel) { throw "找不到 Cloudflare Tunnel：$TunnelName" }

& $cloudflared.Source --config $isolatedConfig tunnel route dns --overwrite-dns ([string]$tunnel.id) $Hostname
if ($LASTEXITCODE -ne 0) { throw "配置 Cloudflare DNS 失败；请确认 $Hostname 没有冲突记录" }

Write-Host "Cloudflare Tunnel 已准备：$TunnelName ($($tunnel.id))"
Write-Host "公开地址：https://$Hostname/"
