# 璇?Windows 绯荤粺濯掍綋淇℃伅(SMTC/GSMTC): 褰撳墠姝屽悕/鑹烘湳瀹?杩涘害/鎾斁鐘舵€併€?# 姣?~1s 鍚?stdout 杈撳嚭涓€琛?JSON銆俿erver.js 浣滀负瀛愯繘绋嬭鍙栥€?# 鍙彇鍏冩暟鎹?涓嶅惈姝岃瘝); 姝岃瘝鐢辨湇鍔＄鍙﹀幓 lrclib 鏌ャ€?$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $t) {
  $m = $asTaskGeneric.MakeGenericMethod($t)
  $task = $m.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]

# Album art via tools\SmtcCover.dll (pure WinRT + MTA thread inside; PS-level WinRT interface
# projection is broken in 5.1, and WinRT async never completes on a blocked STA thread)
try { Add-Type -Path (Join-Path $PSScriptRoot 'tools\SmtcCover.dll') } catch {}
$coverPath = Join-Path $PSScriptRoot 'np-cover.img'
$coverKey = ''; $coverTs = 0; $coverTry = 0
function DumpCover($media) {
  try {
    $b = [SmtcCover]::Get()
    if (-not $b -or $b.Length -lt 100) { return 0 }
    [IO.File]::WriteAllBytes($coverPath, $b)
    return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } catch { return 0 }
}

function JsonEsc($s) {
  if ($null -eq $s) { return '' }
  return ($s -replace '\\', '\\' -replace '"', '\"' -replace "`r", '' -replace "`n", ' ' -replace "`t", ' ')
}

# SMTC session manager: create ONCE and reuse across the loop. The old code called
# RequestAsync() every second, which rebuilt the manager and pinned BOTH this script
# and the NPSMSvc system service near 100% of a core. Reuse GetCurrentSession() instead.
$mgr = $null
try { $mgr = Await ($mgrType::RequestAsync()) $mgrType } catch {}

while ($true) {
  $out = '{"playing":false}'
  try {
    if ($null -eq $mgr) { $mgr = Await ($mgrType::RequestAsync()) $mgrType }
    $session = $mgr.GetCurrentSession()
    if ($session) {
      $media = Await ($session.TryGetMediaPropertiesAsync()) $propType
      $tl = $session.GetTimelineProperties()
      $pb = $session.GetPlaybackInfo()
      $status = [int]$pb.PlaybackStatus   # 4=Playing 5=Paused
      $isPlaying = ($status -eq 4)
      $posSec = [Math]::Round($tl.Position.TotalSeconds, 2)
      $durSec = [Math]::Round($tl.EndTime.TotalSeconds, 2)
      $lastUpd = [DateTimeOffset]$tl.LastUpdatedTime
      $lastUpdMs = $lastUpd.ToUnixTimeMilliseconds()
      $title = JsonEsc $media.Title
      $artist = JsonEsc $media.Artist
      $album = JsonEsc $media.AlbumTitle
      $k = "$title|$artist|$album"
      if ($k -ne $coverKey) { $coverKey = $k; $coverTs = 0; $coverTry = 0 }
      if ($coverTs -eq 0 -and $coverTry -lt 6) { $coverTry++; $coverTs = DumpCover $media }
      $out = '{"playing":' + ($isPlaying.ToString().ToLower()) +
        ',"title":"' + $title + '","artist":"' + $artist + '","album":"' + $album +
        '","pos":' + $posSec + ',"dur":' + $durSec + ',"posAt":' + $lastUpdMs + ',"cover":' + $coverTs + '}'
    }
  } catch { $out = '{"playing":false,"err":1}' }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}

