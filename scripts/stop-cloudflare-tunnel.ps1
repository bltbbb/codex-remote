param(
  [string]$PipeName = "codex-remote-cloudflare"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$pipe = [System.IO.Pipes.NamedPipeClientStream]::new(".", $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
try {
  $pipe.Connect(5000)
  $writer = [System.IO.StreamWriter]::new($pipe)
  $writer.AutoFlush = $true
  $reader = [System.IO.StreamReader]::new($pipe)
  $writer.WriteLine('{"id":"shutdown","command":"shutdown"}')
  $response = $reader.ReadLine() | ConvertFrom-Json
  if (-not $response.ok) { throw "Cloudflare Bridge 拒绝关闭：$($response.error)" }
  Write-Host "Cloudflare Bridge 已请求关闭"
} finally {
  $pipe.Dispose()
}
