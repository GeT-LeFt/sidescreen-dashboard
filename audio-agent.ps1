# audio-agent.ps1 - Windows Core Audio resident agent for sidescreen-dashboard.
# Spawned by server.js (node child_process). ASCII-only source, zero third-party deps.
# Mirrors nowplaying.ps1 / perf-extra.ps1 flush pattern ([Console]::Out.WriteLine + Flush).
#
# Output: one full state JSON line to stdout, polled every ~1s, emitted on change
# with a heartbeat at least every 5s. All volumes are 0-100 integers. All output
# is pure ASCII (non-ASCII chars are \uXXXX escaped inside JSON strings).
#   {"master":{"vol":62,"muted":false},"mic":{"muted":false,"name":"..."},
#    "devices":[{"id":"...","name":"...","default":true}],
#    "sessions":[{"pid":123,"name":"msedge","display":"Microsoft Edge","vol":80,"muted":false,"active":true}],
#    "routing":false}
#
# Commands: read from stdin, one per line. Each command is acked with
#   {"ack":"<line>","ok":true|false,"err":"..."}
#   SETMASTER <0-100>     set default render endpoint volume
#   MUTEMASTER <0|1>      mute/unmute default render endpoint
#   SETAPP <pid> <0-100>  set per-app audio session volume (all sessions of pid)
#   MUTEAPP <pid> <0|1>   mute/unmute per-app audio session
#   SETDEV <deviceId>     set default render device (IPolicyConfig undocumented COM,
#                         CLSID 870af99c-171d-4f9e-af0d-e63df40c2bc9, roles eConsole+eMultimedia)
#   MICMUTE <0|1>         mute/unmute default capture endpoint
# SETAPPDEV (per-app device routing) is NOT implemented -> state carries "routing":false.
# Crash safety: any single command failure only emits ok:false; agent exits on stdin EOF.
#
# ---- Verified live 2026-07-13, Windows 11 Pro 26200, PS 5.1 ----
# Real captured state line, verbatim as emitted (6 render devices, Douyu player
# active; the \uXXXX escapes are Chinese device/app names - output stays ASCII):
#   {"master":{"vol":100,"muted":false},
#    "mic":{"muted":false,"name":"\u8033\u673a\u5f0f\u9ea6\u514b\u98ce (DualSense Edge Wireless Controller)"},
#    "devices":[{"id":"{0.0.0.00000000}.{1511a155-9eb0-4041-85c8-d4e127583297}","name":"\u626c\u58f0\u5668 (DualSense Edge Wireless Controller)","default":false},
#               {"id":"{0.0.0.00000000}.{3fbeb05b-e2d9-4bb7-ab35-3a3ab5c937cc}","name":"\u626c\u58f0\u5668 (ADAM Audio D3V  )","default":false},
#               ... 3 more ...,
#               {"id":"{0.0.0.00000000}.{f30797ff-7caf-46cf-baa4-aa593aa49dca}","name":"\u626c\u58f0\u5668 (Realtek High Definition Audio)","default":true}],
#    "sessions":[{"pid":0,"name":"system","display":"System Sounds","vol":100,"muted":false,"active":false},
#                {"pid":6808,"name":"steam","display":"Steam","vol":100,"muted":false,"active":false},
#                {"pid":37284,"name":"RpcMediaDecoderEx","display":"\u6597\u9c7c\u76f4\u64ad\u64ad\u653e\u5668","vol":100,"muted":false,"active":true}],
#    "routing":false}
# Command verification (all acked, state re-read confirmed, originals restored):
#   SETMASTER 37             -> {"ack":"SETMASTER 37","ok":true}, master.vol read back 37, restored to 100
#   MUTEMASTER 1 / 0         -> ok:true, master.muted true then false
#   SETAPP 4912 55           -> ok:true, session vol read back 55, restored to 100 (4912 = spawned wav player)
#   MUTEAPP 4912 1 / 0       -> ok:true, session muted True -> False
#   MICMUTE 1 / 0            -> ok:true, mic.muted true then false (restored)
#   SETDEV {0.0.0.00000000}.{f30797ff-...} -> ok:true (IPolicyConfig path exercised on current default)
#   SETAPP 99999 50          -> {"ok":false,"err":"no session for pid 99999"}
#   SETAPPDEV 123 someid     -> {"ok":false,"err":"routing not implemented"}
#   FROBNICATE 1             -> {"ok":false,"err":"unknown command"}
#   idle heartbeat observed at +0.4s/+5.5s/+10.7s/+16.0s; stdin EOF -> clean exit code 0

