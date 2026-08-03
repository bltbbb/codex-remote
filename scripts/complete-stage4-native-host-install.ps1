param(
  [Parameter(Mandatory = $true)]
  [string]$NativeHostPath,
  [int]$WaitTimeoutSeconds = 3600
)

$ErrorActionPreference = "Stop"

$expectedDesktopVersion = "26.727.6591.0"
$desktopAppId = "OpenAI.Codex_2p2nqsd0c76g0!App"
$projectRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $projectRoot "work\external-install"
[IO.Directory]::CreateDirectory($logRoot) | Out-Null
$logPath = Join-Path $logRoot "native-host-install.$(Get-Date -Format 'yyyyMMddHHmmss').log"

try {
  Start-Transcript -LiteralPath $logPath -Force | Out-Null
  $installScript = Join-Path $PSScriptRoot "install-stage4-native-host.ps1"
  $nativeHost = (Resolve-Path -LiteralPath $NativeHostPath).Path
  $packagePrefix = Join-Path $env:ProgramFiles "WindowsApps\OpenAI.Codex_$expectedDesktopVersion"
  $deadline = [DateTimeOffset]::Now.AddSeconds($WaitTimeoutSeconds)
  $lastProcessSummary = ""

  function Get-CodexDesktopProcesses {
    return @(Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($packagePrefix, [StringComparison]::OrdinalIgnoreCase)
    })
  }

  Write-Host "Codex Remote Native Host 外部安装助手已启动。"
  Write-Host "请保存当前工作，然后完全退出 Codex Desktop；本助手不会强制结束任何进程。"
  Write-Host "等待日志：$logPath"

  while ($true) {
    $desktopProcesses = Get-CodexDesktopProcesses
    if ($desktopProcesses.Count -eq 0) {
      break
    }
    if ([DateTimeOffset]::Now -ge $deadline) {
      throw "等待 Codex Desktop 退出超过 $WaitTimeoutSeconds 秒，未执行安装。"
    }

    $processSummary = (($desktopProcesses | Sort-Object ProcessId | ForEach-Object {
      "$($_.Name):$($_.ProcessId)"
    }) -join ", ")
    if ($processSummary -ne $lastProcessSummary) {
      Write-Host "仍在等待：$processSummary"
      $lastProcessSummary = $processSummary
    }
    Start-Sleep -Seconds 2
  }

  Write-Host "Codex Desktop 已完全退出，开始安装本机编译的 Native Host。"
  $windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $escapedInstallScript = $installScript.Replace("'", "''")
  $escapedNativeHost = $nativeHost.Replace("'", "''")
  $escapedProjectRoot = $projectRoot.Replace("'", "''")
  $installCommand = @"
`$source = [IO.File]::ReadAllText('$escapedInstallScript', [Text.Encoding]::UTF8)
& ([ScriptBlock]::Create(`$source)) -NativeHostPath '$escapedNativeHost' -ProjectRoot '$escapedProjectRoot'
"@
  $encodedInstallCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($installCommand))
  & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedInstallCommand
  if ($LASTEXITCODE -ne 0) {
    throw "Windows PowerShell 安装脚本退出代码为 $LASTEXITCODE。"
  }

  Write-Host "安装成功，正在重新打开 Codex Desktop。"
  Start-Process -FilePath "$env:SystemRoot\explorer.exe" -ArgumentList "shell:AppsFolder\$desktopAppId"
  Write-Host "Codex Desktop 已请求启动；可以关闭此窗口。"
}
catch {
  Write-Host "安装未完成：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "日志：$logPath"
  Read-Host "按 Enter 关闭窗口"
  exit 1
}
finally {
  try { Stop-Transcript | Out-Null } catch {}
}
