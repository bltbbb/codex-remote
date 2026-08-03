using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CodexRemote.NativeHost;

internal static partial class Program
{
    private const string ExpectedCodexVersion = "0.146.0-alpha.9.2";
    private const string ExpectedCodexSha256 = "ECD7A3EAFF5E42723DBBA03B5C91514B3986B5DB5CBCA8F34619620B5356F31F";
    private const string ExpectedDesktopVersion = "26.727.6591.0";
    private const string ExpectedSourceTag = "rust-v0.146.0-alpha.9.2";
    private const string DiscoveryPipeName = "codex-remote-native-v1";
    private const string SingletonMutexName = "Local\\CodexRemote.NativeHost.v1";
    private const int MaxProtocolMessageBytes = 32 * 1024 * 1024;
    private static readonly TimeSpan StartupTimeout = TimeSpan.FromSeconds(20);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly bool TraceEnabled = Environment.GetEnvironmentVariable("CODEX_REMOTE_NATIVE_HOST_TRACE") == "1";

    public static async Task<int> Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        Console.SetError(new StreamWriter(
            Console.OpenStandardError(),
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false))
        {
            AutoFlush = true,
        });
        try
        {
            string realCodexPath = ResolveRealCodexPath();
            ValidateRealCodex(realCodexPath);
            if (!IsDesktopStdioAppServer(args))
            {
                return await ForwardCommandAsync(realCodexPath, args);
            }

            ValidateDesktopParent();

            using var singleton = new Mutex(initiallyOwned: true, SingletonMutexName, out bool createdNew);
            if (!createdNew)
            {
                throw new InvalidOperationException("Codex Remote Native Host 已在运行；拒绝创建第二个桌面 app-server 实例");
            }

            return await RunDesktopHostAsync(realCodexPath, args);
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"Codex Remote Native Host 启动失败：{exception.Message}");
            return 1;
        }
    }

    private static bool IsDesktopStdioAppServer(IReadOnlyList<string> args)
    {
        bool hasAppServer = args.Any(argument => string.Equals(argument, "app-server", StringComparison.OrdinalIgnoreCase));
        bool hasListen = args.Any(argument => string.Equals(argument, "--listen", StringComparison.OrdinalIgnoreCase));
        return hasAppServer && !hasListen;
    }

    private static string ResolveRealCodexPath()
    {
        string? configured = Environment.GetEnvironmentVariable("CODEX_REMOTE_REAL_CODEX_PATH");
        if (string.IsNullOrWhiteSpace(configured))
        {
            configured = Path.Combine(AppContext.BaseDirectory, "codex-real.exe");
        }

        string fullPath = Path.GetFullPath(configured.Trim());
        string currentExecutable = Environment.ProcessPath ?? string.Empty;
        if (string.Equals(fullPath, currentExecutable, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("真实 Codex 路径不能指向 Native Host 自身");
        }
        return fullPath;
    }

    private static async Task<int> ForwardCommandAsync(string realCodexPath, IReadOnlyList<string> args)
    {
        if (!File.Exists(realCodexPath))
        {
            throw new FileNotFoundException("未找到真实 Codex 可执行文件", realCodexPath);
        }

        ProcessStartInfo startInfo = CreateProcessStartInfo(realCodexPath, args, redirect: true);
        startInfo.RedirectStandardInput = true;
        using var process = new Process { StartInfo = startInfo };
        if (!process.Start())
        {
            throw new InvalidOperationException("无法启动真实 Codex");
        }
        Task stdout = CopyStreamAsync(process.StandardOutput.BaseStream, Console.OpenStandardOutput());
        Task stderr = CopyStreamAsync(process.StandardError.BaseStream, Console.OpenStandardError());
        Task stdin = CopyStreamAsync(Console.OpenStandardInput(), process.StandardInput.BaseStream);
        await process.WaitForExitAsync();
        process.StandardInput.Close();
        await Task.WhenAll(stdout, stderr);
        _ = stdin.ContinueWith(
            static task => _ = task.Exception,
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted,
            TaskScheduler.Default);
        return process.ExitCode;
    }

    private static async Task CopyStreamAsync(Stream source, Stream destination)
    {
        try
        {
            await source.CopyToAsync(destination);
            await destination.FlushAsync();
        }
        catch (IOException)
        {
            // 目标进程退出时关闭管道属于正常生命周期。
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private static void ValidateRealCodex(string realCodexPath)
    {
        if (!File.Exists(realCodexPath))
        {
            throw new FileNotFoundException("未找到阶段 0 验证过的 Codex 原生副本", realCodexPath);
        }

        string actualHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(realCodexPath)));
        if (!string.Equals(actualHash, ExpectedCodexSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"Codex 原生哈希不匹配：当前 {actualHash}，预期 {ExpectedCodexSha256}");
        }

        string version = ReadCodexVersion(realCodexPath);
        if (!string.Equals(version, ExpectedCodexVersion, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Codex 原生版本不匹配：当前 {version}，预期 {ExpectedCodexVersion}");
        }
    }

    private static string ReadCodexVersion(string realCodexPath)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = realCodexPath,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            },
        };
        process.StartInfo.ArgumentList.Add("--version");
        if (!process.Start())
        {
            throw new InvalidOperationException("无法读取 Codex 版本");
        }
        string output = process.StandardOutput.ReadToEnd() + "\n" + process.StandardError.ReadToEnd();
        if (!process.WaitForExit(10_000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("读取 Codex 版本超时");
        }
        Match match = CodexVersionRegex().Match(output.Trim());
        if (!match.Success)
        {
            throw new InvalidOperationException($"无法识别 Codex 版本：{output.Trim()}");
        }
        return match.Groups[1].Value;
    }

    private static void ValidateDesktopParent()
    {
        if (Environment.GetEnvironmentVariable("CODEX_REMOTE_NATIVE_HOST_ALLOW_NON_DESKTOP_PARENT") == "1")
        {
            return;
        }

        using Process? parent = TryGetParentProcess();
        string parentPath = parent?.MainModule?.FileName ?? string.Empty;
        if (string.IsNullOrWhiteSpace(parentPath))
        {
            throw new InvalidOperationException("无法确认 Native Host 的 Codex Desktop 父进程");
        }

        string normalized = parentPath.Replace('/', '\\');
        if (!normalized.Contains($"OpenAI.Codex_{ExpectedDesktopVersion}_x64__", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(Path.GetFileName(normalized), "ChatGPT.exe", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"Codex Desktop 版本或父进程不匹配：{parentPath}");
        }
    }

    private static Process? TryGetParentProcess()
    {
        var information = new ProcessBasicInformation();
        int status = NtQueryInformationProcess(
            Process.GetCurrentProcess().Handle,
            processInformationClass: 0,
            ref information,
            Marshal.SizeOf<ProcessBasicInformation>(),
            out _);
        if (status != 0 || information.InheritedFromUniqueProcessId == IntPtr.Zero)
        {
            return null;
        }
        try
        {
            return Process.GetProcessById(checked((int)information.InheritedFromUniqueProcessId.ToInt64()));
        }
        catch
        {
            return null;
        }
    }

    private static async Task<int> RunDesktopHostAsync(string realCodexPath, IReadOnlyList<string> desktopArgs)
    {
        int port = ReserveLoopbackPort();
        string endpoint = $"ws://127.0.0.1:{port}";
        string token = CreateCapabilityToken();
        string tokenSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

        var realArgs = desktopArgs.Concat(
        [
            "--listen", endpoint,
            "--ws-auth", "capability-token",
            "--ws-token-sha256", tokenSha256,
        ]).ToArray();

        using var realProcess = new Process { StartInfo = CreateProcessStartInfo(realCodexPath, realArgs, redirect: true) };
        if (!realProcess.Start())
        {
            throw new InvalidOperationException("无法启动真实 Codex app-server");
        }

        using var lifetime = new CancellationTokenSource();
        Task stdoutLog = PumpLogAsync(realProcess.StandardOutput, "native-out", lifetime.Token);
        Task stderrLog = PumpLogAsync(realProcess.StandardError, "native-err", lifetime.Token);

        try
        {
            await WaitUntilReadyAsync(endpoint, realProcess, lifetime.Token);
            Trace("真实 app-server 已就绪");
            using ClientWebSocket desktopSocket = await ConnectAppServerAsync(endpoint, token, lifetime.Token);
            Trace("Desktop WebSocket 适配连接已建立");
            var discovery = new HostDiscovery(
                ProtocolVersion: 1,
                Endpoint: endpoint,
                CapabilityToken: token,
                HostPid: Environment.ProcessId,
                CodexPid: realProcess.Id,
                CodexVersion: ExpectedCodexVersion,
                DesktopVersion: ExpectedDesktopVersion,
                SourceTag: ExpectedSourceTag,
                CodexSha256: ExpectedCodexSha256);

            Task pipeServer = RunDiscoveryPipeAsync(discovery, lifetime.Token);
            Task stdinPump = PumpStdinToWebSocketAsync(desktopSocket, lifetime.Token);
            Task stdoutPump = PumpWebSocketToStdoutAsync(desktopSocket, lifetime.Token);
            Trace("stdio 双向转发任务已启动");
            Task processExit = realProcess.WaitForExitAsync(lifetime.Token);

            Task completed = await Task.WhenAny(stdinPump, stdoutPump, processExit);
            await completed;
            if (completed == processExit && realProcess.ExitCode != 0)
            {
                throw new InvalidOperationException($"真实 Codex app-server 已退出，代码 {realProcess.ExitCode}");
            }

            lifetime.Cancel();
            await CloseWebSocketAsync(desktopSocket);
            await IgnoreCancellationAsync(pipeServer);
            return realProcess.HasExited ? realProcess.ExitCode : 0;
        }
        finally
        {
            lifetime.Cancel();
            if (!realProcess.HasExited)
            {
                realProcess.Kill(entireProcessTree: true);
                await realProcess.WaitForExitAsync();
            }
            await IgnoreCancellationAsync(stdoutLog);
            await IgnoreCancellationAsync(stderrLog);
        }
    }

    private static ProcessStartInfo CreateProcessStartInfo(string executable, IEnumerable<string> args, bool redirect)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            RedirectStandardInput = false,
            RedirectStandardOutput = redirect,
            RedirectStandardError = redirect,
            CreateNoWindow = true,
            WorkingDirectory = Environment.CurrentDirectory,
        };
        foreach (string argument in args)
        {
            startInfo.ArgumentList.Add(argument);
        }
        return startInfo;
    }

    private static int ReserveLoopbackPort()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static string CreateCapabilityToken()
    {
        return Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    private static async Task WaitUntilReadyAsync(string endpoint, Process process, CancellationToken cancellationToken)
    {
        DateTimeOffset deadline = DateTimeOffset.UtcNow + StartupTimeout;
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        string readyUrl = endpoint.Replace("ws://", "http://", StringComparison.Ordinal) + "/readyz";

        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (process.HasExited)
            {
                throw new InvalidOperationException($"真实 Codex app-server 在就绪前退出，代码 {process.ExitCode}");
            }
            try
            {
                using HttpResponseMessage response = await http.GetAsync(readyUrl, cancellationToken);
                if (response.IsSuccessStatusCode)
                {
                    return;
                }
            }
            catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                // 单次探测超时后继续，直到总启动超时。
            }
            catch (HttpRequestException)
            {
                // 监听器尚未就绪。
            }
            await Task.Delay(100, cancellationToken);
        }
        throw new TimeoutException("真实 Codex app-server 未在 20 秒内就绪");
    }

    private static async Task<ClientWebSocket> ConnectAppServerAsync(string endpoint, string token, CancellationToken cancellationToken)
    {
        var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Authorization", $"Bearer {token}");
        await socket.ConnectAsync(new Uri(endpoint), cancellationToken);
        return socket;
    }

    private static async Task PumpStdinToWebSocketAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        using var stdin = new StreamReader(
            Console.OpenStandardInput(),
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            detectEncodingFromByteOrderMarks: true,
            bufferSize: 4 * 1024,
            leaveOpen: true);
        Trace("等待 Desktop stdin");
        while (!cancellationToken.IsCancellationRequested)
        {
            string? line = await stdin.ReadLineAsync(cancellationToken);
            if (line is null)
            {
                Trace("Desktop stdin 已关闭");
                return;
            }
            Trace("收到 Desktop stdin 消息");
            byte[] payload = Encoding.UTF8.GetBytes(line);
            if (payload.Length > MaxProtocolMessageBytes)
            {
                throw new InvalidDataException("Desktop 发往 app-server 的单条协议消息超过 32 MiB");
            }
            await socket.SendAsync(payload, WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
            Trace("Desktop stdin 消息已转发");
        }
    }

    private static async Task PumpWebSocketToStdoutAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        byte[] buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        while (!cancellationToken.IsCancellationRequested)
        {
            WebSocketReceiveResult result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                Trace("app-server WebSocket 已关闭");
                return;
            }
            if (result.MessageType != WebSocketMessageType.Text)
            {
                continue;
            }
            message.Write(buffer, 0, result.Count);
            if (message.Length > MaxProtocolMessageBytes)
            {
                throw new InvalidDataException("app-server 发往 Desktop 的单条协议消息超过 32 MiB");
            }
            if (!result.EndOfMessage)
            {
                continue;
            }
            string line = Encoding.UTF8.GetString(message.GetBuffer(), 0, checked((int)message.Length));
            message.SetLength(0);
            Trace("收到 app-server WebSocket 消息");
            await Console.Out.WriteLineAsync(line);
            await Console.Out.FlushAsync(cancellationToken);
            Trace("app-server 消息已写入 Desktop stdout");
        }
    }

    private static async Task PumpLogAsync(StreamReader reader, string source, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                string? line = await reader.ReadLineAsync(cancellationToken);
                if (line is null)
                {
                    return;
                }
                Console.Error.WriteLine($"[{source}] {line}");
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private static async Task RunDiscoveryPipeAsync(HostDiscovery discovery, CancellationToken cancellationToken)
    {
        string response = JsonSerializer.Serialize(discovery, JsonOptions);
        while (!cancellationToken.IsCancellationRequested)
        {
            using var pipe = new NamedPipeServerStream(
                DiscoveryPipeName,
                PipeDirection.InOut,
                maxNumberOfServerInstances: 1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await pipe.WaitForConnectionAsync(cancellationToken);
                using var reader = new StreamReader(pipe, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
                using var writer = new StreamWriter(pipe, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), 4096, leaveOpen: true)
                {
                    AutoFlush = true,
                };
                string? request = await reader.ReadLineAsync(cancellationToken);
                if (request is null || !request.Contains("status", StringComparison.OrdinalIgnoreCase))
                {
                    await writer.WriteLineAsync("{\"error\":\"unsupported_command\"}");
                    continue;
                }
                await writer.WriteLineAsync(response);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (IOException exception)
            {
                Console.Error.WriteLine($"[discovery] 命名管道连接失败：{exception.Message}");
            }
        }
    }

    private static async Task CloseWebSocketAsync(ClientWebSocket socket)
    {
        if (socket.State is not WebSocketState.Open and not WebSocketState.CloseReceived)
        {
            return;
        }
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
            await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "desktop disconnected", timeout.Token);
        }
        catch
        {
        }
    }

    private static async Task IgnoreCancellationAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (OperationCanceledException)
        {
        }
        catch (IOException)
        {
        }
    }

    private static void Trace(string message)
    {
        if (TraceEnabled) Console.Error.WriteLine($"[native-host-trace] {message}");
    }

    [GeneratedRegex(@"(?:codex-cli\s+)?([^\s]+)$", RegexOptions.Multiline)]
    private static partial Regex CodexVersionRegex();

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        ref ProcessBasicInformation processInformation,
        int processInformationLength,
        out int returnLength);

    #pragma warning disable CS0649 // 字段由 NtQueryInformationProcess 写入。
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }
    #pragma warning restore CS0649

    private sealed record HostDiscovery(
        int ProtocolVersion,
        string Endpoint,
        string CapabilityToken,
        int HostPid,
        int CodexPid,
        string CodexVersion,
        string DesktopVersion,
        string SourceTag,
        string CodexSha256);
}