$ErrorActionPreference = 'Continue'

$src = @"
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;

// Hand-written Core Audio COM interop. These IIDs are public and stable
// (mmdeviceapi.h / endpointvolume.h / audiopolicy.h), except IPolicyConfig
// which is the well-known undocumented default-endpoint setter.
namespace SideAudio {

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorCom { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore props);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY { public Guid fmtid; public int pid; }

[StructLayout(LayoutKind.Sequential)]
public struct PROPVARIANT { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetAt(int index, out PROPERTYKEY key);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    [PreserveSig] int Commit();
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int GetChannelCount(out int count);
    [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid eventContext);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
    [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(int ch, float levelDb, ref Guid eventContext);
    [PreserveSig] int SetChannelVolumeLevelScalar(int ch, float level, ref Guid eventContext);
    [PreserveSig] int GetChannelVolumeLevel(int ch, out float levelDb);
    [PreserveSig] int GetChannelVolumeLevelScalar(int ch, out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    [PreserveSig] int GetVolumeStepInfo(out int step, out int stepCount);
    [PreserveSig] int VolumeStepUp(ref Guid eventContext);
    [PreserveSig] int VolumeStepDown(ref Guid eventContext);
    [PreserveSig] int QueryHardwareSupport(out int mask);
    [PreserveSig] int GetVolumeRange(out float min, out float max, out float inc);
}

// IAudioSessionManager2 with flattened IAudioSessionManager methods (vtable order).
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int streamFlags, out IntPtr sessionControl);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int streamFlags, out IntPtr audioVolume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
    [PreserveSig] int RegisterSessionNotification(IntPtr notification);
    [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
    [PreserveSig] int RegisterDuckNotification(IntPtr sessionId, IntPtr notification);
    [PreserveSig] int UnregisterDuckNotification(IntPtr notification);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl session);
}

[ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    [PreserveSig] int GetGroupingParam(out Guid param);
    [PreserveSig] int SetGroupingParam(ref Guid param, ref Guid eventContext);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
}

// IAudioSessionControl2 with flattened IAudioSessionControl methods (vtable order).
[ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    [PreserveSig] int GetGroupingParam(out Guid param);
    [PreserveSig] int SetGroupingParam(ref Guid param, ref Guid eventContext);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out int pid);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
}

[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid eventContext);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

// Undocumented default-endpoint setter. Win7+ vtable. Only SetDefaultEndpoint is
// ever called; the earlier slots are declared solely to keep the vtable aligned.
[ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfig {
    [PreserveSig] int GetMixFormat(IntPtr a, IntPtr b);
    [PreserveSig] int GetDeviceFormat(IntPtr a, int b, IntPtr c);
    [PreserveSig] int ResetDeviceFormat(IntPtr a);
    [PreserveSig] int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c);
    [PreserveSig] int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
    [PreserveSig] int SetProcessingPeriod(IntPtr a, IntPtr b);
    [PreserveSig] int GetShareMode(IntPtr a, IntPtr b);
    [PreserveSig] int SetShareMode(IntPtr a, IntPtr b);
    [PreserveSig] int GetPropertyValue(IntPtr a, int b, IntPtr c, IntPtr d);
    [PreserveSig] int SetPropertyValue(IntPtr a, int b, IntPtr c, IntPtr d);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
    [PreserveSig] int SetEndpointVisibility(IntPtr a, int b);
}

