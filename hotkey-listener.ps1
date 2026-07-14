# 全局热键监听: 注册组合键, 按下时 POST /api/trigger(与副屏物理按键同语义)。
# 组合键从 hotkey.json 读: { "mods": <int>, "vk": <int> }  mods: ALT=1 CTRL=2 SHIFT=4 WIN=8
# server.js 在 config.hotkey.enabled 时拉起本进程。
$ErrorActionPreference = 'SilentlyContinue'
$cfgFile = Join-Path $PSScriptRoot 'hotkey.json'
$mods = 3; $vk = 39   # 默认 Ctrl+Alt + Right(0x27)
try {
  $j = Get-Content $cfgFile -Raw | ConvertFrom-Json
  if ($j.mods -ne $null) { $mods = [int]$j.mods }
  if ($j.vk -ne $null) { $vk = [int]$j.vk }
} catch {}

$src = @"
using System;
using System.Runtime.InteropServices;
using System.Net;
public class HK {
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptx; public int pty; }
    const uint MOD_NOREPEAT = 0x4000;
    const int WM_HOTKEY = 0x0312;
    public static void Run(uint mods, uint vk) {
        if (!RegisterHotKey(IntPtr.Zero, 1, mods | MOD_NOREPEAT, vk)) { Console.WriteLine("REGFAIL"); return; }
        Console.WriteLine("REGOK"); Console.Out.Flush();
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
            if (msg.message == WM_HOTKEY) {
                try {
                    var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3777/api/trigger");
                    req.Method = "POST"; req.ContentType = "application/json"; req.Timeout = 3000;
                    using (var s = req.GetRequestStream()) { var b = System.Text.Encoding.UTF8.GetBytes("{\"steps\":1}"); s.Write(b, 0, b.Length); }
                    using (var r = req.GetResponse()) {}
                } catch {}
            }
        }
        UnregisterHotKey(IntPtr.Zero, 1);
    }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
[HK]::Run([uint32]$mods, [uint32]$vk)
