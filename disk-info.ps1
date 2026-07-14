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
try {
  $pds = @(Get-PhysicalDisk -ErrorAction Stop)
  foreach ($pd in $pds) {
    try {
      $rc = $pd | Get-StorageReliabilityCounter -ErrorAction Stop
      if ($rc -and $null -ne $rc.Temperature -and [int]$rc.Temperature -gt 0) {
        $temps += [pscustomobject]@{
          name = [string]$pd.FriendlyName
          c    = [int]$rc.Temperature
        }
      }
    } catch { }
  }
} catch { }

if ($temps.Count -eq 0) {
  # Fallback: SMART thermal data via root/wmi (usually admin-only; swallow all errors).
  try {
    $thermals = @(Get-CimInstance -Namespace root/wmi -ClassName MSStorageDriver_FailurePredictThresholds -ErrorAction Stop)
    if ($thermals.Count -gt 0) {
      $smart = @(Get-CimInstance -Namespace root/wmi -ClassName MSStorageDriver_FailurePredictData -ErrorAction Stop)
      foreach ($s in $smart) {
        try {
          $v = $s.VendorSpecific
          # SMART attribute table starts at byte 2, 12 bytes per entry: [id][flags2][value][worst][raw5...]
          for ($i = 2; $i -lt ($v.Length - 12); $i += 12) {
            $id = $v[$i]
            if ($id -eq 194 -or $id -eq 190) {
              $c = [int]$v[$i + 5]   # first raw byte = temperature in C
              if ($c -gt 0 -and $c -lt 100) {
                $nm = [string]$s.InstanceName
                $temps += [pscustomobject]@{ name = $nm; c = $c }
              }
              break
            }
          }
        } catch { }
      }
    }
  } catch { }
}

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