// Vista-era fallback vtable (no ResetDeviceFormat), in case the primary IID is refused.
[ComImport, Guid("568b9108-44bf-40b4-9006-86afe5b5a620"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfigVista {
    [PreserveSig] int GetMixFormat(IntPtr a, IntPtr b);
    [PreserveSig] int GetDeviceFormat(IntPtr a, int b, IntPtr c);
    [PreserveSig] int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c);
    [PreserveSig] int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
    [PreserveSig] int SetProcessingPeriod(IntPtr a, IntPtr b);
    [PreserveSig] int GetShareMode(IntPtr a, IntPtr b);
    [PreserveSig] int SetShareMode(IntPtr a, IntPtr b);
    [PreserveSig] int GetPropertyValue(IntPtr a, int b, IntPtr c, IntPtr d);
    [PreserveSig] int SetPropertyValue(IntPtr a, int b, IntPtr c, IntPtr d);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
    [PreserveSig] int SetEndpointVisibility(IntPtr a, int b);
}

// Background stdin reader. PS 5.1's Console.In is a SyncTextReader whose
// ReadLineAsync runs synchronously, so polling it from the main loop would
// block; a dedicated thread + queue keeps the loop responsive.
public static class StdinPump {
    static ConcurrentQueue<string> q = new ConcurrentQueue<string>();
    static volatile bool eofFlag = false;
    public static void Start() {
        Thread t = new Thread(Run);
        t.IsBackground = true;
        t.Start();
    }
    static void Run() {
        try {
            string line;
            while ((line = Console.In.ReadLine()) != null) q.Enqueue(line);
        } catch { }
        eofFlag = true;
    }
    public static bool IsEof() { return eofFlag && q.IsEmpty; }
    public static string TryDequeue() {
        string s;
        if (q.TryDequeue(out s)) return s;
        return null;
    }
}

public class SessInfo {
    public int Pid; public string Name; public string Display;
    public int Vol; public bool Muted; public bool Active;
}

public static class AudioAgent {
    const int CLSCTX_ALL = 23;
    const int eRender = 0;
    const int eCapture = 1;
    const int eConsole = 0;
    const int eMultimedia = 1;
    const int DEVICE_STATE_ACTIVE = 1;
    static readonly Guid IID_EndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    static readonly Guid IID_SessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    static readonly Guid CLSID_PolicyConfig = new Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9");

    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PROPVARIANT pvar);

    static IMMDeviceEnumerator GetEnum() {
        return (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
    }

    static IAudioEndpointVolume GetEndpointVolume(int dataFlow, int role) {
        IMMDeviceEnumerator en = GetEnum();
        IMMDevice dev;
        int hr = en.GetDefaultAudioEndpoint(dataFlow, role, out dev);
        if (hr != 0 || dev == null) throw new Exception("no default endpoint (flow=" + dataFlow + ") hr=0x" + hr.ToString("X8"));
        Guid iid = IID_EndpointVolume;
        object o;
        hr = dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
        if (hr != 0 || o == null) throw new Exception("Activate IAudioEndpointVolume hr=0x" + hr.ToString("X8"));
        return (IAudioEndpointVolume)o;
    }

    static string DeviceName(IMMDevice dev) {
        IPropertyStore ps;
        if (dev.OpenPropertyStore(0, out ps) != 0 || ps == null) return "";
        PROPERTYKEY key = new PROPERTYKEY();
        key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); // PKEY_Device_FriendlyName
        key.pid = 14;
        PROPVARIANT val = new PROPVARIANT();
        if (ps.GetValue(ref key, out val) != 0) return "";
        string s = "";
        if (val.vt == 31 && val.p != IntPtr.Zero) s = Marshal.PtrToStringUni(val.p); // VT_LPWSTR
        PropVariantClear(ref val);
        return (s == null) ? "" : s;
    }

    // JSON string escape; also \uXXXX-escapes everything outside printable ASCII
    // so all agent output stays pure ASCII regardless of console codepage.
    public static string Esc(string s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.Length + 8);
        foreach (char c in s) {
            if (c == '"') b.Append("\\\"");
            else if (c == '\\') b.Append("\\\\");
            else if (c < (char)32 || c > (char)126) b.AppendFormat("\\u{0:x4}", (int)c);
            else b.Append(c);
        }
        return b.ToString();
    }

    static void FillProcNames(SessInfo s, bool isSystem) {
        if (isSystem) { s.Name = "system"; s.Display = "System Sounds"; return; }
        s.Name = "pid" + s.Pid; s.Display = s.Name;
        try {
            Process p = Process.GetProcessById(s.Pid);
            s.Name = p.ProcessName;
            s.Display = s.Name;
            try {
                string d = p.MainModule.FileVersionInfo.FileDescription;
                if (!string.IsNullOrEmpty(d)) s.Display = d.Trim();
            } catch { } // access denied on elevated/protected processes
        } catch { }
    }

    public static List<SessInfo> CollectSessions() {
        List<SessInfo> list = new List<SessInfo>();
        Dictionary<int, int> byPid = new Dictionary<int, int>();
        IMMDeviceEnumerator en = GetEnum();
        IMMDeviceCollection col;
        if (en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col) != 0 || col == null) return list;
        int n; col.GetCount(out n);
        for (int i = 0; i < n; i++) {
            IMMDevice dev;
            if (col.Item(i, out dev) != 0 || dev == null) continue;
            try { CollectFromDevice(dev, list, byPid); } catch { }
        }
        list.Sort(delegate(SessInfo a, SessInfo b) { return a.Pid.CompareTo(b.Pid); });
        return list;
    }

    static void CollectFromDevice(IMMDevice dev, List<SessInfo> list, Dictionary<int, int> byPid) {
        Guid iid = IID_SessionManager2;
        object o;
        if (dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o) != 0 || o == null) return;
        IAudioSessionManager2 mgr = (IAudioSessionManager2)o;
        IAudioSessionEnumerator senum;
        if (mgr.GetSessionEnumerator(out senum) != 0 || senum == null) return;
        int count; senum.GetCount(out count);
        for (int i = 0; i < count; i++) {
            IAudioSessionControl ctl;
            if (senum.GetSession(i, out ctl) != 0 || ctl == null) continue;
            try {
                int state; ctl.GetState(out state);
                if (state == 2) continue; // AudioSessionStateExpired
                IAudioSessionControl2 c2 = (IAudioSessionControl2)ctl;
                int pid; c2.GetProcessId(out pid);
                bool isSystem = (c2.IsSystemSoundsSession() == 0); // S_OK means yes
                ISimpleAudioVolume sv = (ISimpleAudioVolume)ctl;
                float lvl; sv.GetMasterVolume(out lvl);
                bool mu; sv.GetMute(out mu);
                bool active = (state == 1);
                int existing;
                if (byPid.TryGetValue(pid, out existing)) {
                    // aggregate same-pid sessions: any active wins, keep loudest
                    SessInfo e = list[existing];
                    if (active) e.Active = true;
                    int v = (int)Math.Round(lvl * 100.0);
                    if (v > e.Vol) e.Vol = v;
                    if (!mu) e.Muted = false;
                    continue;
                }
                SessInfo s = new SessInfo();
                s.Pid = pid;
                s.Vol = (int)Math.Round(lvl * 100.0);
                s.Muted = mu;
                s.Active = active;
                FillProcNames(s, isSystem);
                byPid[pid] = list.Count;
                list.Add(s);
            } catch { }
        }
    }

    public static string GetStateJson() {
        // Each section is built independently so one failing subsystem
        // degrades to null/[] instead of breaking the whole line.
        string master = "null";
        try {
            IAudioEndpointVolume ev = GetEndpointVolume(eRender, eMultimedia);
            float f; ev.GetMasterVolumeLevelScalar(out f);
            bool mu; ev.GetMute(out mu);
            master = "{\"vol\":" + ((int)Math.Round(f * 100.0)) + ",\"muted\":" + (mu ? "true" : "false") + "}";
        } catch { }

        string mic = "null";
        try {
            IMMDeviceEnumerator en = GetEnum();
            IMMDevice mdev;
            if (en.GetDefaultAudioEndpoint(eCapture, eConsole, out mdev) == 0 && mdev != null) {
                Guid iid = IID_EndpointVolume;
                object o;
                if (mdev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o) == 0 && o != null) {
                    IAudioEndpointVolume mv = (IAudioEndpointVolume)o;
                    bool mmu; mv.GetMute(out mmu);
                    mic = "{\"muted\":" + (mmu ? "true" : "false") + ",\"name\":\"" + Esc(DeviceName(mdev)) + "\"}";
                }
            }
        } catch { }

        StringBuilder devs = new StringBuilder("[");
        try {
            IMMDeviceEnumerator en = GetEnum();
            string defId = "";
            try {
                IMMDevice dd;
                if (en.GetDefaultAudioEndpoint(eRender, eMultimedia, out dd) == 0 && dd != null) dd.GetId(out defId);
            } catch { }
            IMMDeviceCollection col;
            if (en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col) == 0 && col != null) {
                int n; col.GetCount(out n);
                bool first = true;
                for (int i = 0; i < n; i++) {
                    IMMDevice dev;
                    if (col.Item(i, out dev) != 0 || dev == null) continue;
                    string id = ""; dev.GetId(out id);
                    if (!first) devs.Append(",");
                    first = false;
                    devs.Append("{\"id\":\"").Append(Esc(id)).Append("\",\"name\":\"").Append(Esc(DeviceName(dev)))
                        .Append("\",\"default\":").Append((id == defId) ? "true" : "false").Append("}");
                }
            }
        } catch { }
        devs.Append("]");

        StringBuilder sess = new StringBuilder("[");
        try {
            List<SessInfo> list = CollectSessions();
            for (int i = 0; i < list.Count; i++) {
                SessInfo s = list[i];
                if (i > 0) sess.Append(",");
                sess.Append("{\"pid\":").Append(s.Pid)
                    .Append(",\"name\":\"").Append(Esc(s.Name))
                    .Append("\",\"display\":\"").Append(Esc(s.Display))
                    .Append("\",\"vol\":").Append(s.Vol)
                    .Append(",\"muted\":").Append(s.Muted ? "true" : "false")
                    .Append(",\"active\":").Append(s.Active ? "true" : "false").Append("}");
            }
        } catch { }
        sess.Append("]");

        return "{\"master\":" + master + ",\"mic\":" + mic + ",\"devices\":" + devs.ToString() +
               ",\"sessions\":" + sess.ToString() + ",\"routing\":false}";
    }

    // ---- commands ----

    public static void SetMaster(int vol) {
        if (vol < 0) vol = 0; if (vol > 100) vol = 100;
        IAudioEndpointVolume ev = GetEndpointVolume(eRender, eMultimedia);
        Guid ec = Guid.Empty;
        int hr = ev.SetMasterVolumeLevelScalar(vol / 100.0f, ref ec);
        if (hr != 0) throw new Exception("SetMasterVolumeLevelScalar hr=0x" + hr.ToString("X8"));
    }

    public static void MuteMaster(bool mute) {
        IAudioEndpointVolume ev = GetEndpointVolume(eRender, eMultimedia);
        Guid ec = Guid.Empty;
        int hr = ev.SetMute(mute, ref ec);
        if (hr != 0) throw new Exception("SetMute hr=0x" + hr.ToString("X8"));
    }

    public static void MicMute(bool mute) {
        IAudioEndpointVolume ev = GetEndpointVolume(eCapture, eConsole);
        Guid ec = Guid.Empty;
        int hr = ev.SetMute(mute, ref ec);
        if (hr != 0) throw new Exception("mic SetMute hr=0x" + hr.ToString("X8"));
    }

    // op 0 = set volume (val 0-100), op 1 = set mute (val 0/1).
    // Applies to every non-expired session of the pid across all render devices.
    static int AppOp(int pid, int op, int val) {
        int touched = 0;
        IMMDeviceEnumerator en = GetEnum();
        IMMDeviceCollection col;
        if (en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col) != 0 || col == null) return 0;
        int n; col.GetCount(out n);
        for (int i = 0; i < n; i++) {
            IMMDevice dev;
            if (col.Item(i, out dev) != 0 || dev == null) continue;
            try {
                Guid iid = IID_SessionManager2;
                object o;
                if (dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o) != 0 || o == null) continue;
                IAudioSessionManager2 mgr = (IAudioSessionManager2)o;
                IAudioSessionEnumerator senum;
                if (mgr.GetSessionEnumerator(out senum) != 0 || senum == null) continue;
                int count; senum.GetCount(out count);
                for (int j = 0; j < count; j++) {
                    IAudioSessionControl ctl;
                    if (senum.GetSession(j, out ctl) != 0 || ctl == null) continue;
                    try {
                        int state; ctl.GetState(out state);
                        if (state == 2) continue;
                        IAudioSessionControl2 c2 = (IAudioSessionControl2)ctl;
                        int spid; c2.GetProcessId(out spid);
                        if (spid != pid) continue;
                        ISimpleAudioVolume sv = (ISimpleAudioVolume)ctl;
                        Guid ec = Guid.Empty;
                        int hr;
                        if (op == 0) hr = sv.SetMasterVolume(val / 100.0f, ref ec);
                        else hr = sv.SetMute(val != 0, ref ec);
                        if (hr == 0) touched++;
                    } catch { }
                }
            } catch { }
        }
        return touched;
    }

    public static int SetAppVolume(int pid, int vol) {
        if (vol < 0) vol = 0; if (vol > 100) vol = 100;
        return AppOp(pid, 0, vol);
    }

    public static int MuteApp(int pid, bool mute) {
        return AppOp(pid, 1, mute ? 1 : 0);
    }

    public static void SetDefaultDevice(string deviceId) {
        object o = Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_PolicyConfig));
        int hr1, hr2;
        try {
            IPolicyConfig pc = (IPolicyConfig)o;
            hr1 = pc.SetDefaultEndpoint(deviceId, eConsole);
            hr2 = pc.SetDefaultEndpoint(deviceId, eMultimedia);
        } catch (InvalidCastException) {
            IPolicyConfigVista pv = (IPolicyConfigVista)o;
            hr1 = pv.SetDefaultEndpoint(deviceId, eConsole);
            hr2 = pv.SetDefaultEndpoint(deviceId, eMultimedia);
        }
        if (hr1 != 0 || hr2 != 0)
            throw new Exception("SetDefaultEndpoint hr=0x" + hr1.ToString("X8") + "/0x" + hr2.ToString("X8"));
    }
}
}
"@
Add-Type -TypeDefinition $src -Language CSharp

