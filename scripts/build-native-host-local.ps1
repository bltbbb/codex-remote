param(
  [string]$SdkVersion = "8.0.423"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $projectRoot "packages\native-host\CodexRemote.NativeHost.csproj"
$localDotnet = Join-Path $projectRoot "work\dotnet-sdk\$SdkVersion\dotnet.exe"
$systemDotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue

$dotnet = $null
if ($systemDotnet) {
  $sdks = (& $systemDotnet.Source --list-sdks | Out-String)
  if ($sdks -match '^8\.0\.') { $dotnet = $systemDotnet.Source }
}
if (-not $dotnet -and (Test-Path -LiteralPath $localDotnet)) { $dotnet = $localDotnet }
if (-not $dotnet) {
  throw "未找到 .NET 8 SDK。请先运行 scripts\install-local-dotnet-sdk.ps1。"
}

$artifactsRoot = Join-Path $projectRoot "artifacts"
$outputDir = Join-Path $artifactsRoot "native-host-win-x64"
if (Test-Path -LiteralPath $outputDir) {
  $backupDir = Join-Path $artifactsRoot ("native-host-win-x64.previous." + (Get-Date -Format "yyyyMMddHHmmss"))
  Move-Item -LiteralPath $outputDir -Destination $backupDir
  Write-Host "上一版构建产物已移到：$backupDir"
}
[IO.Directory]::CreateDirectory($outputDir) | Out-Null

& $dotnet publish $project `
  --configuration Release `
  --runtime win-x64 `
  --self-contained true `
  --output $outputDir `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:DebugType=None `
  -p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) { throw "Native Host 编译失败，dotnet 退出代码 $LASTEXITCODE" }

$artifact = Join-Path $outputDir "codex-remote-native-host.exe"
if (-not (Test-Path -LiteralPath $artifact)) { throw "编译未生成 Native Host EXE：$artifact" }
$hash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
[IO.File]::WriteAllText("$artifact.sha256", "$hash  codex-remote-native-host.exe`n", [Text.UTF8Encoding]::new($false))

Write-Host "Native Host 编译完成：$artifact"
Write-Host "SHA-256：$hash"
