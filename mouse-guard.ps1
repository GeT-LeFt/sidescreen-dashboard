# Mouse guard v2: kernel-enforced cursor fence (ClipCursor).
# Confines the cursor to the bounding box of "allowed" monitors, so it can
# never enter the display-only screens (960x640 side screen, 3840x1100 strip).
# Unlike the old WH_MOUSE_LL hook version, ClipCursor is enforced by the
# kernel: no hook timeouts, no silent removal, blocks SetCursorPos too.
#
# Touch note: touch on the strip screen goes to pointer-aware apps (Edge etc.)
# directly; the emulated cursor stays clamped inside the fence.
#
# Apps (games, alt-tab, UAC) may reset the clip; we re-apply every 2s and the
# re-apply also warps a escaped cursor back inside. Cheap: one syscall/tick.
#
# Modes: -Mode toggle (desktop shortcut) | on (server) | off (server)
# ASCII only (PS 5.1 + no BOM).
param([ValidateSet('toggle','on','off')][string]$Mode = 'toggle')
$ErrorActionPreference = 'SilentlyContinue'

$log = Join-Path $PSScriptRoot 'mouse-guard.log'
function L($m) { "$([DateTime]::Now.ToString('MM-dd HH:mm:ss')) $m" | Out-File -FilePath $log -Append -Encoding ascii }
# state file for the dashboard UI: {"state":"fence|lock|yield|off","detail":"...","ts":epochMs}
$stateFile = Join-Path $PSScriptRoot 'mouse-guard.state.json'
function WriteState($s, $detail) {
  $ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  ('{"state":"' + $s + '","detail":"' + $detail + '","ts":' + $ts + '}') | Out-File -FilePath $stateFile -Encoding ascii
}

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class MouseFence {
  delegate bool MonEnumProc(IntPtr hMon, IntPtr hdc, ref RECT rc, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonEnumProc fn, IntPtr data);
  [DllImport("user32.dll")] static extern bool ClipCursor(ref RECT r);
  [DllImport("user32.dll", EntryPoint="ClipCursor")] static extern bool ClipCursorPtr(IntPtr rect);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, System.Text.StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  static bool IsForbidden(int w, int h) {
    if (w == 960 && h == 640) return true;      // small side screen
    if (w == 3840 && h == 1100) return true;    // wide strip screen
    return false;
  }

  // recompute allowed bounding box (physical pixels) and clip the cursor to it.
  // returns a description string; empty if no allowed monitor found (no clip applied).
  public static string Apply() {
    SetThreadDpiAwarenessContext((IntPtr)(-4));
    int l = int.MaxValue, t = int.MaxValue, r = int.MinValue, b = int.MinValue;
    int allowed = 0; string desc = "";
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr hm, IntPtr hdc, ref RECT rc, IntPtr d) {
      int w = rc.R - rc.L, h = rc.B - rc.T;
      bool bad = IsForbidden(w, h);
      desc += "(" + rc.L + "," + rc.T + " " + w + "x" + h + (bad ? " BLOCKED) " : " allowed) ");
      if (!bad) { allowed++; if (rc.L < l) l = rc.L; if (rc.T < t) t = rc.T; if (rc.R > r) r = rc.R; if (rc.B > b) b = rc.B; }
      return true;
    }, IntPtr.Zero);
    if (allowed == 0) { ClipCursorPtr(IntPtr.Zero); return ""; }
    RECT clip; clip.L = l; clip.T = t; clip.R = r; clip.B = b;
    ClipCursor(ref clip);
    return "fence[" + l + "," + t + " -> " + r + "," + b + "] " + desc;
  }

  public static void Release() { ClipCursorPtr(IntPtr.Zero); }

  // Inspect the foreground window. Returns "" unless it is a fullscreen/
  // borderless window covering an entire ALLOWED monitor, in which case
  // returns "procname|L|T|R|B" (the monitor rect). Fullscreen windows on the
  // display-only screens (Edge kiosk) return "".
  public static string ForegroundFullscreen() {
    SetThreadDpiAwarenessContext((IntPtr)(-4));
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero || h == GetShellWindow()) return "";
    System.Text.StringBuilder sb = new System.Text.StringBuilder(64);
    GetClassName(h, sb, 64);
    string cls = sb.ToString();
    if (cls == "WorkerW" || cls == "Progman") return "";      // desktop shell covers a monitor too
    RECT wr; if (!GetWindowRect(h, out wr)) return "";
    MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    IntPtr mon = MonitorFromWindow(h, 2 /*NEAREST*/);
    if (!GetMonitorInfo(mon, ref mi)) return "";
    RECT mr = mi.rcMonitor;
    if (IsForbidden(mr.R - mr.L, mr.B - mr.T)) return "";     // kiosk screens: keep fencing
    if (!(wr.L <= mr.L && wr.T <= mr.T && wr.R >= mr.R && wr.B >= mr.B)) return "";
    string name = "";
    uint pid; GetWindowThreadProcessId(h, out pid);
    try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLower(); } catch {}
    return name + "|" + mr.L + "|" + mr.T + "|" + mr.R + "|" + mr.B;
  }

  public static void ClipTo(int l, int t, int r, int b) {
    RECT rc; rc.L = l; rc.T = t; rc.R = r; rc.B = b;
    ClipCursor(ref rc);
  }
}
"@

