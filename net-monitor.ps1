# net-monitor.ps1 - long-running network speed + latency collector.
# Emits one JSON line per second to stdout: {"rx":<bytes/s>,"tx":<bytes/s>,"ping":<ms or null>}
# rx/tx: delta of Get-NetAdapterStatistics on the busiest physical Up adapter.
# ping:  async ICMP to -PingHost every 5s (default 223.5.5.5), last value reused between probes.
# Output pattern copied from nowplaying.ps1: WriteLine + Flush every second (node spawn reads line by line).
param(
  [string]$PingHost = '223.5.5.5'
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Names/descriptions to reject (virtual / tunnel / emulator adapters)
$badPattern = 'Loopback|vEthernet|Virtual|VMware|VirtualBox|Hyper-V|TAP|TUN|Tailscale|MuMu|Bluetooth|WSL|Docker|ZeroTier|Radmin|Hamachi|Npcap|Teredo|isatap|PPPoE-filter'

function Select-Adapter {
  # Pick the physical, Up adapter with the largest total byte count.
  try {
    $cands = @(Get-NetAdapter -Physical | Where-Object {
      $_.Status -eq 'Up' -and
      $_.Name -notmatch $badPattern -and
      $_.InterfaceDescription -notmatch $badPattern
    })
    if ($cands.Count -eq 0) {
      # Fallback: some NICs are not flagged Physical; use Virtual -eq $false instead.
      $cands = @(Get-NetAdapter | Where-Object {
        $_.Status -eq 'Up' -and $_.Virtual -eq $false -and
        $_.Name -notmatch $badPattern -and
        $_.InterfaceDescription -notmatch $badPattern
      })
    }
    if ($cands.Count -eq 0) { return $null }
    $best = $null
    $bestBytes = -1
    foreach ($a in $cands) {
      $st = Get-NetAdapterStatistics -Name $a.Name
      if ($st) {
        $tot = [long]$st.ReceivedBytes + [long]$st.SentBytes
        if ($tot -gt $bestBytes) { $bestBytes = $tot; $best = $a.Name }
      }
    }
    return $best
  } catch { return $null }
}

# --- ping state (async so the 1s output cadence is never blocked) ---
$pinger = New-Object System.Net.NetworkInformation.Ping
$script:pingTask = $null
$script:lastPing = 'null'   # JSON literal: number as string, or 'null'
$pingIntervalSec = 5
$script:sincePing = $pingIntervalSec  # fire on first iteration

function Read-PingTask {
  # If the in-flight ping finished, record its result (null on any failure).
  if ($null -ne $script:pingTask -and $script:pingTask.IsCompleted) {
    $script:lastPing = 'null'
    try {
      if ($script:pingTask.Status -eq 'RanToCompletion') {
        $reply = $script:pingTask.Result
        if ($reply -and $reply.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) {
          $script:lastPing = [string][long]$reply.RoundtripTime
        }
      }
    } catch { $script:lastPing = 'null' }
    $script:pingTask = $null
  }
}

# --- adapter / counter state ---
$adapterName = Select-Adapter
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$prevRx = $null
$prevTx = $null
$prevSec = 0.0
if ($adapterName) {
  $st = Get-NetAdapterStatistics -Name $adapterName
  if ($st) {
    $prevRx = [long]$st.ReceivedBytes
    $prevTx = [long]$st.SentBytes
    $prevSec = $sw.Elapsed.TotalSeconds
  }
}

while ($true) {
  Start-Sleep -Milliseconds 1000

  Read-PingTask
  $script:sincePing++
  if ($script:sincePing -ge $pingIntervalSec -and $null -eq $script:pingTask) {
    try { $script:pingTask = $pinger.SendPingAsync($PingHost, 1500) } catch { $script:pingTask = $null }
    $script:sincePing = 0
  }

  $rx = 0
  $tx = 0
  $ok = $false
  if ($adapterName) {
    try {
      $st = Get-NetAdapterStatistics -Name $adapterName
      if ($st) {
        $nowSec = $sw.Elapsed.TotalSeconds
        $curRx = [long]$st.ReceivedBytes
        $curTx = [long]$st.SentBytes
        if ($null -ne $prevRx) {
          $dt = $nowSec - $prevSec
          if ($dt -gt 0.2) {
            $dRx = $curRx - $prevRx
            $dTx = $curTx - $prevTx
            if ($dRx -lt 0) { $dRx = 0 }   # counter reset guard
            if ($dTx -lt 0) { $dTx = 0 }
            $rx = [long][Math]::Round($dRx / $dt)
            $tx = [long][Math]::Round($dTx / $dt)
          }
        }
        $prevRx = $curRx
        $prevTx = $curTx
        $prevSec = $nowSec
        $ok = $true
      }
    } catch { $ok = $false }
  }
  if (-not $ok) {
    # Adapter gone (unplugged / renamed) - try to re-select next second.
    $adapterName = Select-Adapter
    $prevRx = $null
    $prevTx = $null
  }

  Read-PingTask   # catch a ping that completed within this same second

  $out = '{"rx":' + $rx + ',"tx":' + $tx + ',"ping":' + $script:lastPing + '}'
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
