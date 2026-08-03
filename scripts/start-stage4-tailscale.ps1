param(
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

function Find-TailscaleExecutable {
  $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidate = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
  if (Test-Path -LiteralPath $candidate) { return $candidate }

  throw "Tailscale was not found. Install it on Windows and iPhone first."
}

function Read-TailscaleStatus([string]$Executable) {
  $json = (& $Executable status --json 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $json) {
    throw "Unable to read Tailscale status. Open Tailscale and sign in first."
  }
  return $json | ConvertFrom-Json
}

function Find-TailscaleIPv4($Status) {
  $addresses = @($Status.Self.TailscaleIPs)
  $address = $addresses | Where-Object { $_ -is [string] -and $_ -match '^\d{1,3}(\.\d{1,3}){3}$' } | Select-Object -First 1
  if (-not $address) { throw "Tailscale has no IPv4 address. Connect this device to a tailnet first." }
  return $address
}

function Read-NativeHostStatus {
  $pipe = [IO.Pipes.NamedPipeClientStream]::new(
    ".",
    "codex-remote-native-v1",
    [IO.Pipes.PipeDirection]::InOut,
    [IO.Pipes.PipeOptions]::Asynchronous
  )
  try {
    $pipe.Connect(2500)
    $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 4096, $true)
    $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 4096, $true)
    try {
      $writer.AutoFlush = $true
      $writer.WriteLine('{"command":"status"}')
      $line = $reader.ReadLine()
      if (-not $line) { throw "Native Host 未返回状态。" }
      return $line | ConvertFrom-Json
    } finally {
      $reader.Dispose()
      $writer.Dispose()
    }
  } catch {
    throw "未发现 Codex Desktop Native Host。请先安装 Native Host、完全重启 Codex Desktop，再启动阶段 4。详细信息：$($_.Exception.Message)"
  } finally {
    $pipe.Dispose()
  }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$tailscale = Find-TailscaleExecutable
$status = Read-TailscaleStatus $tailscale
if ([string]$status.BackendState -ne "Running") {
  throw "Tailscale state is $($status.BackendState). Sign in and connect first."
}

$tailscaleIp = Find-TailscaleIPv4 $status
$nativeHost = Read-NativeHostStatus
if ([int]$nativeHost.protocolVersion -ne 1) { throw "Native Host 协议版本不受支持：$($nativeHost.protocolVersion)" }
if ([string]$nativeHost.codexVersion -ne "0.146.0-alpha.9.2") { throw "Native Host Codex 版本不匹配：$($nativeHost.codexVersion)" }
if ([string]$nativeHost.desktopVersion -ne "26.727.6591.0") { throw "Native Host Desktop 版本不匹配：$($nativeHost.desktopVersion)" }
if ([string]$nativeHost.sourceTag -ne "rust-v0.146.0-alpha.9.2") { throw "Native Host 源码标签不匹配：$($nativeHost.sourceTag)" }
if ([string]$nativeHost.codexSha256 -ne "ECD7A3EAFF5E42723DBBA03B5C91514B3986B5DB5CBCA8F34619620B5356F31F") { throw "Native Host Codex SHA-256 不匹配：$($nativeHost.codexSha256)" }
$port = if ($env:CODEX_REMOTE_PORT) { [int]$env:CODEX_REMOTE_PORT } else { 18787 }
$url = "http://${tailscaleIp}:${port}/"

Write-Host "Tailscale address: $tailscaleIp"
Write-Host "Phone URL: $url"
Write-Host "Native Host: PID $($nativeHost.hostPid), Codex PID $($nativeHost.codexPid), $($nativeHost.endpoint)"
Write-Host "Bridge will attach to the Desktop app-server, bind only to Tailscale, and require device pairing."

if ($CheckOnly) { exit 0 }

$webIndex = Join-Path $projectRoot "apps\web\dist\index.html"
if (-not (Test-Path -LiteralPath $webIndex)) {
  throw "Web build output was not found. Run pnpm build first."
}

$env:CODEX_REMOTE_HOST = $tailscaleIp
$env:CODEX_REMOTE_PORT = [string]$port
$env:CODEX_REMOTE_AUTH_MODE = "required"
$env:CODEX_REMOTE_TRAY = "1"

Push-Location $projectRoot
try {
  & pnpm start:bridge
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
