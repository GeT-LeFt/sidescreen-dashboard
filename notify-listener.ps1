# Long-running Windows notification listener (WinRT UserNotificationListener).
# Reads Action Center toasts, incl. Phone Link mirrored phone notifications.
# First line: {"status":"allowed"|"denied"|"unsupported"} (RequestAccessAsync result).
# Then polls every 2s; for each NEW notification (dedup by Id) emits one JSON line:
#   {"app":"...","title":"...","body":"...","ts":<unix ms>}
# stdout pattern copied from nowplaying.ps1: WriteLine + Flush per line,
# so a node child_process reader gets unbuffered lines.
$ErrorActionPreference = 'SilentlyContinue'
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

function JsonEsc($s) {
  if ($null -eq $s) { return '' }
  return ($s -replace '\\', '\\' -replace '"', '\"' -replace "`r", '' -replace "`n", ' ' -replace "`t", ' ')
}

function Emit($line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

$status = 'unsupported'
$listener = $null
try {
  [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null

  $listenerType = [Windows.UI.Notifications.Management.UserNotificationListener]
  $accessType = [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]
  $listener = $listenerType::Current
  if ($listener) {
    $access = Await ($listener.RequestAccessAsync()) $accessType
    switch ([int]$access) {
      1 { $status = 'allowed' }   # Allowed
      2 { $status = 'denied' }    # Denied
      default { $status = 'denied' }  # Unspecified -> treat as denied
    }
  }
} catch {
  $status = 'unsupported'
}

Emit ('{"status":"' + $status + '"}')
if ($status -ne 'allowed') { exit 0 }

$unType = [Windows.UI.Notifications.UserNotification]
$listType = [System.Collections.Generic.IReadOnlyList`1].MakeGenericType($unType)
$toastKind = [Windows.UI.Notifications.NotificationKinds]::Toast
$toastBinding = [Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric

$seen = New-Object 'System.Collections.Generic.HashSet[uint32]'
$first = $true   # seed pre-existing notifications silently on first poll

while ($true) {
  try {
    $notifs = Await ($listener.GetNotificationsAsync($toastKind)) $listType
    if ($null -ne $notifs) {
      foreach ($n in $notifs) {
        $id = [uint32]$n.Id
        if (-not $seen.Add($id)) { continue }
        if ($first) { continue }
        $app = ''
        try { $app = $n.AppInfo.DisplayInfo.DisplayName } catch {}
        $title = ''
        $body = ''
        try {
          $binding = $n.Notification.Visual.GetBinding($toastBinding)
          if ($binding) {
            $i = 0
            $parts = @()
            foreach ($t in $binding.GetTextElements()) {
              if ($i -eq 0) { $title = $t.Text } else { $parts += $t.Text }
              $i++
            }
            $body = ($parts -join ' ')
          }
        } catch {}
        $ts = 0
        try { $ts = ([DateTimeOffset]$n.CreationTime).ToUnixTimeMilliseconds() } catch {}
        Emit ('{"app":"' + (JsonEsc $app) + '","title":"' + (JsonEsc $title) + '","body":"' + (JsonEsc $body) + '","ts":' + $ts + '}')
      }
      $first = $false
    }
  } catch {}
  Start-Sleep -Milliseconds 2000
}
