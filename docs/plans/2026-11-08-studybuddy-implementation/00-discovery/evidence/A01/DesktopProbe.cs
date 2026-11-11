// Probe only this process's desktop handles; restore its station and close all new objects.
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DesktopProbe {
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetThreadDesktop(uint tid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder value, uint length, out uint needed);
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetUserObjectSecurity(IntPtr obj, ref uint flags, byte[] security, uint length, out uint needed);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateWindowStation(string name, uint flags, uint access, IntPtr attributes);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr attributes);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern bool CloseWindowStation(IntPtr station);
    static string Name(IntPtr obj) { uint needed; var text=new StringBuilder(2048); return GetUserObjectInformation(obj,2,text,4096,out needed)?text.ToString():"error="+Marshal.GetLastWin32Error(); }
    static string Security(IntPtr obj) { uint flags=4, needed; GetUserObjectSecurity(obj,ref flags,null,0,out needed); var bytes=new byte[needed]; bool ok=GetUserObjectSecurity(obj,ref flags,bytes,needed,out needed); return "readDacl="+ok+" error="+(ok?0:Marshal.GetLastWin32Error())+" bytes="+needed; }
    public static string Run() {
        var log=new StringBuilder();
        IntPtr original=GetProcessWindowStation(), threadDesktop=GetThreadDesktop(GetCurrentThreadId()), station=IntPtr.Zero, desktop=IntPtr.Zero;
        log.AppendLine("station="+Name(original)+" "+Security(original));
        log.AppendLine("desktop="+Name(threadDesktop)+" "+Security(threadDesktop));
        try {
            station=CreateWindowStation(null,0,0x80000008,IntPtr.Zero);
            log.AppendLine("createStation="+(station!=IntPtr.Zero)+" error="+(station!=IntPtr.Zero?0:Marshal.GetLastWin32Error()));
            if(station==IntPtr.Zero)return log.ToString();
            bool switched=SetProcessWindowStation(station);
            log.AppendLine("setStation="+switched+" error="+(switched?0:Marshal.GetLastWin32Error()));
            if(!switched)return log.ToString();
            desktop=CreateDesktop("a01_probe_"+System.Diagnostics.Process.GetCurrentProcess().Id,IntPtr.Zero,IntPtr.Zero,0,0xe0003,IntPtr.Zero);
            log.AppendLine("createDesktop="+(desktop!=IntPtr.Zero)+" error="+(desktop!=IntPtr.Zero?0:Marshal.GetLastWin32Error()));
        } finally {
            bool restored=SetProcessWindowStation(original); log.AppendLine("restoreStation="+restored);
            if(desktop!=IntPtr.Zero)CloseDesktop(desktop);
            if(station!=IntPtr.Zero)CloseWindowStation(station);
        }
        return log.ToString();
    }
}