# find other real instances (self-match trap: require '-File <whitespace> ... mouse-guard.ps1')
$others = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match '-File\s+\S*mouse-guard\.ps1' }

if ($Mode -eq 'off' -or ($Mode -eq 'toggle' -and $others)) {
  if ($others) { $others | ForEach-Object { Stop-Process -Id $_.ProcessId -Force } }
  Start-Sleep -Milliseconds 200
  [MouseFence]::Release()   # lift the fence after killing the keeper
  WriteState 'off' ''
  L "OFF ($Mode, killed $((@($others)).Count))"
  exit 0
}
if ($others) { exit 0 }   # mode 'on' and already running

# game processes that get GAME-LOCK (fence tightened to the game's monitor so
# menu-screen cursor cannot drift to the other main monitor in borderless mode).
# Other fullscreen apps (video etc.) just yield. Override via config.json
# mouseGuard.games array.
$games = @('cs2','csgo','valorant','cf','crossfire','r5apex','league of legends','overwatch')
$cfgPath = Join-Path $PSScriptRoot 'config.json'
$cfgStamp = [DateTime]::MinValue
function Load-Games {
  try {
    $c = Get-Content $script:cfgPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($c.mouseGuard -and $c.mouseGuard.games -and @($c.mouseGuard.games).Count -gt 0) {
      $script:games = @($c.mouseGuard.games | ForEach-Object { ([string]$_).ToLower() })
    }
  } catch {}
}
Load-Games

$desc = [MouseFence]::Apply()
L "ON v2(ClipCursor) $desc games=[$($games -join ',')]"
$last = $desc
$state = 'fence'   # fence | yield | lock
WriteState 'fence' ''
while ($true) {
  Start-Sleep -Seconds 2
  # hot-reload game list when config.json changes
  $st = (Get-Item $cfgPath -ErrorAction SilentlyContinue).LastWriteTime
  if ($st -and $st -ne $cfgStamp) { $cfgStamp = $st; Load-Games }

  $fg = [MouseFence]::ForegroundFullscreen()
  if ($fg) {
    $parts = $fg.Split('|')
    $proc = $parts[0]
    if ($games -contains $proc) {
      # game-lock: tighten fence to the game's monitor (covers borderless menu drift)
      [MouseFence]::ClipTo([int]$parts[1], [int]$parts[2], [int]$parts[3], [int]$parts[4])
      if ($state -ne 'lock') { $state = 'lock'; WriteState 'lock' $proc; L "game-lock: $proc -> monitor $($parts[1]),$($parts[2])-$($parts[3]),$($parts[4])" }
    } else {
      # unknown fullscreen app (video etc.): yield, do not fight its own clip
      if ($state -ne 'yield') { $state = 'yield'; WriteState 'yield' $proc; L "yield: fullscreen '$proc'" }
    }
    continue
  }
  if ($state -ne 'fence') { $state = 'fence'; WriteState 'fence' ''; L "resume fencing" }
  $d = [MouseFence]::Apply()    # re-apply: heals resets by other apps, re-captures escaped cursor
  if ($d -ne $last) { L "screens changed: $d"; $last = $d }
}
