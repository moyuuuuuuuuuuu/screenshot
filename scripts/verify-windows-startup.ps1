param(
    [string]$Executable = (
        Join-Path $PSScriptRoot '..\apps\desktop\src-tauri\target\debug\screenshot-tool.exe'
    )
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class StartupWindowVisibility
{
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder text, int count);

    public static int CountVisibleTauriWindows(uint targetProcessId)
    {
        var count = 0;
        EnumWindows((window, _) =>
        {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId != targetProcessId || !IsWindowVisible(window))
            {
                return true;
            }

            var className = new StringBuilder(256);
            GetClassName(window, className, className.Capacity);
            if (className.ToString() == "Tauri Window")
            {
                count += 1;
            }
            return true;
        }, IntPtr.Zero);
        return count;
    }
}
'@

$existing = @(Get-Process screenshot-tool -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
    throw 'Close existing screenshot-tool processes before running the startup probe.'
}

$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$process = Start-Process -FilePath $resolvedExecutable -PassThru

try {
    Start-Sleep -Seconds 3
    $process.Refresh()
    if ($process.HasExited) {
        throw "screenshot-tool exited during startup with code $($process.ExitCode)."
    }

    $visibleTauriWindows = [StartupWindowVisibility]::CountVisibleTauriWindows(
        [uint32]$process.Id
    )
    if ($visibleTauriWindows -ne 0) {
        throw "screenshot-tool owns $visibleTauriWindows visible Tauri window(s) after tray startup."
    }

    [PSCustomObject]@{
        ProcessAlive = $true
        VisibleTauriWindows = $visibleTauriWindows
        WorkingSetBytes = $process.WorkingSet64
    } | Format-List
}
finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        $process.WaitForExit()
    }
}
