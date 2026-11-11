// Trace only a newly created Electron --version process; no attach to user processes.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class TraceElectron {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public uint cb;
        public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xCount, yCount, fill, flags;
        public ushort show, reservedSize;
        public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WaitForDebugEvent([Out] byte[] value, uint timeout);
    [DllImport("kernel32.dll")]
    static extern bool ContinueDebugEvent(uint pid, uint tid, uint status);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr process, IntPtr address, [Out] byte[] buffer, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern uint GetFinalPathNameByHandle(IntPtr file, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")]
    static extern IntPtr OpenThread(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetThreadContext(IntPtr thread, IntPtr context);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationThread(IntPtr thread, int infoClass, byte[] data, int size, out int returned);
    static void CaptureContext(IntPtr process, uint tid, SortedDictionary<ulong, string> modules, StringBuilder log) {
        IntPtr thread = OpenThread(0x48, false, tid);
        IntPtr allocation = Marshal.AllocHGlobal(1250);
        IntPtr context = new IntPtr((allocation.ToInt64() + 15) & ~15L);
        try {
            Marshal.WriteInt32(context, 48, 0x100003);
            if (!GetThreadContext(thread, context)) { log.AppendLine("GetThreadContext failed=" + Marshal.GetLastWin32Error()); return; }
            foreach (var item in new [] { new { Name="rax", Offset=120 }, new { Name="rcx", Offset=128 }, new { Name="rdx", Offset=136 }, new { Name="rbx", Offset=144 }, new { Name="rbp", Offset=160 }, new { Name="rsi", Offset=168 }, new { Name="rdi", Offset=176 }, new { Name="r8", Offset=184 }, new { Name="r9", Offset=192 }, new { Name="r10", Offset=200 }, new { Name="r11", Offset=208 }, new { Name="r12", Offset=216 }, new { Name="r13", Offset=224 }, new { Name="r14", Offset=232 }, new { Name="r15", Offset=240 } }) log.AppendLine(item.Name+"=0x"+Marshal.ReadInt64(context,item.Offset).ToString("x"));
            var basic = new byte[48]; int returned;
            if (NtQueryInformationThread(thread,0,basic,basic.Length,out returned)==0) {
                var error = new byte[4]; UIntPtr count;
                if (ReadProcessMemory(process,new IntPtr(BitConverter.ToInt64(basic,8)+0x68),error,(UIntPtr)4,out count)) log.AppendLine("remoteLastError="+BitConverter.ToUInt32(error,0));
            }
            foreach (var register in new [] { new { Name="rcx", Offset=128 }, new { Name="rdx", Offset=136 }, new { Name="rdi", Offset=176 }, new { Name="rsi", Offset=168 }, new { Name="r8", Offset=184 }, new { Name="r9", Offset=192 } }) {
                IntPtr address = new IntPtr(Marshal.ReadInt64(context, register.Offset));
                var text = new byte[512]; UIntPtr count;
                if (address != IntPtr.Zero && ReadProcessMemory(process, address, text, (UIntPtr)text.Length, out count)) {
                    int length = Array.IndexOf(text, (byte)0); if (length < 0) length = (int)count.ToUInt64();
                    if (length >= 4) {
                        string value = Encoding.UTF8.GetString(text, 0, length);
                        if (!System.Text.RegularExpressions.Regex.IsMatch(value, "[\\x00-\\x08\\x0e-\\x1f]")) log.AppendLine(register.Name + " text=" + value);
                    }
                }
            }
            var stack = new byte[512]; UIntPtr read;
            log.AppendLine("rsp=0x" + Marshal.ReadInt64(context, 152).ToString("x"));
            bool stackOk = ReadProcessMemory(process, new IntPtr(Marshal.ReadInt64(context, 152)), stack, (UIntPtr)stack.Length, out read);
            log.AppendLine("stackRead=" + stackOk + " bytes=" + read.ToUInt64() + " error=" + Marshal.GetLastWin32Error());
            if (read.ToUInt64() == 0) return;
            int printed = 0;
            for (int i=0; i+8 <= (int)read.ToUInt64() && printed < 60; i+=8) {
                ulong address = BitConverter.ToUInt64(stack, i); string owner=null;
                foreach (var module in modules) { if (module.Key > address) break; owner = address-module.Key < 0x10000000 ? module.Value + "+0x" + (address-module.Key).ToString("x") : null; }
                if (owner != null) { log.AppendLine("stack[0x" + i.ToString("x") + "]=" + owner); printed++; }
            }
        } finally { Marshal.FreeHGlobal(allocation); if (thread != IntPtr.Zero) CloseHandle(thread); }
    }
    static IntPtr Ptr(byte[] data, int offset) { return new IntPtr(BitConverter.ToInt64(data, offset)); }
    static string FileName(IntPtr handle) {
        if (handle == IntPtr.Zero || handle.ToInt64() == -1) return "<no file handle>";
        var buffer = new StringBuilder(32768);
        return GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0) != 0 ? buffer.ToString() : "<unavailable>";
    }
    public static string Run(string executable, string outputRoot) {
        Directory.CreateDirectory(outputRoot);
        var log = new StringBuilder();
        var environment = new List<string>();
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
            string key = entry.Key.ToString();
            if (System.Text.RegularExpressions.Regex.IsMatch(key, "^DSH_|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|^ELECTRON_|^NODE_OPTIONS$|^CHROME_", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) continue;
            environment.Add(key + "=" + entry.Value.ToString());
        }
        environment.Sort(StringComparer.OrdinalIgnoreCase);
        IntPtr env = Marshal.StringToHGlobalUni(String.Join("\0", environment) + "\0\0");
        var startup = new StartupInfo(); startup.cb = (uint)Marshal.SizeOf(startup);
        ProcessInfo process;
        var command = new StringBuilder("\"" + executable + "\" --version --enable-logging=stderr --user-data-dir=\"" + Path.Combine(outputRoot, "user-data") + "\"");
        bool created = CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false, 0x402, env, Path.GetDirectoryName(executable), ref startup, out process);
        Marshal.FreeHGlobal(env);
        if (!created) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        log.AppendLine("pid=" + process.pid + " executable=" + executable);
        bool initialBreakpoint = false, exited = false;
        var timer = Stopwatch.StartNew();
        var modules = new SortedDictionary<ulong, string>();
        try {
            while (timer.ElapsedMilliseconds < 20000) {
                var data = new byte[1024];
                if (!WaitForDebugEvent(data, 1000)) continue;
                uint code = BitConverter.ToUInt32(data, 0), pid = BitConverter.ToUInt32(data, 4), tid = BitConverter.ToUInt32(data, 8);
                uint continuation = 0x10002;
                if (code == 3 || code == 6) {
                    IntPtr file = Ptr(data, 16);
                    ulong address = (ulong)Ptr(data, code == 3 ? 40 : 24).ToInt64();
                    string name = FileName(file);
                    modules[address] = name;
                    log.AppendLine("module 0x" + address.ToString("x") + " " + name);
                    if (file != IntPtr.Zero) CloseHandle(file);
                } else if (code == 8) {
                    bool unicode = BitConverter.ToUInt16(data, 24) != 0;
                    int length = BitConverter.ToUInt16(data, 26) * (unicode ? 2 : 1);
                    var bytes = new byte[Math.Min(length, 65536)]; UIntPtr read;
                    if (ReadProcessMemory(process.process, Ptr(data, 16), bytes, (UIntPtr)bytes.Length, out read))
                        log.AppendLine("debug: " + (unicode ? Encoding.Unicode : Encoding.Default).GetString(bytes, 0, (int)read.ToUInt64()).TrimEnd('\0'));
                } else if (code == 1) {
                    uint exception = BitConverter.ToUInt32(data, 16);
                    ulong address = (ulong)Ptr(data, 32).ToInt64();
                    uint firstChance = BitConverter.ToUInt32(data, 168);
                    string owner = "unknown";
                    foreach (var module in modules) { if (module.Key > address) break; owner = module.Value + "+0x" + (address - module.Key).ToString("x"); }
                    log.AppendLine("exception 0x" + exception.ToString("x8") + " firstChance=" + firstChance + " at " + owner);
                    if (exception == 0x80000003 && !initialBreakpoint) initialBreakpoint = true;
                    else {
                        if (exception == 0x80000003 && firstChance == 1) CaptureContext(process.process, tid, modules, log);
                        continuation = 0x80010001;
                    }
                } else if (code == 5) {
                    log.AppendLine("exit=0x" + BitConverter.ToUInt32(data, 16).ToString("x8"));
                    exited = true;
                }
                ContinueDebugEvent(pid, tid, continuation);
                if (exited) break;
            }
        } finally {
            if (!exited) { log.AppendLine("timeout: terminated owned process"); TerminateProcess(process.process, 124); }
            CloseHandle(process.thread); CloseHandle(process.process);
        }
        string result = log.ToString();
        File.WriteAllText(Path.Combine(outputRoot, "debug-events.log"), result, new UTF8Encoding(false));
        return result;
    }
}
