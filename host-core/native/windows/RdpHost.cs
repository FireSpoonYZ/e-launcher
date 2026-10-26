using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using MSTSCLib;

namespace ELauncher.Shower
{
    /// <summary>
    /// AxHost wrapper for the MsRdpClient9 non-scriptable control (client9)
    /// 8B918B82-7985-4C24-89DF-C33AD2BBFBCD.
    /// </summary>
    internal sealed class RdpControl : AxHost
    {
        internal RdpControl()
            : base(RdpHost.ClientClsid)
        {
        }

        internal object Ocx
        {
            get { return GetOcx(); }
        }
    }

    /// <summary>
    /// Parent-session host. Owns the STA RDP child-session connection, the child session lifecycle and the
    /// named pipe server to the child-session agent. Capture and injection happen only in the agent, so this
    /// process never reads or drives the parent graphical session.
    /// </summary>
    internal sealed class RdpHost
    {
        internal const string ClientClsid = "8B918B82-7985-4C24-89DF-C33AD2BBFBCD";

        private const int PreviewOrigin = 80;
        private const int DefaultDesktopWidth = 1280;
        private const int DefaultDesktopHeight = 800;
        private const int WireFrameCapBytes = 2 * 1024 * 1024;
        private const int UiStartTimeoutMs = 20000;
        private const int UiStopTimeoutMs = 2000;
        private const int BootstrapTimeoutMs = 300000;
        private const int AgentConnectTimeoutMs = 60000;
        private const int LoginTimeoutMs = 600000;
        private const int RelayTimeoutMs = 25000;
        private const int SessionCloseTimeoutMs = 5000;

        private static readonly string[] WindowsKeys = new string[]
        {
            "ENTER", "TAB", "ESCAPE", "SPACE", "BACKSPACE", "DELETE", "LEFT", "UP", "RIGHT", "DOWN",
            "HOME", "END", "PAGEUP", "PAGEDOWN",
            "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R",
            "S", "T", "U", "V", "W", "X", "Y", "Z",
            "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
            "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"
        };

        private static readonly string[] RequestFields = new string[] { "id", "method", "params" };
        // Trusted metadata the manager forwards with any call; never guessed, never model supplied. The agent
        // only receives source/taskId, because its own schema rejects anything else.
        private static readonly string[] TrustedFields = new string[] { "source", "taskId", "callId" };
        private static readonly string[] StatusFields = WithTrusted(new string[] { "sessionId" });
        private static readonly string[] EnsureFields = WithTrusted(new string[] { "sessionId", "options" });
        private static readonly string[] CreateOptionFields = new string[] { "width", "height" };
        private static readonly string[] FrameFields = WithTrusted(new string[] { "sessionId", "limits" });
        private static readonly string[] FrameLimitFields = new string[] { "maxWidth", "maxHeight", "maxBytes" };
        private static readonly string[] InputFields = WithTrusted(new string[] { "sessionId", "input" });
        private static readonly string[] LaunchFields = WithTrusted(new string[] { "sessionId", "launch" });
        private static readonly string[] PreviewFields = WithTrusted(new string[] { "sessionId", "preview", "mode" });
        private static readonly string[] ReleaseFields = WithTrusted(new string[] { "sessionId" });
        private static readonly string[] CancelFields = WithTrusted(new string[] { "requestId" });

        private readonly string stateDir;
        private readonly string exePath;
        private readonly int parentSessionId;
        private readonly WireWriter wire;
        private readonly object stateLock = new object();
        private readonly object opLock = new object();
        private readonly object cleanupLock = new object();
        private readonly Dictionary<string, WireRelay> relays = new Dictionary<string, WireRelay>(StringComparer.Ordinal);
        private readonly ManualResetEventSlim uiReady = new ManualResetEventSlim(false);
        private readonly ManualResetEventSlim uiExited = new ManualResetEventSlim(false);
        private readonly ManualResetEventSlim loginComplete = new ManualResetEventSlim(false);

        private Form ui;
        private RdpControl control;
        private IMsRdpClient9 client;
        private string uiFault;
        private volatile bool closingUi;

        private string sessionId;
        private string phase = "idle";
        private string phaseCode;
        private string phaseMessage;
        private int sourceWidth;
        private int sourceHeight;
        private int childSession;
        private bool ownsChild;
        private string loginFault;
        private AgentLink agent;
        private DateTime updatedAt = DateTime.UtcNow;
        private int generation;
        private long frameSerial;

        private RdpHost(string stateDir)
        {
            this.stateDir = stateDir;
            exePath = ResolveExePath();
            parentSessionId = Process.GetCurrentProcess().SessionId;
            wire = new WireWriter(Console.Out);
        }

        internal static int Run(string[] args)
        {
            string stateDir = CommandLine.Value(args, "--state-dir");
            if (string.IsNullOrEmpty(stateDir))
            {
                HostLog.Warn("host requires --state-dir <absolute directory>");
                return 2;
            }
            string resolved;
            try
            {
                resolved = Path.GetFullPath(stateDir);
                Directory.CreateDirectory(resolved);
            }
            catch (Exception ex)
            {
                HostLog.Warn("state dir is unusable: " + ex.Message);
                return 2;
            }
            var host = new RdpHost(resolved);
            return host.Execute();
        }

