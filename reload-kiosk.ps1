# Reload the sidescreen kiosk: close only the two dashboard windows, then relaunch via start script.
# Called by server.js /api/system/reload-kiosk (admin console button).
param([switch]$SkipScreenGuard)
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {
  $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like '*副屏仪表盘*' -or $_.MainWindowTitle -like '*宽屏仪表盘*')
}
foreach ($p in $procs) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 700
$startArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-sidescreen.ps1'))
if ($SkipScreenGuard) { $startArguments += '-SkipScreenGuard' }
& powershell @startArguments
