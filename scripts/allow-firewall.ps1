$ErrorActionPreference = 'Stop'

try {
  Remove-NetFirewallRule -DisplayName 'CamNet' -ErrorAction SilentlyContinue
  New-NetFirewallRule `
    -DisplayName 'CamNet' `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 3000,3443 `
    -Profile Any | Out-Null

  Write-Host ''
  Write-Host 'Done. Ports 3000 and 3443 are now allowed on all network profiles.' -ForegroundColor Green
  Write-Host 'You can close this window and start CamNet.' -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host ('Failed: ' + $_.Exception.Message) -ForegroundColor Red
}
