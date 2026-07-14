# Disk I/O (bytes/sec, all physical disks) + process count. One JSON line every ~2s.
# Spawned by server.js (node child_process). ASCII-only source. Mirrors nowplaying.ps1 flush pattern.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$counters = @('\PhysicalDisk(_Total)\Disk Read Bytes/sec', '\PhysicalDisk(_Total)\Disk Write Bytes/sec')
while ($true) {
  $read = 0.0; $write = 0.0
  try {
    $s = (Get-Counter -Counter $counters -ErrorAction Stop).CounterSamples
    foreach ($c in $s) {
      if ($c.Path -like '*read*') { $read = [double]$c.CookedValue }
      elseif ($c.Path -like '*write*') { $write = [double]$c.CookedValue }
    }
  } catch {}
  $procs = 0
  try { $procs = (Get-Process -ErrorAction Stop).Count } catch {}

  $obj = @{ diskRead = [int64]$read; diskWrite = [int64]$write; procs = $procs }
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1500
}
