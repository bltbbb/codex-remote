param(
  [int]$Port = 18787
)

$ErrorActionPreference = "Stop"
$ruleName = "Codex Remote - Tailscale"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an elevated PowerShell window."
}

$tailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source
if (-not $tailscale) {
  $tailscale = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
}
if (-not (Test-Path -LiteralPath $tailscale)) { throw "Tailscale was not found." }

$status = (& $tailscale status --json 2>$null | Out-String) | ConvertFrom-Json
$tailscaleIp = @($status.Self.TailscaleIPs) | Where-Object { $_ -is [string] -and $_ -match '^\d{1,3}(\.\d{1,3}){3}$' } | Select-Object -First 1
if (-not $tailscaleIp) { throw "Tailscale has no IPv4 address." }

Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalAddress $tailscaleIp `
  -LocalPort $Port `
  -RemoteAddress "100.64.0.0/10" `
  -Profile Any | Out-Null

Write-Host "Allowed Tailscale access to ${tailscaleIp}:${Port}. LAN and public addresses remain closed."
