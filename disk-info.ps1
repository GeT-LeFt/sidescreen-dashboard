# disk-info.ps1 -- one-shot disk info collector, spawned by node every 60s.
# Prints ONE line of JSON to stdout then exits:
#   {"drives":[{"letter":"C","freeGB":123.4,"totalGB":465.1}],"temps":[{"name":"...","c":42}]}
# ASCII-only source. Never throws, never prompts UAC; temps fall back to [].
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---- drives (fixed disks only) ----
$drives = @()
try {
  $disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction Stop)
  foreach ($d in $disks) {
    if ($null -eq $d.Size -or $d.Size -eq 0) { continue }
    $drives += [pscustomobject]@{
      letter  = ($d.DeviceID -replace ':', '')
      freeGB  = [math]::Round([double]$d.FreeSpace / 1GB, 1)
      totalGB = [math]::Round([double]$d.Size / 1GB, 1)
    }
  }
} catch { }

# ---- temps (best effort, empty array if unavailable) ----
$temps = @()
# Disk-temperature collection DISABLED on this machine. Get-StorageReliabilityCounter
# returns Access-Denied (needs admin) and MSStorageDriver_* is Not-Supported on these
# NVMe drives, so 'temps' was ALWAYS empty -- yet every 60s run spawned a ~2s PowerShell
# and produced ~89% of all WMI-Activity failures. Kept 'drives' (Win32_LogicalDisk) only.
# To restore temps later: run the dashboard elevated, or switch to an NVMe/StorageWMI
# reliability class that works here; the original block is in git history.

# ---- emit single-line JSON ----
$out = '{"drives":[],"temps":[]}'
try {
  $result = New-Object System.Collections.Specialized.OrderedDictionary
  $result.Add('drives', @($drives))
  $result.Add('temps', @($temps))
  $out = ConvertTo-Json -InputObject $result -Compress -Depth 4
} catch { }
[Console]::Out.WriteLine($out)
[Console]::Out.Flush()
exit 0
