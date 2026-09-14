# Legacy PowerShell fallback. server.js normally uses native typeperf now.
# If launched manually, sample only physical disk 0 (C:/D:) and never _Total/card-reader LUNs.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$counters = @('\PhysicalDisk(0*)\Disk Read Bytes/sec', '\PhysicalDisk(0*)\Disk Write Bytes/sec')
$procs = 0
$tick = 0
while ($true) {
  $read = 0.0; $write = 0.0
  try {
    $s = (Get-Counter -Counter $counters -ErrorAction Stop).CounterSamples
    foreach ($c in $s) {
      if ($c.Path -like '*read*') { $read = [double]$c.CookedValue }
      elseif ($c.Path -like '*write*') { $write = [double]$c.CookedValue }
    }
  } catch {}
  if ($tick % 6 -eq 0) {
    try { $procs = (Get-Process -ErrorAction Stop).Count } catch {}
  }
  $tick++

  $obj = @{ diskRead = [int64]$read; diskWrite = [int64]$write; procs = $procs }
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Seconds 5
}