function Say($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
function JEsc($s) { return [SideAudio.AudioAgent]::Esc([string]$s) }

$script:force = $true

function Handle($line) {
    $line = ([string]$line).Trim()
    if ($line -eq '') { return }
    $parts = $line -split '\s+'
    $cmd = $parts[0].ToUpperInvariant()
    $ok = $false; $err = ''
    try {
        switch ($cmd) {
            'SETMASTER' {
                [SideAudio.AudioAgent]::SetMaster([int]$parts[1]); $ok = $true
            }
            'MUTEMASTER' {
                [SideAudio.AudioAgent]::MuteMaster($parts[1] -eq '1'); $ok = $true
            }
            'SETAPP' {
                $n = [SideAudio.AudioAgent]::SetAppVolume([int]$parts[1], [int]$parts[2])
                if ($n -gt 0) { $ok = $true } else { $err = 'no session for pid ' + $parts[1] }
            }
            'MUTEAPP' {
                $n = [SideAudio.AudioAgent]::MuteApp([int]$parts[1], ($parts[2] -eq '1'))
                if ($n -gt 0) { $ok = $true } else { $err = 'no session for pid ' + $parts[1] }
            }
            'SETDEV' {
                $devId = ($parts[1..($parts.Count - 1)] -join ' ')
                [SideAudio.AudioAgent]::SetDefaultDevice($devId); $ok = $true
            }
            'MICMUTE' {
                [SideAudio.AudioAgent]::MicMute($parts[1] -eq '1'); $ok = $true
            }
            'SETAPPDEV' {
                $err = 'routing not implemented'
            }
            default { $err = 'unknown command' }
        }
    } catch {
        $err = $_.Exception.Message
        if ($_.Exception.InnerException) { $err = $err + ' :: ' + $_.Exception.InnerException.Message }
    }
    if ($ok) {
        Say ('{"ack":"' + (JEsc $line) + '","ok":true}')
        $script:force = $true   # emit fresh state right after a successful mutation
    } else {
        Say ('{"ack":"' + (JEsc $line) + '","ok":false,"err":"' + (JEsc $err) + '"}')
    }
}

# Main loop: poll state every ~1s (emit on change, heartbeat every 5s),
# service stdin commands with ~100ms latency, exit on stdin EOF.
[SideAudio.StdinPump]::Start()
$lastJson = ''
$lastEmit = [DateTime]::MinValue
$lastPoll = [DateTime]::MinValue

while ($true) {
    while ($true) {
        $line = [SideAudio.StdinPump]::TryDequeue()
        if ($null -eq $line) { break }
        Handle $line
    }
    if ([SideAudio.StdinPump]::IsEof()) { break }          # stdin EOF/broken -> exit
    $now = [DateTime]::UtcNow
    if ($script:force -or ($now - $lastPoll).TotalMilliseconds -ge 1000) {
        $lastPoll = $now
        $json = $null
        try { $json = [SideAudio.AudioAgent]::GetStateJson() }
        catch { $json = '{"master":null,"mic":null,"devices":[],"sessions":[],"routing":false,"err":"' + (JEsc $_.Exception.Message) + '"}' }
        if ($script:force -or $json -ne $lastJson -or ($now - $lastEmit).TotalSeconds -ge 5) {
            Say $json
            $lastJson = $json
            $lastEmit = $now
        }
        $script:force = $false
    }
    Start-Sleep -Milliseconds 100
}
