param(
  [Parameter(Mandatory = $true)][int]$BridgePid,
  [Parameter(Mandatory = $true)][string]$LocalBaseUrl,
  [Parameter(Mandatory = $true)][string]$PublicUrl
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Decode-Text([string]$Value) {
  return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = "Codex Remote Bridge"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$status = $menu.Items.Add((Decode-Text "Q29kZXggUmVtb3RlIOW3sui/kOihjA=="))
$status.Enabled = $false
$open = $menu.Items.Add((Decode-Text "5omT5byAIFdlYiDmjqfliLblj7A="))
$pair = $menu.Items.Add((Decode-Text "55Sf5oiQ5omL5py66YWN5a+556CB"))
$exit = $menu.Items.Add((Decode-Text "6YCA5Ye6IEJyaWRnZQ=="))

$open.Add_Click({ Start-Process $PublicUrl })
$pair.Add_Click({
  try {
    $response = Invoke-RestMethod -Method Post -Uri "$LocalBaseUrl/api/pairing/start"
    $message = "$(Decode-Text '6YWN5a+556CB77ya')$($response.code)`n$(Decode-Text '5pyJ5pWI5pyfIDUg5YiG6ZKf44CC')"
    [System.Windows.Forms.MessageBox]::Show($message, "Codex Remote", "OK", "Information") | Out-Null
  } catch {
    $message = "$(Decode-Text '5peg5rOV55Sf5oiQ6YWN5a+556CB77ya')$($_.Exception.Message)"
    [System.Windows.Forms.MessageBox]::Show($message, "Codex Remote", "OK", "Error") | Out-Null
  }
})
$exit.Add_Click({
  try { Invoke-RestMethod -Method Post -Uri "$LocalBaseUrl/api/shutdown" | Out-Null } catch {}
})

$notify.ContextMenuStrip = $menu
$notify.Add_DoubleClick({ Start-Process $PublicUrl })

try {
  while (Get-Process -Id $BridgePid -ErrorAction SilentlyContinue) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 200
  }
} finally {
  $notify.Visible = $false
  $notify.Dispose()
  $menu.Dispose()
}
