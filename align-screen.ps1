# 副屏对齐：检测 960x640 那块固定分辨率的屏，把 kiosk 窗口投上去。一次性，跑完就退。
# 必须在"有桌面访问权"的进程里运行（交互式计划任务 / 登录会话），否则枚举不到窗口。
$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $PSScriptRoot 'align.log'
function L($m) { "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Out-File -FilePath $log -Append -Encoding utf8; Write-Host $m }
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WM {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  // 隐藏该屏幕上的 Windows 副任务栏(与 kiosk 同为置顶窗口, 抢 z 序压不稳, 直接隐藏; 只影响这一块屏)
  public static int HideTrayOn(int sx, int sy, int sw, int sh) {
    int n = 0; IntPtr h = IntPtr.Zero;
    while ((h = FindWindowEx(IntPtr.Zero, h, "Shell_SecondaryTrayWnd", null)) != IntPtr.Zero) {
      RECT r; GetWindowRect(h, out r);
      int cx = (r.L + r.R) / 2, cy = (r.T + r.B) / 2;
      if (cx >= sx && cx < sx + sw && cy >= sy && cy < sy + sh) { ShowWindow(h, 0); n++; }
    }
    return n;
  }
  public struct RECT { public int L,T,R,B; }
}
"@
[WM]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null   # PER_MONITOR_AWARE_V2，坐标用物理像素
Add-Type -AssemblyName System.Windows.Forms

# 检测副屏：优先 960x640，找不到取最小的非主屏
$side = [System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Bounds.Width -eq 960 -and $_.Bounds.Height -eq 640 } | Select-Object -First 1
if (-not $side) { $side = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Sort-Object { $_.Bounds.Width * $_.Bounds.Height } | Select-Object -First 1 }
if (-not $side) { L("align: no side screen"); exit 1 }

function Align-Window($titleLike, $notLike, $scr, $tag) {
  if (-not $scr) { L("align: $tag screen not present, skipped"); return }
  $procs = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like $titleLike }
  if ($notLike) { $procs = $procs | Where-Object { $_.MainWindowTitle -notlike $notLike } }
  $proc = $procs | Select-Object -First 1
  if (-not $proc) { L("align: $tag kiosk window not found"); return }
  $hwnd = $proc.MainWindowHandle
  $sx = $scr.Bounds.X; $sy = $scr.Bounds.Y; $sw = $scr.Bounds.Width; $sh = $scr.Bounds.Height
  [WM]::SetWindowPos($hwnd, [IntPtr]::new(-1), 0,0,0,0, 0x0027) | Out-Null          # FRAMECHANGED + HWND_TOPMOST(盖副屏任务栏)
  [WM]::SetWindowPos($hwnd, [IntPtr]::new(-1), $sx, $sy, $sw, $sh, 0x0040) | Out-Null  # SHOWWINDOW
  Start-Sleep -Milliseconds 300
  $tray = [WM]::HideTrayOn($sx, $sy, $sw, $sh)   # 顺手隐藏这块屏自己的 Windows 任务栏
  $r = New-Object 'WM+RECT'; [WM]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  L("align: $tag -> ($sx,$sy) ${sw}x${sh}; now ($($r.L),$($r.T)) $($r.R-$r.L)x$($r.B-$r.T); tray hidden=$tray")
}

$wide = [System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Bounds.Width -eq 3840 -and $_.Bounds.Height -eq 1100 } | Select-Object -First 1
Align-Window '*副屏仪表盘*' '*宽屏仪表盘*' $side 'small'
Align-Window '*宽屏仪表盘*' $null $wide 'wide'
