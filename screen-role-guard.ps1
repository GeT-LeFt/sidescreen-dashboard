# Screen role guard: keep ordinary application windows on the two work monitors.
# Physical side screens are display-only and may contain only the two dashboard kiosks.
# Device identity is primary; resolution is only a fallback when Windows omits EDID data.
param(
  [ValidateSet('watch','once')][string]$Mode = 'watch',
  [switch]$DryRun
)
$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $PSScriptRoot 'screen-role-guard.log'
function L($m) { "$([DateTime]::Now.ToString('MM-dd HH:mm:ss')) $m" | Out-File $log -Append -Encoding utf8 }

# start-sidescreen.ps1 can be run repeatedly. Duplicate watch attempts exit without WMI process scans.
$guardMutex = $null
if ($Mode -eq 'watch') {
  $guardMutex = New-Object System.Threading.Mutex($false, 'Local\SidescreenRoleGuard')
  $ownsGuardMutex = $false
  try { $ownsGuardMutex = $guardMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsGuardMutex = $true }
  if (-not $ownsGuardMutex) { exit 0 }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class ScreenRoleNative {
  const uint QDC_ONLY_ACTIVE_PATHS = 2;
  const int GET_SOURCE_NAME = 1, GET_TARGET_NAME = 2;
  const int GWL_EXSTYLE = -20;
  const long WS_EX_TOOLWINDOW = 0x80;
  const int SW_RESTORE = 9, SW_MAXIMIZE = 3;
  const uint SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;
  const uint MONITOR_DEFAULTTONEAREST = 2;
  const int DWMWA_CLOAKED = 14;
  static HashSet<string> blocked = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  static HashSet<string> work = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  static string lastWork = null;

  [StructLayout(LayoutKind.Sequential)] struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)] struct SOURCE_INFO { public LUID adapterId; public uint id, modeInfoIdx, statusFlags; }
  [StructLayout(LayoutKind.Sequential)] struct RATIONAL { public uint Numerator, Denominator; }
  [StructLayout(LayoutKind.Sequential)] struct TARGET_INFO { public LUID adapterId; public uint id, modeInfoIdx, outputTechnology, rotation, scaling; public RATIONAL refreshRate; public uint scanLineOrdering; [MarshalAs(UnmanagedType.Bool)] public bool targetAvailable; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] struct PATH_INFO { public SOURCE_INFO sourceInfo; public TARGET_INFO targetInfo; public uint flags; }
  [StructLayout(LayoutKind.Explicit, Size=64)] struct MODE_INFO { [FieldOffset(0)] public uint infoType; [FieldOffset(4)] public uint id; [FieldOffset(8)] public LUID adapterId; }
  [StructLayout(LayoutKind.Sequential)] struct HEADER { public int type; public uint size; public LUID adapterId; public uint id; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SOURCE_NAME { public HEADER header; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string viewGdiDeviceName; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct TARGET_NAME { public HEADER header; public uint flags, outputTechnology; public ushort edidManufactureId, edidProductCodeId; public uint connectorInstance; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string monitorFriendlyDeviceName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string monitorDevicePath; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct MONITORINFOEX { public int cbSize; public RECT rcMonitor, rcWork; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string device; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct DISPLAY_DEVICE { public int cb; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceString; public int StateFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceID; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceKey; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public delegate bool MonProc(IntPtr h, IntPtr dc, ref RECT r, IntPtr p);

  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint f, out uint p, out uint m);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint f, ref uint p, [Out] PATH_INFO[] pi, ref uint m, [Out] MODE_INFO[] mi, IntPtr t);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref SOURCE_NAME p);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref TARGET_NAME p);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFOEX m);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtr")] static extern IntPtr GetWindowLongPtr64(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint="GetWindowLong")] static extern IntPtr GetWindowLongPtr32(IntPtr h, int i);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool EnumDisplayDevices(string dev, uint i, ref DISPLAY_DEVICE d, uint flags);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonProc cb, IntPtr p);

  static long ExStyle(IntPtr h) { return (IntPtr.Size == 8 ? GetWindowLongPtr64(h,GWL_EXSTYLE) : GetWindowLongPtr32(h,GWL_EXSTYLE)).ToInt64(); }
  static MONITORINFOEX MI(IntPtr h) { MONITORINFOEX m=new MONITORINFOEX(); m.cbSize=Marshal.SizeOf(typeof(MONITORINFOEX)); GetMonitorInfo(h,ref m); return m; }
  static bool Covers(RECT a, RECT b) { return a.L<=b.L+4 && a.T<=b.T+4 && a.R>=b.R-4 && a.B>=b.B-4; }

  public static string[] ActivePaths() {
    List<string> z=new List<string>();
    for(uint i=0;i<32;i++) {
      DISPLAY_DEVICE a=new DISPLAY_DEVICE(); a.cb=Marshal.SizeOf(typeof(DISPLAY_DEVICE)); if(!EnumDisplayDevices(null,i,ref a,0))break;
      if((a.StateFlags&1)==0)continue; // DISPLAY_DEVICE_ATTACHED_TO_DESKTOP
      DISPLAY_DEVICE m=new DISPLAY_DEVICE(); m.cb=Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if(EnumDisplayDevices(a.DeviceName,0,ref m,0)) z.Add(a.DeviceName+"|"+m.DeviceID+"|"+m.DeviceString);
    }
    return z.ToArray();
  }

  public static string[] MonitorRows() {
    SetThreadDpiAwarenessContext((IntPtr)(-4)); List<string> z=new List<string>();
    EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr h,IntPtr dc,ref RECT r,IntPtr p){MONITORINFOEX m=MI(h);z.Add(m.device+"|"+(r.R-r.L)+"|"+(r.B-r.T)+"|"+m.flags);return true;},IntPtr.Zero);
    return z.ToArray();
  }

  public static void Configure(string[] blockedNames, string[] workNames) {
    blocked=new HashSet<string>(blockedNames,StringComparer.OrdinalIgnoreCase);
    work=new HashSet<string>(workNames,StringComparer.OrdinalIgnoreCase);
    if(lastWork!=null && !work.Contains(lastWork)) lastWork=null;
  }

  public static string[] DebugWindows() {
    SetThreadDpiAwarenessContext((IntPtr)(-4)); List<string> z=new List<string>();
    EnumWindows(delegate(IntPtr h,IntPtr p){if(!IsWindowVisible(h))return true;StringBuilder t=new StringBuilder(512);GetWindowText(h,t,512);if(t.Length==0)return true;RECT r;if(!GetWindowRect(h,out r))return true;MONITORINFOEX m=MI(MonitorFromWindow(h,MONITOR_DEFAULTTONEAREST));int c=0;DwmGetWindowAttribute(h,DWMWA_CLOAKED,out c,4);z.Add(t+"|dev="+m.device+"|rect="+r.L+","+r.T+","+(r.R-r.L)+"x"+(r.B-r.T)+"|ex="+ExStyle(h)+"|cloak="+c+"|blocked="+blocked.Contains(m.device));return true;},IntPtr.Zero);return z.ToArray();
  }

  public static string[] Sweep(bool dryRun) {
    SetThreadDpiAwarenessContext((IntPtr)(-4));
    IntPtr fg=GetForegroundWindow(); if(fg!=IntPtr.Zero) { string d=MI(MonitorFromWindow(fg,MONITOR_DEFAULTTONEAREST)).device; if(work.Contains(d)) lastWork=d; }
    List<string> moved=new List<string>();
    EnumWindows(delegate(IntPtr h,IntPtr p) {
      if(!IsWindowVisible(h)) return true;
      RECT wr; if(!GetWindowRect(h,out wr) || wr.R-wr.L<100 || wr.B-wr.T<60) return true;
      StringBuilder tb=new StringBuilder(512); GetWindowText(h,tb,512); string title=tb.ToString(); if(title.Length==0) return true;
      if(title.Contains("\u526f\u5c4f\u4eea\u8868\u76d8") || title.Contains("\u5bbd\u5c4f\u4eea\u8868\u76d8")) return true;
      StringBuilder cb=new StringBuilder(128); GetClassName(h,cb,128); string cls=cb.ToString();
      if(cls=="Progman" || cls=="WorkerW" || cls=="Shell_TrayWnd" || cls=="Shell_SecondaryTrayWnd") return true;
      if((ExStyle(h)&WS_EX_TOOLWINDOW)!=0) return true;
      int cloaked=0; if(DwmGetWindowAttribute(h,DWMWA_CLOAKED,out cloaked,4)==0 && cloaked!=0) return true;
      MONITORINFOEX src=MI(MonitorFromWindow(h,MONITOR_DEFAULTTONEAREST)); if(!blocked.Contains(src.device)) return true;
      string targetName=lastWork; if(targetName==null) { foreach(string x in work){targetName=x;break;} } if(targetName==null)return true;
      MONITORINFOEX target=new MONITORINFOEX(); bool found=false;
      EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr mh,IntPtr dc,ref RECT rr,IntPtr pp){MONITORINFOEX mm=MI(mh);if(String.Equals(mm.device,targetName,StringComparison.OrdinalIgnoreCase)){target=mm;found=true;return false;}return true;},IntPtr.Zero);
      if(!found)return true; RECT dstMon=target.rcMonitor, dstWork=target.rcWork;
      bool zoom=IsZoomed(h), full=Covers(wr,src.rcMonitor);
      int nx,ny,nw,nh;
      if(full){nx=dstMon.L;ny=dstMon.T;nw=dstMon.R-dstMon.L;nh=dstMon.B-dstMon.T;}
      else {nw=Math.Min(wr.R-wr.L,dstWork.R-dstWork.L);nh=Math.Min(wr.B-wr.T,dstWork.B-dstWork.T);nx=dstWork.L+(dstWork.R-dstWork.L-nw)/2;ny=dstWork.T+(dstWork.B-dstWork.T-nh)/2;}
      uint pid;GetWindowThreadProcessId(h,out pid);string proc="";try{proc=Process.GetProcessById((int)pid).ProcessName;}catch{}
      moved.Add(proc+" | "+title+" | "+src.device+" -> "+targetName+" | "+nx+","+ny+" "+nw+"x"+nh+(dryRun?" | DRY":""));
      if(!dryRun){if(zoom)ShowWindow(h,SW_RESTORE);SetWindowPos(h,IntPtr.Zero,nx,ny,nw,nh,SWP_NOACTIVATE|SWP_SHOWWINDOW);if(zoom)ShowWindow(h,SW_MAXIMIZE);}
      return true;
    },IntPtr.Zero);
    return moved.ToArray();
  }
}
"@ -ReferencedAssemblies System.Windows.Forms

