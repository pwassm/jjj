# ============================================================================
#  (dev0929) Window helpers for the SLAM server consoles.  Dot-source this.
#
#  WHY TITLE MATCHING, AND NOT THE PROCESS OBJECT.
#  On Win11 the default terminal is Windows Terminal, so a console process does
#  NOT own its own window - WindowsTerminal.exe does, and the powershell/cmd we
#  launched reports MainWindowHandle = 0.  Every PID-based approach therefore
#  finds nothing on this machine.  Worse, .NET's MainWindowHandle deliberately
#  skips windows that are not visible, so it could never find one we had hidden
#  even under plain conhost.  The console TITLE is the handle we actually have:
#  it propagates to the WT tab and on to the WT window title, and it is equally
#  true under conhost.  The server titles ("SLAM proxy :8081", "SLAM web :8080")
#  are distinctive on purpose so this stays safe.
#
#  CAVEAT: if Windows Terminal is ever set to open new consoles as TABS in an
#  existing window rather than in a new window, hiding "the server window" would
#  hide that whole window, tabs and all.  Today each server gets its own window.
#
#  KEEP THIS FILE PURE ASCII - it is dot-sourced by scripts that powershell.exe
#  (5.1) reads in the system ANSI codepage.  See the header of proxy-loop.ps1
#  for what a stray em-dash does there.
# ============================================================================

if (-not ('SlamWin' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class SlamWin {
    delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll", EntryPoint="GetWindowTextW", CharSet=CharSet.Unicode)]
    static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll", EntryPoint="PostMessageW", CharSet=CharSet.Unicode)]
    public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    public static IntPtr[] ByTitle(string needle) {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            StringBuilder sb = new StringBuilder(512);
            if (GetWindowText(h, sb, sb.Capacity) > 0 &&
                sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
                found.Add(h);
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }
}
'@
}

$SW_HIDE = 0; $SW_SHOWNORMAL = 1; $SW_RESTORE = 9; $WM_CLOSE = 0x0010

# Windows whose title contains $Title. Finds HIDDEN ones too - that is the point.
function Get-SlamWindow {
    param([Parameter(Mandatory)][string]$Title)
    ,([SlamWin]::ByTitle($Title))
}

# Wait until a window with this title exists (a freshly launched console takes a
# moment to appear, and under Windows Terminal the title arrives later still,
# after the client process sets it). Returns the handles, or an empty array.
function Wait-SlamWindow {
    param([Parameter(Mandatory)][string]$Title, [int]$TimeoutMs = 8000)
    $n = 0
    while ($n * 200 -lt $TimeoutMs) {
        $h = [SlamWin]::ByTitle($Title)
        if ($h.Count -gt 0) { return ,$h }
        Start-Sleep -Milliseconds 200; $n++
    }
    return ,@()
}

function Hide-SlamWindow {
    param([Parameter(Mandatory)][string]$Title)
    $n = 0
    foreach ($h in [SlamWin]::ByTitle($Title)) { [void][SlamWin]::ShowWindow($h, 0); $n++ }
    return $n
}

function Show-SlamWindow {
    param([Parameter(Mandatory)][string]$Title, [switch]$Foreground)
    $n = 0
    foreach ($h in [SlamWin]::ByTitle($Title)) {
        [void][SlamWin]::ShowWindow($h, 9)          # SW_RESTORE: un-hides AND un-minimises
        if ($Foreground) { [void][SlamWin]::SetForegroundWindow($h) }
        $n++
    }
    return $n
}

function Test-SlamWindowVisible {
    param([Parameter(Mandatory)][string]$Title)
    foreach ($h in [SlamWin]::ByTitle($Title)) { if ([SlamWin]::IsWindowVisible($h)) { return $true } }
    return $false
}

# Politely close a leftover window whose console client is already dead (an
# orphaned "cmd /k" host, or a WT tab configured to survive its process).
function Close-SlamWindow {
    param([Parameter(Mandatory)][string]$Title)
    $n = 0
    foreach ($h in [SlamWin]::ByTitle($Title)) {
        [void][SlamWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); $n++
    }
    return $n
}
