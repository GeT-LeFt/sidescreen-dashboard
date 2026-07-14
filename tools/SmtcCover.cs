using System;
using System.Threading;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

public static class SmtcCover {
  static T Wait<T>(IAsyncOperation<T> op) {
    int i = 0;
    while (op.Status == AsyncStatus.Started && i++ < 500) Thread.Sleep(10);
    return op.Status == AsyncStatus.Completed ? op.GetResults() : default(T);
  }
  static byte[] GetInner() {
    try {
      var mgr = Wait(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
      if (mgr == null) return null;
      var s = mgr.GetCurrentSession();
      if (s == null) return null;
      var media = Wait(s.TryGetMediaPropertiesAsync());
      if (media == null || media.Thumbnail == null) return null;
      var ras = Wait(media.Thumbnail.OpenReadAsync());
      if (ras == null || ras.Size == 0 || ras.Size > 5242880) return null;
      uint size = (uint)ras.Size;
      var reader = new DataReader(ras.GetInputStreamAt(0));
      Wait(reader.LoadAsync(size));
      var bytes = new byte[reader.UnconsumedBufferLength];
      reader.ReadBytes(bytes);
      return bytes;
    } catch { return null; }
  }
  // WinRT async never completes on a blocked STA thread (PowerShell default) -> run on MTA thread
  public static byte[] Get() {
    byte[] result = null;
    var t = new Thread(() => { result = GetInner(); });
    t.SetApartmentState(ApartmentState.MTA);
    t.IsBackground = true;
    t.Start();
    if (!t.Join(8000)) return null;
    return result;
  }
}
