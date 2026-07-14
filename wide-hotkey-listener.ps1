# Global hotkeys for the WIDE dashboard page nav (no window focus needed).
# Registers PageUp / PageDown system-wide via RegisterHotKey; on press POSTs a
# nudge to /api/wide/page {dir:-1|+1}. server.js spawns this when config.wideHotkey.enabled.
# ASCII-only on purpose (avoids the PS 5.1 no-BOM GBK decode trap).
$ErrorActionPreference = 'SilentlyContinue'

$src = @"
using System;
using System.Runtime.InteropServices;
using System.Net;
public class WHK {
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptx; public int pty; }
    const uint MOD_NOREPEAT = 0x4000;
    const int WM_HOTKEY = 0x0312;
    const uint VK_PRIOR = 0x21;   // Page Up
    const uint VK_NEXT  = 0x22;   // Page Down
    static void Post(int dir) {
        try {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3777/api/wide/page");
            req.Method = "POST"; req.ContentType = "application/json"; req.Timeout = 3000;
            var body = System.Text.Encoding.UTF8.GetBytes("{\"dir\":" + dir + "}");
            using (var s = req.GetRequestStream()) { s.Write(body, 0, body.Length); }
            using (var r = req.GetResponse()) {}
        } catch {}
    }
    public static void Run() {
        bool up = RegisterHotKey(IntPtr.Zero, 1, MOD_NOREPEAT, VK_PRIOR);
        bool dn = RegisterHotKey(IntPtr.Zero, 2, MOD_NOREPEAT, VK_NEXT);
        Console.WriteLine("REG up=" + up + " down=" + dn); Console.Out.Flush();
        if (!up && !dn) return;
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
            if (msg.message == WM_HOTKEY) {
                int id = msg.wParam.ToInt32();
                if (id == 1) Post(-1);        // PageUp  -> previous page (up)
                else if (id == 2) Post(1);    // PageDown-> next page (down)
            }
        }
        UnregisterHotKey(IntPtr.Zero, 1);
        UnregisterHotKey(IntPtr.Zero, 2);
    }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
[WHK]::Run()
