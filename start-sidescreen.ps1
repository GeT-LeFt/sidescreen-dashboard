# 副屏仪表盘一键启动：起服务 → 开 Edge kiosk → 移动到副屏
# 用法: 双击 start-sidescreen.cmd，或 powershell -ExecutionPolicy Bypass -File start-sidescreen.ps1
param([switch]$SkipScreenGuard)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 3777
$dashboardTopmost = $true
try {
  $savedConfig = Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($savedConfig.dashboardWindow.topmost -eq $false) { $dashboardTopmost = $false }
} catch { }
$dashboardZOrder = if ($dashboardTopmost) { [IntPtr]::new(-1) } else { [IntPtr]::new(-2) }

# 先声明 DPI 感知，后面所有坐标都是物理像素（混合缩放环境下必须最先做）
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WinMove {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtr")] static extern IntPtr GetWindowLongPtr64(IntPtr h, int index);
  [DllImport("user32.dll", EntryPoint="GetWindowLong")] static extern IntPtr GetWindowLongPtr32(IntPtr h, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtr")] static extern IntPtr SetWindowLongPtr64(IntPtr h, int index, IntPtr value);
  [DllImport("user32.dll", EntryPoint="SetWindowLong")] static extern IntPtr SetWindowLongPtr32(IntPtr h, int index, IntPtr value);

  public static void HideFromTaskbar(IntPtr h) {
    const int GWL_EXSTYLE = -20;
    const long WS_EX_TOOLWINDOW = 0x00000080L;
    const long WS_EX_APPWINDOW = 0x00040000L;
    IntPtr stylePtr = IntPtr.Size == 8 ? GetWindowLongPtr64(h, GWL_EXSTYLE) : GetWindowLongPtr32(h, GWL_EXSTYLE);
    IntPtr newStyle = new IntPtr((stylePtr.ToInt64() | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW);
    if (IntPtr.Size == 8) SetWindowLongPtr64(h, GWL_EXSTYLE, newStyle);
    else SetWindowLongPtr32(h, GWL_EXSTYLE, newStyle);
    // Edge(Chromium)靠 ITaskbarList 主动把自己注册进任务栏, 光改 WS_EX_TOOLWINDOW 无效;
    // 必须用 ITaskbarList::DeleteTab 显式移除按钮才可靠(2026-07-14 实证)。
    try { ITaskbarList tb = (ITaskbarList)new TaskbarListClass(); tb.HrInit(); tb.DeleteTab(h); Marshal.ReleaseComObject(tb); } catch {}
  }

  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  // 隐藏指定屏幕上的 Windows 副任务栏(Shell_SecondaryTrayWnd)。
  // 副任务栏和 kiosk 同为置顶窗口, z 序靠"最后激活"抢, 光 TOPMOST 压不稳(2026-07-14 实证);
  // 直接按屏幕范围隐藏该屏任务栏才干净, 且只影响这一块屏, Dell/主屏不受牵连。
  public static int HideTrayOn(int sx, int sy, int sw, int sh) {
    int n = 0; IntPtr h = IntPtr.Zero;
    while ((h = FindWindowEx(IntPtr.Zero, h, "Shell_SecondaryTrayWnd", null)) != IntPtr.Zero) {
      RECT r; GetWindowRect(h, out r);
      int cx = (r.L + r.R) / 2, cy = (r.T + r.B) / 2;
      if (cx >= sx && cx < sx + sw && cy >= sy && cy < sy + sh) { ShowWindow(h, 0); n++; }
    }
    return n;
  }
  public struct RECT { public int L, T, R, B; }
}

[ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ITaskbarList { void HrInit(); void AddTab(IntPtr h); void DeleteTab(IntPtr h); void ActivateTab(IntPtr h); void SetActiveAlt(IntPtr h); }
[ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
class TaskbarListClass { }
"@
[WinMove]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null   # PER_MONITOR_AWARE_V2

# 自动探测小副屏：只认 960x640；不在线就跳过，绝不能拿长条屏/普通屏顶替。
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$side = $screens | Where-Object { $_.Bounds.Width -eq 960 -and $_.Bounds.Height -eq 640 } | Select-Object -First 1
if ($side) {
  $screenX = $side.Bounds.X; $screenY = $side.Bounds.Y; $screenW = $side.Bounds.Width; $screenH = $side.Bounds.Height
  Write-Output ("side screen: {0} at ({1},{2}) {3}x{4}" -f $side.DeviceName, $screenX, $screenY, $screenW, $screenH)
} else { Write-Output "small screen (960x640) not present, skipped" }

# 1. 服务端（已在跑就跳过）
$alive = $false
try { Invoke-RestMethod "http://localhost:$port/api/stats" -TimeoutSec 2 | Out-Null; $alive = $true } catch {}
if (-not $alive) {
  Start-Process node -ArgumentList "`"$root\server.js`"" -WindowStyle Hidden -RedirectStandardOutput "$root\server.log" -RedirectStandardError "$root\server.err.log"
  foreach ($i in 1..20) {
    Start-Sleep -Milliseconds 500
    try { Invoke-RestMethod "http://localhost:$port/api/stats" -TimeoutSec 2 | Out-Null; $alive = $true; break } catch {}
  }
  if (-not $alive) { Write-Error "服务端启动失败"; exit 1 }
}

# 2. 小屏 Edge kiosk（独立配置目录，不影响日常 Edge）；屏不在就完全跳过。
if ($side) {
$smallUp = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*副屏仪表盘*' -and $_.MainWindowTitle -notlike '*宽屏仪表盘*' } | Select-Object -First 1
if (-not $smallUp) { Start-Process msedge -ArgumentList @(
  "--user-data-dir=$env:LOCALAPPDATA\sidescreen-edge",
  '--kiosk', "http://localhost:$port",
  '--edge-kiosk-type=fullscreen',
  '--no-first-run',
  '--disable-extensions',
  '--disable-sync',
  '--no-default-browser-check',
  '--disable-features=msImplicitSignin,msSeamlessWebToBrowserSignIn'
)}

# 3. 把 kiosk 窗口移到副屏
$hwnd = [IntPtr]::Zero
foreach ($i in 1..30) {
  Start-Sleep -Milliseconds 500
  $w = Get-Process msedge -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*副屏仪表盘*' } |
       Select-Object -First 1
  if ($w) { $hwnd = $w.MainWindowHandle; break }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Error "没找到 kiosk 窗口"; exit 1 }

# 工具窗口不在任务栏显示；FRAMECHANGED 让 Explorer 立即刷新窗口类型。
[WinMove]::HideFromTaskbar($hwnd)
# HWND_TOPMOST(-1): 置顶才能盖住副屏自己的 Windows 任务栏(Shell_SecondaryTrayWnd), 不影响主屏/Dell 的任务栏
[WinMove]::SetWindowPos($hwnd, $dashboardZOrder, 0, 0, 0, 0, 0x0033) | Out-Null
[WinMove]::SetWindowPos($hwnd, $dashboardZOrder, $screenX, $screenY, $screenW, $screenH, 0x0050) | Out-Null
Start-Sleep -Milliseconds 800
$r = New-Object 'WinMove+RECT'
[WinMove]::GetWindowRect($hwnd, [ref]$r) | Out-Null
[WinMove]::HideFromTaskbar($hwnd)   # 安顿后再移除一次(Edge 首帧可能重新注册任务栏)
[WinMove]::HideTrayOn($screenX, $screenY, $screenW, $screenH) | Out-Null   # 隐藏这块屏自己的 Windows 任务栏
Write-Output ("dashboard at X={0} Y={1} {2}x{3}" -f $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T))
}

# 4. 宽副屏(3840x1100 长条屏)kiosk —— 屏不在就跳过
$wide = $screens | Where-Object { $_.Bounds.Width -eq 3840 -and $_.Bounds.Height -eq 1100 } | Select-Object -First 1
if ($wide) {
  $wx = $wide.Bounds.X; $wy = $wide.Bounds.Y
  $wideUp = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*宽屏仪表盘*' } | Select-Object -First 1
  if (-not $wideUp) {
    Start-Process msedge -ArgumentList @(
      "--user-data-dir=$env:LOCALAPPDATA\sidescreen-edge-wide",
      '--kiosk', "http://localhost:$port/wide",
      '--edge-kiosk-type=fullscreen',
      '--no-first-run', '--disable-extensions', '--disable-sync', '--no-default-browser-check',
      '--disable-features=msImplicitSignin,msSeamlessWebToBrowserSignIn'
    )
  }
  $whwnd = [IntPtr]::Zero
  foreach ($i in 1..30) {
    Start-Sleep -Milliseconds 500
    $w2 = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*宽屏仪表盘*' } | Select-Object -First 1
    if ($w2) { $whwnd = $w2.MainWindowHandle; break }
  }
  if ($whwnd -ne [IntPtr]::Zero) {
    [WinMove]::HideFromTaskbar($whwnd)
    [WinMove]::SetWindowPos($whwnd, $dashboardZOrder, 0, 0, 0, 0, 0x0033) | Out-Null
    [WinMove]::SetWindowPos($whwnd, $dashboardZOrder, $wx, $wy, 3840, 1100, 0x0050) | Out-Null
    Start-Sleep -Milliseconds 600
    $r = New-Object 'WinMove+RECT'
    [WinMove]::GetWindowRect($whwnd, [ref]$r) | Out-Null
    [WinMove]::HideFromTaskbar($whwnd)   # 安顿后再移除一次
    [WinMove]::HideTrayOn($wx, $wy, 3840, 1100) | Out-Null   # 隐藏长条屏自己的 Windows 任务栏
    Write-Output ("wide dashboard at X={0} Y={1} {2}x{3}" -f $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T))
  } else { Write-Output "wide kiosk window not found" }
} else { Write-Output "wide screen (3840x1100) not present, skipped" }

# 5. 普通应用窗口守卫：副屏只留仪表盘；应用若记住副屏位置，自动搬回最近使用的大屏。
$guardScript = Join-Path $root 'screen-role-guard.ps1'
# The guard owns a named mutex, so duplicate launch attempts exit without a WMI process scan.
if (-not $SkipScreenGuard -and (Test-Path $guardScript)) {
  Start-Process powershell -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',("`"$guardScript`""),'-Mode','watch')
}
