param(
  [string]$NativeHostPath,
  [string]$RealCodexPath,
  [string]$ProjectRoot,
  [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"

$expectedDesktopVersion = "26.727.6591.0"
$expectedCodexVersion = "0.146.0-alpha.9.2"
$expectedCodexHash = "ECD7A3EAFF5E42723DBBA03B5C91514B3986B5DB5CBCA8F34619620B5356F31F"
if ($ProjectRoot) {
  $projectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
} elseif ($PSScriptRoot) {
  $projectRoot = Split-Path -Parent $PSScriptRoot
} else {
  throw "内存脚本执行时必须显式传入 ProjectRoot。"
}

if (-not $NativeHostPath) {
  $NativeHostPath = Join-Path $projectRoot "artifacts\native-host-win-x64\codex-remote-native-host.exe"
}
if (-not $RealCodexPath) {
  $RealCodexPath = Join-Path $projectRoot "work\stage0\desktop-native\codex.exe"
}

$nativeHost = (Resolve-Path -LiteralPath $NativeHostPath).Path
$realCodex = (Resolve-Path -LiteralPath $RealCodexPath).Path
if ([string]::Equals($nativeHost, $realCodex, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Native Host 与真实 Codex 路径不能相同。"
}

$nativeHostHashPath = "$nativeHost.sha256"
if (-not (Test-Path -LiteralPath $nativeHostHashPath)) {
  throw "缺少 Native Host 构建产物 SHA-256 文件：$nativeHostHashPath"
}
$expectedNativeHostHash = ((Get-Content -LiteralPath $nativeHostHashPath -Raw).Trim() -split '\s+')[0].ToUpperInvariant()
if ($expectedNativeHostHash -notmatch '^[0-9A-F]{64}$') {
  throw "Native Host SHA-256 文件格式无效：$nativeHostHashPath"
}
$actualNativeHostHash = (Get-FileHash -LiteralPath $nativeHost -Algorithm SHA256).Hash
if ($actualNativeHostHash -ne $expectedNativeHostHash) {
  throw "Native Host 构建产物 SHA-256 不匹配：当前 $actualNativeHostHash，清单 $expectedNativeHostHash。拒绝安装。"
}

$package = Get-AppxPackage -Name "OpenAI.Codex" | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) { throw "未找到 OpenAI.Codex Store 安装包。" }
if ([string]$package.Version -ne $expectedDesktopVersion) {
  throw "Codex Desktop 版本不匹配：当前 $($package.Version)，预期 $expectedDesktopVersion。拒绝安装。"
}

$realHash = (Get-FileHash -LiteralPath $realCodex -Algorithm SHA256).Hash
if ($realHash -ne $expectedCodexHash) {
  throw "阶段 0 Codex 副本哈希不匹配：当前 $realHash，预期 $expectedCodexHash。拒绝安装。"
}

$versionOutput = (& $realCodex --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch [regex]::Escape($expectedCodexVersion)) {
  throw "阶段 0 Codex 副本版本不匹配：$versionOutput"
}

$installRoot = Join-Path $env:LOCALAPPDATA "CodexRemote\native-host"
$installedHost = Join-Path $installRoot "codex-remote-native-host.exe"
$statePath = Join-Path $installRoot "install-state.json"

$hostProcess = Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and (
    [string]::Equals($_.ExecutablePath, $nativeHost, [StringComparison]::OrdinalIgnoreCase) -or
    [string]::Equals($_.ExecutablePath, $installedHost, [StringComparison]::OrdinalIgnoreCase)
  )
} | Select-Object -First 1
if ($hostProcess) {
  throw "Native Host 当前仍在运行（PID $($hostProcess.ProcessId)）。请先完全退出 Codex Desktop 后再安装。"
}

if ($ValidateOnly) {
  Write-Host "Native Host 安装前置校验通过。"
  return
}

[IO.Directory]::CreateDirectory($installRoot) | Out-Null

if (Test-Path -LiteralPath $installedHost) {
  $backupName = "codex-remote-native-host.previous.$(Get-Date -Format 'yyyyMMddHHmmss').exe"
  Copy-Item -LiteralPath $installedHost -Destination (Join-Path $installRoot $backupName)
}
Copy-Item -LiteralPath $nativeHost -Destination $installedHost -Force

if (-not (Test-Path -LiteralPath $statePath)) {
  $state = [ordered]@{
    installedAt = [DateTimeOffset]::Now.ToString("o")
    desktopVersion = $expectedDesktopVersion
    codexVersion = $expectedCodexVersion
    previousCodexCliPath = [Environment]::GetEnvironmentVariable("CODEX_CLI_PATH", "User")
    previousRealCodexPath = [Environment]::GetEnvironmentVariable("CODEX_REMOTE_REAL_CODEX_PATH", "User")
  }
  [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
}

[Environment]::SetEnvironmentVariable("CODEX_CLI_PATH", $installedHost, "User")
[Environment]::SetEnvironmentVariable("CODEX_REMOTE_REAL_CODEX_PATH", $realCodex, "User")

Write-Host "Native Host 已安装：$installedHost"
Write-Host "真实 Codex：$realCodex"
Write-Host "已配置当前用户 CODEX_CLI_PATH。"
Write-Host "现在启动 Codex Desktop；桌面 app-server 就绪后再运行 pnpm start:stage4。"