[ScreenRoleNative]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$workIds = @('LHC90D6','DEL41BC')
$blockedIds = @('IPS2023','DRS2555')
$lastTopology = ''

function Configure-Roles {
  $paths = @([ScreenRoleNative]::ActivePaths())
  $screens = @([ScreenRoleNative]::MonitorRows())
  $work = New-Object System.Collections.Generic.List[string]
  $blocked = New-Object System.Collections.Generic.List[string]
  foreach ($p in $paths) {
    $parts = $p -split '\|',3; if ($parts.Count -lt 2) { continue }
    $gdi=$parts[0]; $dev=$parts[1]
    if ($blockedIds | Where-Object { $dev -match $_ }) { $blocked.Add($gdi); continue }
    if ($workIds | Where-Object { $dev -match $_ }) { $work.Add($gdi); continue }
  }
  # EDID missing fallback: only exact known panel dimensions, never "smallest non-primary".
  foreach ($row in $screens) {
    $sp=$row -split '\|'; if($sp.Count -lt 3){continue}; $name=$sp[0];$w=[int]$sp[1];$h=[int]$sp[2]
    if (($w -eq 3840 -and $h -eq 1100) -or ($w -eq 960 -and $h -eq 640)) { if(-not $blocked.Contains($name)){$blocked.Add($name)} }
    elseif ($w -eq 3840 -and $h -eq 2160) { if(-not $work.Contains($name)){$work.Add($name)} }
  }
  [ScreenRoleNative]::Configure($blocked.ToArray(),$work.ToArray())
  $sig='work='+($work -join ',')+' blocked='+($blocked -join ',')
  if($sig -ne $script:lastTopology){L "roles $sig";$script:lastTopology=$sig}
}

Configure-Roles
do {
  foreach($line in [ScreenRoleNative]::Sweep([bool]$DryRun)){L "move $line";Write-Output $line}
  if($Mode -eq 'once'){break}
  Start-Sleep -Milliseconds 1500
  if((Get-Random -Minimum 0 -Maximum 8) -eq 0){Configure-Roles} # topology refresh about every 12s
} while($true)
if ($guardMutex) {
  try { $guardMutex.ReleaseMutex() } catch {}
  $guardMutex.Dispose()
}
