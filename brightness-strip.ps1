# One-shot: set brightness (VCP 0x10 only - NEVER touch 0xCA, see project notes)
# on the 3840x1100 strip screen. Must be spawned by node (execFile) - hidden
# Start-Process PS cannot get physical monitor handles (session context limit).
param([int]$Value = 80)
$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class StripDdc {
  public delegate bool MonEnumProc(IntPtr hMon, IntPtr hdc, ref RECT rc, IntPtr data);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonEnumProc fn, IntPtr data);
  [DllImport("dxva2.dll")] public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMon, out uint count);
  [DllImport("dxva2.dll")] public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMon, uint count, [Out] PHYSICAL_MONITOR[] mons);
  [DllImport("dxva2.dll")] public static extern bool SetVCPFeature(IntPtr hMonitor, byte code, uint value);
  [DllImport("dxva2.dll")] public static extern bool DestroyPhysicalMonitors(uint count, PHYSICAL_MONITOR[] mons);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PHYSICAL_MONITOR { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string desc; }

  public static IntPtr target = IntPtr.Zero;
  public static bool Enum(IntPtr hMon, IntPtr hdc, ref RECT rc, IntPtr d) {
    if (rc.R - rc.L == 3840 && rc.B - rc.T == 1100) target = hMon;
    return true;
  }
  public static string SetBrightness(uint v) {
    SetThreadDpiAwarenessContext((IntPtr)(-4));
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, Enum, IntPtr.Zero);
    if (target == IntPtr.Zero) return "strip monitor not found";
    uint n;
    if (!GetNumberOfPhysicalMonitorsFromHMONITOR(target, out n) || n == 0) return "no physical monitor";
    PHYSICAL_MONITOR[] mons = new PHYSICAL_MONITOR[n];
    if (!GetPhysicalMonitorsFromHMONITOR(target, n, mons)) return "get handle failed";
    bool ok = SetVCPFeature(mons[0].h, 0x10, v);
    DestroyPhysicalMonitors(n, mons);
    return ok ? "ok" : "SetVCPFeature failed";
  }
}
"@

$r = [StripDdc]::SetBrightness([uint32]$Value)
[Console]::Out.WriteLine("strip-brightness $Value -> $r")
