using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Threading;

namespace ELauncher.Shower
{
    /// <summary>
    /// 记录 EnsureEnabled 改前的系统状态，并在所属宿主退出后把子会话开关与 TermService 恢复原值。
    /// 只恢复自己记录的原值，绝不改 Hello/NLA/防火墙/RDP-Tcp。
    /// </summary>
    internal static class BootstrapGuardian
    {
        private const long HostStartToleranceTicks = 2 * TimeSpan.TicksPerSecond;
        private const int PollMilliseconds = 2000;

        internal sealed class EnableState
        {
            internal int HostPid;
            internal long HostStartTicks;
            internal bool ChildSessionsBefore;
            internal bool TermServiceBeforeRunning;
            internal bool Applied;
            internal int GuardianPid;
            internal string CreatedUtc;
        }

        internal static int Run(string[] args)
        {
            Dictionary<string, string> options = SessionBootstrap.ParseOptions(args, 1);
            string dir;
            try
            {
                dir = BootstrapFile.NormalizeDir(BootstrapFile.Get(options, "state-dir"), false);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("bootstrap-guard: " + e.Message);
                return 2;
            }
            int hostPid = BootstrapFile.GetInt(options, "host-pid", 0);
            if (hostPid <= 0)
            {
                return 2;
            }
            EnableState state = ReadState(dir);
            if (state == null || state.HostPid != hostPid)
            {
                BootstrapLog.Write(dir, "guardian 退出：没有属于宿主 " + hostPid.ToString(CultureInfo.InvariantCulture) + " 的状态记录");
                return 0;
            }
            BootstrapLog.Write(dir, "guardian 监视宿主 pid=" + hostPid.ToString(CultureInfo.InvariantCulture));
            while (HostAlive(state))
            {
                Thread.Sleep(PollMilliseconds);
                EnableState current = ReadState(dir);
                if (current == null || current.HostPid != state.HostPid || current.HostStartTicks != state.HostStartTicks)
                {
                    BootstrapLog.Write(dir, "guardian 退出：状态记录已被替换或已恢复");
                    return 0;
                }
            }

            bool restored = RestoreValues(dir, state.ChildSessionsBefore, state.TermServiceBeforeRunning);
            BootstrapLog.Write(dir, "宿主已退出，恢复结果 restored=" + restored);
            EnableState latest = ReadState(dir);
            if (restored && latest != null && latest.HostPid == state.HostPid && latest.HostStartTicks == state.HostStartTicks)
            {
                TryDelete(StatePath(dir));
            }
            return 0;
        }

        internal static string StatePath(string dir)
        {
            return Path.Combine(dir, BootstrapFile.EnableStateName);
        }

        internal static EnableState ReadState(string dir)
        {
            string path = StatePath(dir);
            try
            {
                if (!File.Exists(path))
                {
                    return null;
                }
                Dictionary<string, string> map = BootstrapFile.Read(path);
                EnableState state = new EnableState();
                state.HostPid = BootstrapFile.GetInt(map, "hostPid", 0);
                state.HostStartTicks = BootstrapFile.GetLong(map, "hostStartTicks", 0);
                state.ChildSessionsBefore = BootstrapFile.GetBool(map, "childSessionsBefore", false);
                state.TermServiceBeforeRunning = BootstrapFile.GetBool(map, "termServiceBeforeRunning", false);
                state.Applied = BootstrapFile.GetBool(map, "applied", false);
                state.GuardianPid = BootstrapFile.GetInt(map, "guardianPid", 0);
                state.CreatedUtc = BootstrapFile.Get(map, "createdUtc");
                if (state.HostPid <= 0 || state.HostStartTicks <= 0)
                {
                    return null;
                }
                return state;
            }
            catch (Exception)
            {
                return null;
            }
        }

        internal static void WriteState(string dir, EnableState state)
        {
            Dictionary<string, string> map = new Dictionary<string, string>();
            BootstrapFile.Set(map, "version", "1");
            BootstrapFile.SetInt(map, "hostPid", state.HostPid);
            BootstrapFile.SetLong(map, "hostStartTicks", state.HostStartTicks);
            BootstrapFile.Set(map, "childSessionsBefore", state.ChildSessionsBefore ? "1" : "0");
            BootstrapFile.Set(map, "termServiceBeforeRunning", state.TermServiceBeforeRunning ? "1" : "0");
            BootstrapFile.Set(map, "applied", state.Applied ? "1" : "0");
            BootstrapFile.SetInt(map, "guardianPid", state.GuardianPid);
            BootstrapFile.Set(map, "createdUtc", state.CreatedUtc);
            BootstrapFile.Write(StatePath(dir), map);
        }

