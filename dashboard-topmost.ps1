param([ValidateSet('query','on','off')][string]$Mode = 'query')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class DashboardTopmost {
  public class Row { public long hwnd; public bool topmost; public bool ok; public int error; }
  delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetStyle64(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetStyle32(IntPtr hwnd, int index);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  static bool Topmost(IntPtr hwnd) { return ((IntPtr.Size == 8 ? GetStyle64(hwnd,-20).ToInt64() : GetStyle32(hwnd,-20)) & 8) != 0; }
  public static Row[] Run(string mode) {
    var rows = new List<Row>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
      if (!IsWindowVisible(hwnd)) return true;
      var text = new StringBuilder(512); GetWindowText(hwnd, text, text.Capacity);
      string title = text.ToString();
      if (!title.StartsWith("ProArt \u526f\u5c4f\u4eea\u8868\u76d8") && !title.StartsWith("\u5bbd\u5c4f\u4eea\u8868\u76d8")) return true;
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      try { if (!String.Equals(Process.GetProcessById((int)pid).ProcessName,"msedge",StringComparison.OrdinalIgnoreCase)) return true; } catch { return true; }
      var row = new Row { hwnd=hwnd.ToInt64(), ok=true, error=0 };
      if (mode != "query") {
        // Preserve position, size and foreground focus; only change z order.
        row.ok = SetWindowPos(hwnd, new IntPtr(mode == "on" ? -1 : -2), 0,0,0,0, 0x0013);
        if (!row.ok) row.error = Marshal.GetLastWin32Error();
      }
      row.topmost = Topmost(hwnd);
      if (mode != "query" && row.topmost != (mode == "on")) row.ok = false;
      rows.Add(row); return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }
}
'@
$windows = @([DashboardTopmost]::Run($Mode))
$onCount = @($windows | Where-Object { $_.topmost }).Count
$enabled = if ($windows.Count -eq 0) { $null } else { $onCount -eq $windows.Count }
[ordered]@{
  ok = @($windows | Where-Object { -not $_.ok }).Count -eq 0
  available = $windows.Count -gt 0
  enabled = $enabled
  mixed = $onCount -gt 0 -and $onCount -lt $windows.Count
  windows = $windows
} | ConvertTo-Json -Depth 4 -Compress
