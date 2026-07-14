# Reload the sidescreen kiosk: kill only the dedicated-profile Edge, then relaunch via start script.
# Called by server.js /api/system/reload-kiosk (admin console button).
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
         Where-Object { $_.CommandLine -like '*sidescreen-edge*' }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 700
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-sidescreen.ps1')