        /// <summary>
        /// 非提权宿主无法探测提权 guardian 的存活，因此这里只看“本宿主已生效”的持久记录；
        /// 真正的 guardian 存活校验放在提权路径里做。
        /// </summary>
        internal static bool IsReadyForHost(string dir, int hostPid, long hostStartTicks)
        {
            EnableState state = ReadState(dir);
            return state != null
                && state.HostPid == hostPid
                && state.HostStartTicks == hostStartTicks
                && state.Applied;
        }

        internal static void DeleteState(string dir)
        {
            TryDelete(StatePath(dir));
        }

        /// <summary>上一次宿主异常退出留下未恢复的基线时，先尝试恢复，避免把已改动状态当成新基线。</summary>
        internal static void RestoreAbandoned(string dir)
        {
            EnableState state = ReadState(dir);
            if (state == null || HostAlive(state))
            {
                return;
            }
            BootstrapLog.Write(dir, "发现已退出宿主遗留的启用状态，先恢复原值");
            bool restored = RestoreValues(dir, state.ChildSessionsBefore, state.TermServiceBeforeRunning);
            if (restored)
            {
                TryDelete(StatePath(dir));
            }
            else
            {
                BootstrapLog.Write(dir, "遗留状态恢复失败，保留记录作为基线");
            }
        }

        internal static bool RestoreValues(string dir, bool childSessionsBefore, bool termServiceBeforeRunning)
        {
            bool ok = true;
            if (!childSessionsBefore)
            {
                bool restored = false;
                for (int attempt = 0; attempt < 3 && !restored; attempt++)
                {
                    try
                    {
                        bool current;
                        if (!BootstrapNative.TryIsChildSessionsEnabled(out current))
                        {
                            Thread.Sleep(1000);
                            continue;
                        }
                        if (!current)
                        {
                            restored = true;
                            break;
                        }
                        BootstrapNative.SetChildSessionsEnabled(false);
                        bool after;
                        restored = BootstrapNative.TryIsChildSessionsEnabled(out after) && !after;
                    }
                    catch (Exception e)
                    {
                        BootstrapLog.Write(dir, "恢复子会话开关失败: " + e.Message);
                    }
                    if (!restored)
                    {
                        Thread.Sleep(1000);
                    }
                }
                if (!restored)
                {
                    ok = false;
                    BootstrapLog.Write(dir, "子会话开关未能恢复为 false");
                }
            }
            if (!termServiceBeforeRunning)
            {
                try
                {
                    if (!BootstrapNative.TryStopTermService(TimeSpan.FromSeconds(30)))
                    {
                        ok = false;
                        BootstrapLog.Write(dir, "TermService 未能恢复为 Stopped");
                    }
                }
                catch (Exception e)
                {
                    ok = false;
                    BootstrapLog.Write(dir, "恢复 TermService 失败: " + e.Message);
                }
            }
            return ok;
        }

        internal static bool GuardianAlive(int pid)
        {
            if (pid <= 0)
            {
                return false;
            }
            try
            {
                using (Process process = Process.GetProcessById(pid))
                {
                    return !process.HasExited;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        internal static int Spawn(string dir, int hostPid, long hostStartTicks)
        {
            string exe = SessionBootstrap.SelfExePath();
            string arguments = "bootstrap-guard --state-dir " + SessionBootstrap.Quote(dir)
                + " --host-pid " + hostPid.ToString(CultureInfo.InvariantCulture);
            ProcessStartInfo info = new ProcessStartInfo(exe, arguments);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            info.WorkingDirectory = Path.GetDirectoryName(exe);
            Process guardian = Process.Start(info);
            int pid = guardian.Id;
            guardian.Dispose();
            BootstrapLog.Write(dir, "已启动 guardian pid=" + pid.ToString(CultureInfo.InvariantCulture)
                + " 监视宿主 " + hostPid.ToString(CultureInfo.InvariantCulture)
                + "(start=" + hostStartTicks.ToString(CultureInfo.InvariantCulture) + ")");
            return pid;
        }

        private static bool HostAlive(EnableState state)
        {
            try
            {
                using (Process process = Process.GetProcessById(state.HostPid))
                {
                    long start = process.StartTime.ToUniversalTime().Ticks;
                    return Math.Abs(start - state.HostStartTicks) <= HostStartToleranceTicks;
                }
            }
            catch (ArgumentException)
            {
                return false;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
            catch (Win32Exception)
            {
                return false;
            }
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception)
            {
            }
        }
    }
}