        private int Execute()
        {
            StartUiThread();
            if (!uiReady.Wait(UiStartTimeoutMs) || uiFault != null)
            {
                HostLog.Warn("rdp window failed: " + (uiFault ?? "it did not start in time"));
                ShutdownUi();
                return 1;
            }
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null) HandleLine(line);
            }
            catch (Exception ex)
            {
                HostLog.Warn("stdin failed: " + ex.Message);
            }
            HostLog.Info("stdin closed; releasing the owned session");
            string owned = CurrentSession();
            if (owned != null)
            {
                try
                {
                    Cleanup(owned, "eof");
                }
                catch (Exception ex)
                {
                    HostLog.Warn("cleanup failed: " + ex.Message);
                }
            }
            ShutdownUi();
            return 0;
        }

        private static string ResolveExePath()
        {
            try
            {
                return Process.GetCurrentProcess().MainModule.FileName;
            }
            catch (Exception)
            {
                return Application.ExecutablePath;
            }
        }

        private void StartUiThread()
        {
            var thread = new Thread(UiThreadMain);
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.STA);
            thread.Name = "shower-host-rdp";
            thread.Start();
        }

        private void UiThreadMain()
        {
            try
            {
                Application.EnableVisualStyles();
                ui = new Form();
                ui.Text = "e-launcher shower";
                ui.FormBorderStyle = FormBorderStyle.SizableToolWindow;
                ui.ShowInTaskbar = false;
                ui.StartPosition = FormStartPosition.Manual;
                ui.Location = new Point(PreviewOrigin, PreviewOrigin);
                ui.Size = new Size(DefaultDesktopWidth, DefaultDesktopHeight);
                ui.FormClosing += delegate(object sender, FormClosingEventArgs e)
                {
                    if (closingUi) return;
                    // Closing the preview window must not tear down the graphical environment.
                    e.Cancel = true;
                    ui.Visible = false;
                };
                IntPtr handle = ui.Handle;
                if (handle == IntPtr.Zero) HostLog.Warn("rdp window has no handle");
                uiReady.Set();
                Application.Run(new ApplicationContext(ui));
            }
            catch (Exception ex)
            {
                uiFault = ex.GetType().Name + ": " + ex.Message;
                HostLog.Warn("rdp window failed: " + uiFault);
                uiReady.Set();
            }
            finally
            {
                uiExited.Set();
            }
        }

        private void ShutdownUi()
        {
            closingUi = true;
            Form form = ui;
            if (form == null) return;
            try
            {
                if (form.IsHandleCreated && !form.IsDisposed)
                {
                    form.BeginInvoke((MethodInvoker)delegate { Application.ExitThread(); });
                }
            }
            catch (Exception)
            {
            }
            uiExited.Wait(UiStopTimeoutMs);
        }

        private void RunOnUi(Action action)
        {
            Form form = ui;
            if (form == null || form.IsDisposed || !form.IsHandleCreated)
            {
                throw new HostFault(HostErrorCodes.Unavailable, "the rdp window is not available");
            }
            if (!form.InvokeRequired)
            {
                action();
                return;
            }
            Exception failure = null;
            form.Invoke((MethodInvoker)delegate
            {
                try
                {
                    action();
                }
                catch (Exception ex)
                {
                    failure = ex;
                }
            });
            if (failure != null) throw failure;
        }

        // ---------------------------------------------------------------------------------- request loop

        private void HandleLine(string line)
        {
            if (line == null || line.Trim().Length == 0) return;
            Dictionary<string, object> envelope = WireJson.TryParseObject(line);
            if (envelope == null)
            {
                HostLog.Warn("dropped a malformed request line");
                return;
            }
            string id = WireJson.GetString(envelope, "id");
            if (string.IsNullOrEmpty(id))
            {
                HostLog.Warn("dropped a request without id");
                return;
            }
            string unknown;
            if (WireJson.HasUnexpectedField(envelope, RequestFields, out unknown))
            {
                wire.Failure(id, HostErrorCodes.InvalidArgument, "unknown request field: " + unknown, null);
                return;
            }
            string method = WireJson.GetString(envelope, "method");
            if (string.IsNullOrEmpty(method))
            {
                wire.Failure(id, HostErrorCodes.InvalidArgument, "request.method must be a non-empty string", null);
                return;
            }
            Dictionary<string, object> parameters;
            object rawParameters = WireJson.Get(envelope, "params");
            if (rawParameters == null)
            {
                parameters = new Dictionary<string, object>();
            }
            else
            {
                parameters = rawParameters as Dictionary<string, object>;
                if (parameters == null)
                {
                    wire.Failure(id, HostErrorCodes.InvalidArgument, "request.params must be an object", null);
                    return;
                }
            }
            var request = new WireRequest(id, method, parameters);
            ThreadPool.QueueUserWorkItem(delegate { Handle(request); });
        }

        private void Handle(WireRequest request)
        {
            bool tracked = request.Method == "frame" || request.Method == "input" || request.Method == "launch";
            WireRelay relay = null;
            if (tracked)
            {
                relay = new WireRelay();
                lock (stateLock)
                {
                    relays[request.Id] = relay;
                }
            }
            try
            {
                object result;
                switch (request.Method)
                {
                    case "status":
                        result = Status(request.Params);
                        break;
                    case "ensure":
                        result = Ensure(request.Params);
                        break;
                    case "frame":
                        lock (opLock)
                        {
                            result = Frame(request.Params, relay);
                        }
                        break;
                    case "input":
                        lock (opLock)
                        {
                            result = Forward(request.Params, relay, false);
                        }
                        break;
                    case "launch":
                        lock (opLock)
                        {
                            result = Forward(request.Params, relay, true);
                        }
                        break;
                    case "preview":
                        lock (opLock)
                        {
                            result = Preview(request.Params);
                        }
                        break;
                    case "release":
                        result = Release(request.Params);
                        break;
                    case "cancel":
                        result = Cancel(request.Params);
                        break;
                    default:
                        throw new HostFault(HostErrorCodes.Unsupported, "unknown method: " + request.Method + "; expected status, ensure, frame, input, launch, preview, release or cancel");
                }
                wire.Result(request.Id, result);
            }
            catch (HostFault fault)
            {
                wire.Failure(request.Id, fault.Code, fault.Message, fault.Outcome);
            }
            catch (Exception ex)
            {
                HostLog.Warn(request.Method + " failed: " + ex.GetType().Name + ": " + ex.Message);
                wire.Failure(request.Id, HostErrorCodes.BackendFailed, ex.Message, null);
            }
            finally
            {
                if (tracked)
                {
                    lock (stateLock)
                    {
                        relays.Remove(request.Id);
                    }
                }
            }
        }

        // ---------------------------------------------------------------------------------- status

        private object Status(Dictionary<string, object> parameters)
        {
            CheckFields(parameters, StatusFields, "status");
            string requested = WireJson.GetString(parameters, "sessionId");
            lock (stateLock)
            {
                if (!string.IsNullOrEmpty(requested) && sessionId != null && !string.Equals(requested, sessionId, StringComparison.Ordinal))
                {
                    throw new HostFault(HostErrorCodes.SessionMismatch, "session " + requested + " is not owned by this host");
                }
                return Snapshot();
            }
        }

        private Dictionary<string, object> Snapshot()
        {
            var session = new Dictionary<string, object>();
            session["sessionId"] = sessionId;
            session["platform"] = "windows";
            session["phase"] = phase;
            session["width"] = sourceWidth;
            session["height"] = sourceHeight;
            session["capabilities"] = Capabilities();
            session["updatedAt"] = updatedAt.ToString("o", CultureInfo.InvariantCulture);
            if (string.Equals(phase, "error", StringComparison.Ordinal) && phaseCode != null)
            {
                var error = new Dictionary<string, object>();
                error["code"] = phaseCode;
                error["message"] = phaseMessage ?? string.Empty;
                session["error"] = error;
            }
            return session;
        }

        private static Dictionary<string, object> Capabilities()
        {
            var launchKinds = new List<object>();
            // The Windows agent launches program paths; there is no Windows app catalog behind this host.
            launchKinds.Add("process");
            var inputKinds = new List<object>();
            inputKinds.Add("click");
            inputKinds.Add("drag");
            inputKinds.Add("scroll");
            inputKinds.Add("key");
            inputKinds.Add("text");
            var keys = new List<object>();
            for (int i = 0; i < WindowsKeys.Length; i++) keys.Add(WindowsKeys[i]);
            var capabilities = new Dictionary<string, object>();
            capabilities["launchKinds"] = launchKinds;
            capabilities["inputKinds"] = inputKinds;
            capabilities["keys"] = keys;
            capabilities["nativePreview"] = true;
            return capabilities;
        }

        private void SetPhase(string next, string code, string message)
        {
            Dictionary<string, object> snapshot;
            bool changed;
            lock (stateLock)
            {
                changed = !string.Equals(phase, next, StringComparison.Ordinal) || !string.Equals(phaseCode, code, StringComparison.Ordinal);
                snapshot = ApplyPhase(next, code, message);
            }
            if (changed) wire.StatusEvent(snapshot);
        }

        private void SetPhaseFor(int expectedGeneration, string next, string code, string message)
        {
            Dictionary<string, object> snapshot = null;
            bool changed = false;
            lock (stateLock)
            {
                if (generation != expectedGeneration) return;
                changed = !string.Equals(phase, next, StringComparison.Ordinal) || !string.Equals(phaseCode, code, StringComparison.Ordinal);
                snapshot = ApplyPhase(next, code, message);
            }
            if (changed) wire.StatusEvent(snapshot);
        }

        /// <summary>Caller holds stateLock; returns the snapshot that matches the new phase.</summary>
        private Dictionary<string, object> ApplyPhase(string next, string code, string message)
        {
            phase = next;
            phaseCode = code;
            phaseMessage = message;
            updatedAt = DateTime.UtcNow;
            return Snapshot();
        }

        private bool IsCurrent(int expectedGeneration)
        {
            lock (stateLock)
            {
                return generation == expectedGeneration;
            }
        }

        private void RequireCurrent(int expectedGeneration)
        {
            if (!IsCurrent(expectedGeneration)) throw new HostFault(HostErrorCodes.Cancelled, "the session start was superseded by release");
        }

        private void MarkReady()
        {
            Dictionary<string, object> snapshot;
            lock (stateLock)
            {
                if (sessionId == null || string.Equals(phase, "ready", StringComparison.Ordinal)) return;
                snapshot = ApplyPhase("ready", null, null);
            }
            wire.StatusEvent(snapshot);
        }

        private string CurrentSession()
        {
            lock (stateLock)
            {
                return sessionId;
            }
        }

        private string RequireSession(Dictionary<string, object> parameters)
        {
            string requested = WireJson.GetString(parameters, "sessionId");
            if (string.IsNullOrEmpty(requested)) throw new HostFault(HostErrorCodes.InvalidArgument, "params.sessionId is required");
            lock (stateLock)
            {
                if (sessionId == null) throw new HostFault(HostErrorCodes.SessionNotFound, "this host owns no session");
                if (!string.Equals(sessionId, requested, StringComparison.Ordinal))
                {
                    throw new HostFault(HostErrorCodes.SessionMismatch, "session " + requested + " is not owned by this host");
                }
            }
            return requested;
        }

        private void RequireReady()
        {
            string current;
            string code;
            string message;
            lock (stateLock)
            {
                current = phase;
                code = phaseCode;
                message = phaseMessage;
            }
            if (string.Equals(current, "ready", StringComparison.Ordinal)) return;
            if (string.Equals(current, "error", StringComparison.Ordinal) && code != null)
            {
                throw new HostFault(code, message ?? "the child session failed");
            }
            if (string.Equals(current, "authentication-required", StringComparison.Ordinal))
            {
                throw new HostFault(HostErrorCodes.AuthRequired, message ?? "the child session still needs a local sign-in or unlock");
            }
            throw new HostFault(HostErrorCodes.NotReady, "the child session is " + current);
        }

        private static void CheckFields(Dictionary<string, object> parameters, string[] allowed, string method)
        {
            string unknown;
            if (WireJson.HasUnexpectedField(parameters, allowed, out unknown))
            {
                throw new HostFault(HostErrorCodes.InvalidArgument, "unknown " + method + " field: " + unknown);
            }
        }

        private static string[] WithTrusted(string[] fields)
        {
            var allowed = new string[fields.Length + TrustedFields.Length];
            Array.Copy(fields, allowed, fields.Length);
            Array.Copy(TrustedFields, 0, allowed, fields.Length, TrustedFields.Length);
            return allowed;
        }

        // ---------------------------------------------------------------------------------- ensure

        private object Ensure(Dictionary<string, object> parameters)
        {
            CheckFields(parameters, EnsureFields, "ensure");
            string requested = WireJson.GetString(parameters, "sessionId");
            if (string.IsNullOrEmpty(requested)) throw new HostFault(HostErrorCodes.InvalidArgument, "params.sessionId is required");
            Dictionary<string, object> options = WireJson.GetObject(parameters, "options");
            CheckFields(options, CreateOptionFields, "options");
            int width = OptionDimension(options, "width");
            int height = OptionDimension(options, "height");
            int expectedGeneration;
            lock (stateLock)
            {
                if (sessionId != null)
                {
                    if (!string.Equals(sessionId, requested, StringComparison.Ordinal))
                    {
                        throw new HostFault(HostErrorCodes.Busy, "this host already owns session " + sessionId);
                    }
                    return Snapshot();
                }
                generation++;
                expectedGeneration = generation;
                sessionId = requested;
                childSession = 0;
                ownsChild = false;
                sourceWidth = 0;
                sourceHeight = 0;
                frameSerial = 0;
                loginFault = null;
                loginComplete.Reset();
            }
            // The RDP logon, the credential prompt and the bootstrap steps all continue in the background so
            // the caller never waits on a local UAC or credentials dialog.
            SetPhase("starting", null, null);
            var worker = new Thread(delegate { StartSession(expectedGeneration, width, height); });
            worker.IsBackground = true;
            worker.Name = "shower-host-start";
            worker.Start();
            return Snapshot();
        }

        private void StartSession(int expectedGeneration, int width, int height)
        {
            AgentLink link = null;
            try
            {
                int before = HostNative.ChildSessionId();
                if (before == HostNative.UnsupportedChildSessions)
                {
                    throw new HostFault(HostErrorCodes.Unavailable, "this Windows build does not expose WTSGetChildSessionId; child sessions are unavailable");
                }
                HostLog.Info("child session before connect: " + before.ToString(CultureInfo.InvariantCulture));
                RunBounded("child session enablement", delegate { SessionBootstrap.EnsureEnabled(stateDir); }, BootstrapTimeoutMs);
                RequireCurrent(expectedGeneration);
                link = new AgentLink();
                AgentLink pending = link;
                lock (stateLock)
                {
                    agent = pending;
                }
                ConnectRdp(width, height);
                SetPhaseFor(expectedGeneration, "authentication-required", null, null);
                if (!loginComplete.Wait(LoginTimeoutMs))
                {
                    // Bounded: the caller releases and creates again, which reopens the credential prompt.
                    throw new HostFault(HostErrorCodes.BackendFailed, "the rdp logon did not finish within " + (LoginTimeoutMs / 1000).ToString(CultureInfo.InvariantCulture) + " seconds; release the session and create it again to sign in locally");
                }
                RequireCurrent(expectedGeneration);
                string fault;
                lock (stateLock)
                {
                    fault = loginFault;
                }
                if (fault != null) throw new HostFault(HostErrorCodes.BackendFailed, fault);
                int child = WaitForChildSession();
                if (child <= 0) throw new HostFault(HostErrorCodes.Unavailable, "no child session was created after logon");
                if (child == parentSessionId) throw new HostFault(HostErrorCodes.SessionMismatch, "the reported child session is the parent session");
                VerifyChildSessionUser(child);
                lock (stateLock)
                {
                    childSession = child;
                    ownsChild = true;
                }
                HostLog.Info("child session " + child.ToString(CultureInfo.InvariantCulture) + " is logged on");
                // Logon complete: hide the native preview but keep the session and its desktop alive.
                ApplyPreview("hidden");
                int launchedChild = child;
                AgentLink launched = link;
                RunBounded("agent launch", delegate { SessionBootstrap.LaunchAgent(launchedChild, parentSessionId, launched.PipeName, stateDir, exePath); }, BootstrapTimeoutMs);
                RequireCurrent(expectedGeneration);
                link.WaitForAgent(child, AgentConnectTimeoutMs);
                RequireCurrent(expectedGeneration);
                ProbeFrame(link, child);
                SetPhaseFor(expectedGeneration, "ready", null, null);
                HostLog.Info("child session " + child.ToString(CultureInfo.InvariantCulture) + " is ready");
            }
            catch (HostFault fault)
            {
                if (fault.Code == HostErrorCodes.AuthRequired)
                {
                    // The agent is connected but its desktop is locked or still signing in; a later frame
                    // recovers once the user unlocks the child session.
                    HostLog.Warn("child session is not usable yet: " + fault.Message);
                    SetPhaseFor(expectedGeneration, "authentication-required", fault.Code, fault.Message);
                    return;
                }
                FailStart(expectedGeneration, fault.Code, fault.Message, link);
            }
            catch (Exception ex)
            {
                FailStart(expectedGeneration, HostErrorCodes.BackendFailed, ex.GetType().Name + ": " + ex.Message, link);
            }
        }

        private void FailStart(int expectedGeneration, string code, string message, AgentLink link)
        {
            if (!IsCurrent(expectedGeneration)) return;
            HostLog.Warn("child session start failed: " + code + ": " + message);
            if (link != null)
            {
                AgentLink current;
                lock (stateLock)
                {
                    current = agent;
                }
                if (object.ReferenceEquals(current, link)) AbortAgent();
            }
            SetPhaseFor(expectedGeneration, "error", code, message);
        }

        private void ProbeFrame(AgentLink link, int child)
        {
            var limits = new Dictionary<string, object>();
            limits["maxWidth"] = AgentCaptureLimits.MinDimension;
            limits["maxHeight"] = AgentCaptureLimits.MinDimension;
            limits["maxBytes"] = AgentCaptureLimits.MinLimitBytes;
            var parameters = new Dictionary<string, object>();
            parameters["sessionId"] = child;
            parameters["limits"] = limits;
            Dictionary<string, object> frame;
            try
            {
                frame = link.Call("frame", parameters, RelayTimeoutMs, null);
            }
            catch (HostFault fault)
            {
                // A locked or still signing-in desktop is an authentication state, not a broken session.
                if (fault.Code == HostErrorCodes.NotReady) throw new HostFault(HostErrorCodes.AuthRequired, fault.Message);
                throw;
            }
            CacheSourceSize(frame);
            int width;
            int height;
            lock (stateLock)
            {
                width = sourceWidth;
                height = sourceHeight;
            }
            HostLog.Info("agent desktop is " + width.ToString(CultureInfo.InvariantCulture) + "x" + height.ToString(CultureInfo.InvariantCulture));
        }

        /// <summary>The child session appears with the logon and may lag the OnLoginComplete event briefly.</summary>
        private static int WaitForChildSession()
        {
            for (int attempt = 0; attempt < 20; attempt++)
            {
                int child = HostNative.ChildSessionId();
                if (child > 0) return child;
                if (child == HostNative.UnsupportedChildSessions) return 0;
                Thread.Sleep(500);
            }
            return 0;
        }

        private void VerifyChildSessionUser(int child)
        {
            string childUser = HostNative.QuerySessionUser(child);
            string parentUser = HostNative.QuerySessionUser(parentSessionId);
            if (childUser == null || parentUser == null)
            {
                HostLog.Warn("cannot read the child session user; continuing with the parent session identity");
                return;
            }
            if (!string.Equals(childUser, parentUser, StringComparison.OrdinalIgnoreCase))
            {
                throw new HostFault(HostErrorCodes.SessionMismatch, "child session " + child.ToString(CultureInfo.InvariantCulture) + " belongs to " + childUser + ", not " + parentUser);
            }
        }

        private static int OptionDimension(Dictionary<string, object> options, string name)
        {
            object raw = WireJson.Get(options, name);
            if (raw == null) return 0;
            int? value = WireJson.Int(raw);
            if (value == null || value.Value < AgentCaptureLimits.MinDimension || value.Value > AgentCaptureLimits.MaxDimension)
            {
                throw new HostFault(
                    HostErrorCodes.InvalidArgument,
                    "options." + name + " must be " + AgentCaptureLimits.MinDimension.ToString(CultureInfo.InvariantCulture) + ".." + AgentCaptureLimits.MaxDimension.ToString(CultureInfo.InvariantCulture));
            }
            return value.Value;
        }

        private void RunBounded(string label, Action action, int timeoutMs)
        {
            Exception failure = null;
            var thread = new Thread(delegate
            {
                try
                {
                    action();
                }
                catch (Exception ex)
                {
                    failure = ex;
                }
            });
            thread.IsBackground = true;
            thread.Name = "shower-host-" + label;
            thread.Start();
            if (!thread.Join(timeoutMs))
            {
                throw new HostFault(HostErrorCodes.BackendFailed, label + " did not finish within " + timeoutMs.ToString(CultureInfo.InvariantCulture) + " ms");
            }
            if (failure is HostFault) throw (HostFault)failure;
            if (failure != null)
            {
                throw new HostFault(HostErrorCodes.PermissionRequired, label + " failed: " + failure.Message);
            }
        }

        // ---------------------------------------------------------------------------------- RDP client (STA)

        private void ConnectRdp(int width, int height)
        {
            RunOnUi(delegate
            {
                if (ui == null) throw new HostFault(HostErrorCodes.Unavailable, "the rdp window is not available");
                control = new RdpControl();
                control.Dock = DockStyle.Fill;
                ui.Controls.Add(control);
                object ocx = control.Ocx;
                IMsRdpClient9 rdp = (IMsRdpClient9)ocx;
                IMsTscAxEvents_Event events = (IMsTscAxEvents_Event)ocx;
                client = rdp;
                events.OnLoginComplete += delegate { HandleLoginComplete(); };
                events.OnDisconnected += delegate(int reason) { HandleDisconnected(reason); };
                events.OnFatalError += delegate(int code) { HandleFatal(code); };
                rdp.Server = "localhost";
                rdp.DesktopWidth = width > 0 ? width : DefaultDesktopWidth;
                rdp.DesktopHeight = height > 0 ? height : DefaultDesktopHeight;
                rdp.ColorDepth = 32;
                rdp.AdvancedSettings7.EnableCredSspSupport = true;
                rdp.AdvancedSettings7.AuthenticationLevel = 0;
                rdp.AdvancedSettings7.EnableAutoReconnect = false;
                rdp.AdvancedSettings7.RedirectClipboard = false;
                // Credentials only ever come from the local Windows prompt: nothing is supplied, stored or logged.
                ((IMsRdpClientNonScriptable5)ocx).AllowPromptingForCredentials = true;
                ((IMsRdpClientNonScriptable3)ocx).PromptForCredentials = true;
                ((IMsRdpClientNonScriptable4)ocx).AllowCredentialSaving = false;
                object connectToChild = true;
                ((IMsRdpExtendedSettings)ocx).set_Property("ConnectToChildSession", ref connectToChild);
                lock (stateLock)
                {
                    loginFault = null;
                }
                // The credential prompt and the fresh child desktop need a reachable local window.
                ui.ShowInTaskbar = true;
                ui.Visible = true;
                rdp.Connect();
                HostLog.Info("rdp connect requested against localhost with ConnectToChildSession");
            });
        }

        private void HandleLoginComplete()
        {
            if (control == null) return;
            HostLog.Info("rdp logon complete");
            loginComplete.Set();
        }

        private void HandleDisconnected(int reason)
        {
            if (control == null) return;
            string description = null;
            try
            {
                IMsRdpClient9 rdp = client;
                if (rdp != null) description = rdp.GetErrorDescription((uint)reason, (uint)rdp.ExtendedDisconnectReason);
            }
            catch (Exception)
            {
            }
            string message = "rdp connection closed (reason " + reason.ToString(CultureInfo.InvariantCulture) + ")" + (description == null ? string.Empty : ": " + description);
            HostLog.Warn(message);
            bool report;
            lock (stateLock)
            {
                loginFault = message;
                // A pending start worker reports this itself; a finished session is already closed.
                report = sessionId != null
                    && !string.Equals(phase, "starting", StringComparison.Ordinal)
                    && !string.Equals(phase, "authentication-required", StringComparison.Ordinal);
            }
            loginComplete.Set();
            if (!report) return;
            AbortAgent();
            SetPhase("error", HostErrorCodes.BackendFailed, message);
        }

        private void HandleFatal(int code)
        {
            if (control == null) return;
            string message = "rdp fatal error " + code.ToString(CultureInfo.InvariantCulture);
            HostLog.Warn(message);
            bool report;
            lock (stateLock)
            {
                loginFault = message;
                report = sessionId != null
                    && !string.Equals(phase, "starting", StringComparison.Ordinal)
                    && !string.Equals(phase, "authentication-required", StringComparison.Ordinal);
            }
            loginComplete.Set();
            if (!report) return;
            AbortAgent();
            SetPhase("error", HostErrorCodes.BackendFailed, message);
        }

        private void ApplyPreview(string mode)
        {
            try
            {
                RunOnUi(delegate
                {
                    if (ui == null) return;
                    switch (mode)
                    {
                        case "visible":
                            ui.ShowInTaskbar = true;
                            ui.WindowState = FormWindowState.Normal;
                            ui.Location = new Point(PreviewOrigin, PreviewOrigin);
                            ui.Visible = true;
                            ui.Activate();
                            break;
                        case "minimized":
                            ui.ShowInTaskbar = false;
                            ui.Visible = true;
                            ui.WindowState = FormWindowState.Minimized;
                            break;
                        case "offscreen":
                            ui.ShowInTaskbar = false;
                            ui.WindowState = FormWindowState.Normal;
                            ui.Location = new Point(-32000, -32000);
                            ui.Visible = true;
                            break;
                        default:
                            ui.Visible = false;
                            ui.ShowInTaskbar = false;
                            break;
                    }
                });
            }
            catch (HostFault)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw new HostFault(HostErrorCodes.BackendFailed, "preview " + mode + " failed: " + ex.Message);
            }
        }

        private void DisconnectRdp()
        {
            try
            {
                RunOnUi(delegate
                {
                    IMsRdpClient9 rdp = client;
                    if (rdp != null)
                    {
                        try
                        {
                            if (rdp.Connected != 0) rdp.Disconnect();
                        }
                        catch (Exception ex)
                        {
                            HostLog.Warn("rdp disconnect failed: " + ex.Message);
                        }
                    }
                    client = null;
                    if (control != null)
                    {
                        try
                        {
                            if (ui != null) ui.Controls.Remove(control);
                            control.Dispose();
                        }
                        catch (Exception ex)
                        {
                            HostLog.Warn("rdp control dispose failed: " + ex.Message);
                        }
                        control = null;
                    }
                });
            }
            catch (HostFault fault)
            {
                HostLog.Warn("rdp cleanup skipped: " + fault.Message);
            }
            catch (Exception ex)
            {
                HostLog.Warn("rdp cleanup skipped: " + ex.Message);
            }
        }

        // ---------------------------------------------------------------------------------- frame and input

        private object Frame(Dictionary<string, object> parameters, WireRelay relay)
        {
            CheckFields(parameters, FrameFields, "frame");
            string requested = RequireSession(parameters);
            Dictionary<string, object> limits = BuildFrameLimits(WireJson.GetObject(parameters, "limits"));
            AgentLink link;
            int child;
            lock (stateLock)
            {
                link = agent;
                child = childSession;
            }
            if (link == null) throw new HostFault(HostErrorCodes.NotReady, "the child session agent is not connected");
            if (child <= 0) throw new HostFault(HostErrorCodes.NotReady, "the child session is still starting");
            ThrowIfCancelled(relay);
            var forwarded = new Dictionary<string, object>();
            forwarded["sessionId"] = child;
            forwarded["limits"] = limits;
            Dictionary<string, object> frame = link.Call("frame", forwarded, RelayTimeoutMs, relay);
            if (frame == null) throw new HostFault(HostErrorCodes.BackendFailed, "the child session agent returned no frame");
            string owner = WireJson.GetString(frame, "sessionId");
            if (owner != null && !string.Equals(owner, requested, StringComparison.Ordinal))
            {
                throw new HostFault(HostErrorCodes.SessionMismatch, "the agent frame belongs to another session");
            }
            string encoded = WireJson.GetString(frame, "data");
            if (string.IsNullOrEmpty(encoded)) throw new HostFault(HostErrorCodes.BackendFailed, "the child session frame has no image data");
            long maxBytes = WireJson.Long(WireJson.Get(limits, "maxBytes")) ?? AgentCaptureLimits.DefaultMaxBytes;
            if (encoded.Length > maxBytes)
            {
                throw new HostFault(HostErrorCodes.FrameTooLarge, "the frame needs " + encoded.Length.ToString(CultureInfo.InvariantCulture) + " base64 bytes, the limit is " + maxBytes.ToString(CultureInfo.InvariantCulture));
            }
            if (encoded.Length > WireFrameCapBytes)
            {
                throw new HostFault(HostErrorCodes.FrameTooLarge, "the frame exceeds the " + WireFrameCapBytes.ToString(CultureInfo.InvariantCulture) + " byte native wire cap");
            }
            CacheSourceSize(frame);
            string frameId;
            lock (stateLock)
            {
                frameSerial++;
                frameId = "windows-" + frameSerial.ToString(CultureInfo.InvariantCulture);
            }
            var result = new Dictionary<string, object>(frame);
            result["sessionId"] = requested;
            result["frameId"] = frameId;
            MarkReady();
            return result;
        }

        private object Forward(Dictionary<string, object> parameters, WireRelay relay, bool launch)
        {
            CheckFields(parameters, launch ? LaunchFields : InputFields, launch ? "launch" : "input");
            string requested = RequireSession(parameters);
            string field = launch ? "launch" : "input";
            Dictionary<string, object> payload = WireJson.GetObject(parameters, field);
            if (payload == null) throw new HostFault(HostErrorCodes.InvalidArgument, "params." + field + " must be an object");
            RequireReady();
            AgentLink link;
            int child;
            lock (stateLock)
            {
                link = agent;
                child = childSession;
            }
            if (link == null || child <= 0) throw new HostFault(HostErrorCodes.NotReady, "the child session agent is not connected");
            ThrowIfCancelled(relay);
            var forwarded = new Dictionary<string, object>();
            forwarded["sessionId"] = child;
            forwarded[field] = payload;
            string source = WireJson.GetString(parameters, "source");
            if (source != null) forwarded["source"] = source;
            string taskId = WireJson.GetString(parameters, "taskId");
            if (taskId != null) forwarded["taskId"] = taskId;
            Dictionary<string, object> result = link.Call(field, forwarded, RelayTimeoutMs, relay);
            if (result == null) result = new Dictionary<string, object>();
            return result;
        }

        private static void ThrowIfCancelled(WireRelay relay)
        {
            if (relay != null && relay.Cancelled)
            {
                throw new HostFault(HostErrorCodes.Cancelled, "the request was cancelled before it reached the child session", "not-sent");
            }
        }

        private static Dictionary<string, object> BuildFrameLimits(Dictionary<string, object> limits)
        {
            CheckFields(limits, FrameLimitFields, "limits");
            var result = new Dictionary<string, object>();
            result["maxWidth"] = DimensionLimit(limits, "maxWidth", AgentCaptureLimits.DefaultMaxWidth);
            result["maxHeight"] = DimensionLimit(limits, "maxHeight", AgentCaptureLimits.DefaultMaxHeight);
            result["maxBytes"] = ByteLimit(limits, "maxBytes", AgentCaptureLimits.DefaultMaxBytes);
            return result;
        }

        private static int DimensionLimit(Dictionary<string, object> limits, string name, int fallback)
        {
            object raw = WireJson.Get(limits, name);
            if (raw == null) return fallback;
            int? value = WireJson.Int(raw);
            if (value == null || value.Value < AgentCaptureLimits.MinDimension || value.Value > AgentCaptureLimits.MaxDimension)
            {
                throw new HostFault(
                    HostErrorCodes.InvalidArgument,
                    "frame.limits." + name + " must be " + AgentCaptureLimits.MinDimension.ToString(CultureInfo.InvariantCulture) + ".." + AgentCaptureLimits.MaxDimension.ToString(CultureInfo.InvariantCulture));
            }
            return value.Value;
        }

        private static long ByteLimit(Dictionary<string, object> limits, string name, int fallback)
        {
            object raw = WireJson.Get(limits, name);
            if (raw == null) return fallback;
            long? value = WireJson.Long(raw);
            if (value == null || value.Value < AgentCaptureLimits.MinLimitBytes)
            {
                throw new HostFault(HostErrorCodes.InvalidArgument, "frame.limits.maxBytes must be at least " + AgentCaptureLimits.MinLimitBytes.ToString(CultureInfo.InvariantCulture));
            }
            // The agent cannot encode beyond its own cap; a larger budget is satisfied by a smaller frame.
            return Math.Min(value.Value, (long)AgentCaptureLimits.MaxLimitBytes);
        }

        private void CacheSourceSize(Dictionary<string, object> frame)
        {
            int? width = WireJson.Int(WireJson.Get(frame, "width"));
            int? height = WireJson.Int(WireJson.Get(frame, "height"));
            lock (stateLock)
            {
                if (width != null && width.Value > 0) sourceWidth = width.Value;
                if (height != null && height.Value > 0) sourceHeight = height.Value;
                updatedAt = DateTime.UtcNow;
            }
        }

        // ---------------------------------------------------------------------------------- preview, cancel, release

        private object Preview(Dictionary<string, object> parameters)
        {
            CheckFields(parameters, PreviewFields, "preview");
            string requested = RequireSession(parameters);
            string mode = WireJson.GetString(parameters, "preview");
            if (mode == null) mode = WireJson.GetString(parameters, "mode");
            if (string.IsNullOrEmpty(mode))
            {
                throw new HostFault(HostErrorCodes.InvalidArgument, "params.preview must be visible, minimized, offscreen or hidden");
            }
            mode = mode.ToLowerInvariant();
            if (mode != "visible" && mode != "minimized" && mode != "offscreen" && mode != "hidden")
            {
                throw new HostFault(HostErrorCodes.Unsupported, "preview mode " + mode + " is not supported; expected visible, minimized, offscreen or hidden");
            }
            ApplyPreview(mode);
            var result = new Dictionary<string, object>();
            result["sessionId"] = requested;
            result["preview"] = mode;
            return result;
        }

        private object Cancel(Dictionary<string, object> parameters)
        {
            CheckFields(parameters, CancelFields, "cancel");
            string requestId = WireJson.GetString(parameters, "requestId");
            if (string.IsNullOrEmpty(requestId)) throw new HostFault(HostErrorCodes.InvalidArgument, "params.requestId is required");
            WireRelay relay;
            AgentLink link;
            lock (stateLock)
            {
                relays.TryGetValue(requestId, out relay);
                link = agent;
            }
            bool cancelled = false;
            if (relay != null)
            {
                relay.Cancel();
                cancelled = true;
                string agentRequestId = relay.AgentRequestId;
                // Cancellation must never replay input; the agent stops the operation in flight.
                if (agentRequestId != null && link != null) link.CancelRemote(agentRequestId);
            }
            var result = new Dictionary<string, object>();
            result["requestId"] = requestId;
            result["cancelled"] = cancelled;
            return result;
        }

        private object Release(Dictionary<string, object> parameters)
        {
            CheckFields(parameters, ReleaseFields, "release");
            string requested = WireJson.GetString(parameters, "sessionId");
            string owned;
            lock (stateLock)
            {
                if (sessionId == null) return Released(null);
                if (!string.IsNullOrEmpty(requested) && !string.Equals(requested, sessionId, StringComparison.Ordinal))
                {
                    throw new HostFault(HostErrorCodes.SessionMismatch, "session " + requested + " is not owned by this host");
                }
                owned = sessionId;
            }
            Cleanup(owned, "release");
            HostLog.Info("released session " + owned);
            return Released(owned);
        }

        private static Dictionary<string, object> Released(string owned)
        {
            var result = new Dictionary<string, object>();
            result["released"] = true;
            result["sessionId"] = owned;
            result["phase"] = "closed";
            return result;
        }

        private void Cleanup(string owned, string reason)
        {
            lock (cleanupLock)
            {
                int child;
                bool ownedChild;
                lock (stateLock)
                {
                    if (sessionId != null && owned != null && !string.Equals(sessionId, owned, StringComparison.Ordinal)) return;
                    // Invalidate any start worker still running for the previous session.
                    generation++;
                    child = childSession;
                    ownedChild = ownsChild;
                    sessionId = null;
                    childSession = 0;
                    ownsChild = false;
                    sourceWidth = 0;
                    sourceHeight = 0;
                    frameSerial = 0;
                    loginFault = null;
                    updatedAt = DateTime.UtcNow;
                }
                AbortAgent();
                try
                {
                    ApplyPreview("hidden");
                }
                catch (Exception ex)
                {
                    HostLog.Warn("preview cleanup failed: " + ex.Message);
                }
                DisconnectRdp();
                LogOffChild(child, ownedChild);
                // Unblocks a start worker waiting for logon so it can observe the stale generation.
                loginComplete.Set();
                SetPhase("closed", null, null);
                HostLog.Info("session " + (owned ?? "none") + " cleaned up (" + reason + ")");
            }
        }

        private void AbortAgent()
        {
            AgentLink link;
            lock (stateLock)
            {
                link = agent;
                agent = null;
            }
            if (link == null) return;
            try
            {
                link.ReleaseAndClose(SessionCloseTimeoutMs);
            }
            catch (Exception ex)
            {
                HostLog.Warn("agent cleanup failed: " + ex.Message);
            }
        }

        /// <summary>Only a child session this host created is logged off; a pre-existing one is left alone.</summary>
        private void LogOffChild(int child, bool owned)
        {
            if (!owned || child <= 0 || child == parentSessionId) return;
            HostLog.Info("logging off the owned child session " + child.ToString(CultureInfo.InvariantCulture));
            if (!HostNative.LogoffSession(child))
            {
                HostLog.Warn("logoff of child session " + child.ToString(CultureInfo.InvariantCulture) + " was refused; it ends with the connection");
            }
        }
    }
}
