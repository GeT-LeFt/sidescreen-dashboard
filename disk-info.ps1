# disk-info.ps1 -- legacy one-shot fallback; server.js now uses Node fs.statfs directly.
# Prints ONE line of JSON to stdout then exits:
#   {"drives":[{"letter":"C","freeGB":123.4,"totalGB":465.1}],"temps":[{"name":"...","c":42}]}
# ASCII-only source. Never throws, never prompts UAC; temps fall back to [].
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---- drives (only system root + this project root; never probe removable/card-reader letters) ----
$drives = @()
try {
  $roots = @([IO.Path]::GetPathRoot($env:SystemRoot), [IO.Path]::GetPathRoot($PSScriptRoot)) |
    Where-Object { $_ } | Select-Object -Unique
  foreach ($root in $roots) {
    $d = New-Object System.IO.DriveInfo($root)
    if (-not $d.IsReady -or $d.TotalSize -le 0) { continue }
    $drives += [pscustomobject]@{
      letter  = ($d.Name -replace '[:\\/]', '')
      freeGB  = [math]::Round([double]$d.AvailableFreeSpace / 1GB, 1)
      totalGB = [math]::Round([double]$d.TotalSize / 1GB, 1)
    }
  }
} catch { }

# ---- temps (best effort, empty array if unavailable) ----
$temps = @()
# Disk-temperature collection DISABLED on this machine. Get-StorageReliabilityCounter
# returns Access-Denied (needs admin) and MSStorageDriver_* is Not-Supported on these
# NVMe drives, so 'temps' was ALWAYS empty. Capacity now uses DriveInfo with two explicit roots.
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
