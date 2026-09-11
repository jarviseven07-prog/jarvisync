using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[assembly: AssemblyTitle("JarviSync")]
[assembly: AssemblyDescription("JarviSync 看板")]
[assembly: AssemblyProduct("JarviSync")]
[assembly: AssemblyCompany("Jarvis")]
[assembly: AssemblyVersion("0.1.1.0")]

internal static class Launcher
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    [STAThread]
    private static int Main()
    {
        try {
            SetCurrentProcessExplicitAppUserModelID("Jarvis.JarviSync");
            string root = Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)).FullName;
            string script = Path.Combine(root, "scripts", "launch-board.ps1");
            if (!File.Exists(script)) throw new FileNotFoundException("未找到 JarviSync 启动文件。", script);
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            var start = new ProcessStartInfo(powershell) {
                Arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File \"" + script + "\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (var process = Process.Start(start)) {
                process.WaitForExit();
                if (process.ExitCode == 0) return 0;
            }
            string log = Path.Combine(root, "data", "launcher", "last-error.txt");
            string message = File.Exists(log) ? File.ReadAllText(log) : "启动未完成，请检查 JarviSync 启动日志。";
            throw new InvalidOperationException(message);
        } catch (Exception error) {
            MessageBox.Show(error.Message, "JarviSync 未能打开", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
