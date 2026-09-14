# DDC/CI 亮度键代理: 轮询副屏亮度寄存器, 检测到物理按键(值变化)时恢复原值并向 stdout 报告 PRESS。
# server.js 作为子进程拉起本脚本; 通过 ddc-cmd.txt 下发命令: "SET <0-100>" / "MODE rotate|native"
param([int]$ParentPid = 0)
$ErrorActionPreference = 'Continue'
$cmdFile = Join-Path $PSScriptRoot 'ddc-cmd.txt'

$src = @"
using System;
using System.Runtime.InteropServices;

public class DDCA {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PHYSICAL_MONITOR { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string d; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
    public delegate bool MonEnumProc(IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr data);

    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr a, IntPtr b, MonEnumProc cb, IntPtr d);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr h, ref MONITORINFOEX mi);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
    [DllImport("dxva2.dll")] public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr h, ref uint n);
    [DllImport("dxva2.dll")] public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr h, uint n, [Out] PHYSICAL_MONITOR[] a);
    [DllImport("dxva2.dll")] public static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte c, out uint t, out uint cur, out uint max);
    [DllImport("dxva2.dll")] public static extern bool SetVCPFeature(IntPtr h, byte c, uint v);

    public static IntPtr Side = IntPtr.Zero;
    public static void FindSide() {
        Side = IntPtr.Zero;
        SetProcessDpiAwarenessContext((IntPtr)(-4));
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr d) => {
            MONITORINFOEX mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            GetMonitorInfoW(hMon, ref mi);
            if ((mi.rcMonitor.R - mi.rcMonitor.L) == 960 && (mi.rcMonitor.B - mi.rcMonitor.T) == 640) {
                uint n = 0;
                if (GetNumberOfPhysicalMonitorsFromHMONITOR(hMon, ref n) && n > 0) {
                    PHYSICAL_MONITOR[] pm = new PHYSICAL_MONITOR[n];
                    if (GetPhysicalMonitorsFromHMONITOR(hMon, n, pm)) Side = pm[0].h;
                }
            }
            return true;
        }, IntPtr.Zero);
    }
    public static int Read() {
        uint t, cur, max;
        if (Side == IntPtr.Zero) return -1;
        return GetVCPFeatureAndVCPFeatureReply(Side, 0x10, out t, out cur, out max) ? (int)cur : -2;
    }
    public static bool Set(int v) { return Side != IntPtr.Zero && SetVCPFeature(Side, 0x10, (uint)v); }
    // 0xCA = OSD/按钮控制: 2=启用. 这块屏被 DDC 写入后会自动锁按钮, 需反复解锁
    public static void UnlockOSD() { if (Side != IntPtr.Zero) SetVCPFeature(Side, 0xCA, 2); }
    public static int ReadOSD() { uint t,c,m; if(Side==IntPtr.Zero) return -1;
        return GetVCPFeatureAndVCPFeatureReply(Side, 0xCA, out t, out c, out m) ? (int)c : -2; }
}
"@
Add-Type -TypeDefinition $src -Language CSharp

$logFile = Join-Path $PSScriptRoot 'ddc-agent.log'
function Log($s) { try { [IO.File]::AppendAllText($logFile, ((Get-Date -Format 'HH:mm:ss.fff') + '  ' + $s + "`r`n")) } catch {} }
function Say($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush(); Log $s }

# 纯只读模式: 这块屏被任何 DDC 写入都会锁物理按钮, 所以绝不写(不解锁、不弹回)。
# 亮度变化 = 一次按键 = 翻页信号。亮度会跟着跳档(含 0), 这是这块屏无法规避的副作用。
# 例外: 管理台亮度滑块的 SET 命令是用户主动写(会临时锁按钮, 但那是用户要调亮度)。
[IO.File]::WriteAllText($logFile, "agent start $(Get-Date -Format 'HH:mm:ss') (read-only)`r`n")
[DDCA]::FindSide()
Log ("FindSide handle=" + [DDCA]::Side)
$base = [DDCA]::Read()
$fails = 0
$tick = 0
Say "READY base=$base mode=readonly"

while ($true) {
    Start-Sleep -Milliseconds 150

    # Exit shortly after the owning Node process disappears; local Get-Process does not use WMI/RPC.
    if ($ParentPid -gt 0 -and $tick % 30 -eq 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        Log "parent $ParentPid exited; stopping"
        break
    }

    if (Test-Path $cmdFile) {
        $lines = @()
        try { $lines = Get-Content $cmdFile -ErrorAction Stop; Remove-Item $cmdFile -Force -ErrorAction Stop } catch {}
        foreach ($l in $lines) {
            if ($l -match '^SET\s+(\d+)') {
                $v = [Math]::Min(100, [Math]::Max(0, [int]$matches[1]))
                if ([DDCA]::Set($v)) { $base = $v; Say "SETOK $v" } else { Say "SETFAIL $v" }
            }
        }
    }

    $b = [DDCA]::Read()
    $tick++
    if ($tick % 24 -eq 0) { Log "poll b=$b base=$base fails=$fails" }
    if ($b -lt 0) {
        $fails++
        if ($fails % 20 -eq 0) { [DDCA]::FindSide(); $nb = [DDCA]::Read(); if ($nb -ge 0) { $base = $nb; $fails = 0; Say "REFOUND base=$base" } }
        continue
    }
    $fails = 0
    if ($base -lt 0) { $base = $b; continue }
    if ($b -ne $base) {
        # 亮度 6 档(0/20/40/60/80/100), 每按一下 +1 档循环。按档数差算出按了几下。
        $lvNew = [Math]::Round($b / 20)
        $lvOld = [Math]::Round($base / 20)
        $steps = (($lvNew - $lvOld) % 6 + 6) % 6
        if ($steps -eq 0) { $steps = 1 }
        Say "PRESS $b $steps"           # 通知服务端(翻页/确认)
        # 亮度弹回管理台设定值, 让按钮只负责交互、不改亮度。
        # 只写 0x10(安全), 绝不写 0xCA(那会锁按钮)。base 不变。
        [DDCA]::Set($base) | Out-Null
    }
}



