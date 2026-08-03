param(
  [string]$Version = "8.0.423"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sdkRoot = Join-Path $projectRoot "work\dotnet-sdk"
$installDir = Join-Path $sdkRoot $Version
$dotnet = Join-Path $installDir "dotnet.exe"
if (Test-Path -LiteralPath $dotnet) {
  $installed = (& $dotnet --list-sdks | Out-String)
  if ($installed -match "^$([regex]::Escape($Version))\s") {
    Write-Host "本地 .NET SDK 已存在：$dotnet"
    exit 0
  }
}

$architecture = "x64"
$archiveName = "dotnet-sdk-$Version-win-$architecture.zip"
$downloadUrl = "https://dotnetcli.azureedge.net/dotnet/Sdk/$Version/$archiveName"
$checksumUrl = "$downloadUrl.sha512"
$cacheDir = Join-Path $sdkRoot "cache"
$archive = Join-Path $cacheDir $archiveName
$partialArchive = "$archive.partial"
[IO.Directory]::CreateDirectory($cacheDir) | Out-Null

$curl = (Get-Command curl.exe -ErrorAction Stop).Source
$checksumLine = (& $curl --fail --location --silent --show-error --retry 5 --retry-all-errors --retry-delay 3 $checksumUrl | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $checksumLine -notmatch '^([0-9a-fA-F]{128})\s+') {
  throw "无法读取官方 SHA-512：$checksumUrl"
}
$expectedHash = $Matches[1].ToUpperInvariant()

function Read-Sha512WithRetry([string]$Path) {
  for ($attempt = 1; $attempt -le 30; $attempt += 1) {
    try {
      return (Get-FileHash -LiteralPath $Path -Algorithm SHA512 -ErrorAction Stop).Hash
    } catch {
      if ($attempt -eq 30) { throw }
      Start-Sleep -Seconds 1
    }
  }
}

$actualHash = if (Test-Path -LiteralPath $archive) { Read-Sha512WithRetry $archive } else { $null }
if ($actualHash -ne $expectedHash) {
  if (Test-Path -LiteralPath $archive) {
    $invalidArchive = "$archive.invalid.$(Get-Date -Format 'yyyyMMddHHmmss')"
    Move-Item -LiteralPath $archive -Destination $invalidArchive
    Write-Warning "原 SDK 缓存校验失败，已保留为：$invalidArchive"
  }
  Write-Host "下载 .NET SDK：$downloadUrl"
  & $curl --fail --location --silent --show-error --retry 5 --retry-all-errors --retry-delay 3 --continue-at - --output $partialArchive $downloadUrl
  if ($LASTEXITCODE -ne 0) { throw "下载 .NET SDK 失败，curl 退出代码 $LASTEXITCODE" }
  $actualHash = Read-Sha512WithRetry $partialArchive
  if ($actualHash -ne $expectedHash) {
    throw "SDK 临时下载文件 SHA-512 不匹配：当前 $actualHash，官方 $expectedHash；文件保留在 $partialArchive"
  }
  Move-Item -LiteralPath $partialArchive -Destination $archive
} else {
  Write-Host "复用已通过 SHA-512 校验的 SDK 压缩包：$archive"
}
if ($actualHash -ne $expectedHash) {
  throw "SDK SHA-512 不匹配：当前 $actualHash，官方 $expectedHash"
}

$extractDir = Join-Path $sdkRoot (".extract-$Version-" + $PID)
[IO.Directory]::CreateDirectory($extractDir) | Out-Null
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $extractDir)
  $extractedDotnet = Join-Path $extractDir "dotnet.exe"
  if (-not (Test-Path -LiteralPath $extractedDotnet)) { throw "SDK 压缩包缺少 dotnet.exe" }

  $installed = (& $extractedDotnet --list-sdks | Out-String)
  if ($installed -notmatch "^$([regex]::Escape($Version))\s") {
    throw "解压后的 SDK 版本不匹配：$installed"
  }

  if (Test-Path -LiteralPath $installDir) {
    $backupDir = Join-Path $sdkRoot ("$Version.previous." + (Get-Date -Format "yyyyMMddHHmmss"))
    Move-Item -LiteralPath $installDir -Destination $backupDir
    Write-Host "旧的不完整 SDK 已移到：$backupDir"
  }
  Move-Item -LiteralPath $extractDir -Destination $installDir
} finally {
  if (Test-Path -LiteralPath $extractDir) {
    Write-Warning "临时解压目录保留供检查：$extractDir"
  }
}

Write-Host "本地 .NET SDK 安装完成：$dotnet"
& $dotnet --info
