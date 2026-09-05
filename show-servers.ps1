# ============================================================================
#  (dev0929) Toggle the two SLAM server windows in and out of view.
#  Bound to AHK LButton & z, launched with AHK's Hide option so this script's
#  own console never flashes.
#
#  restart-proxy.ps1 hides "SLAM web :8080" and "SLAM proxy :8081" once the
#  build check passes, because nobody reads them 99% of the time.  The 1% is
#  real though: the proxy window is where an IG grind's [ig/download] chatter
#  and the crash/restart lines appear.  This brings it back.
#
#  Visibility is decided by the PROXY window (the one worth looking at); the web
#  window follows it, so the pair stays in step.
#
#  KEEP PURE ASCII - see the header of proxy-loop.ps1.
# ============================================================================
param(
    [ValidateSet('Toggle', 'Show', 'Hide')]
    [string]$Action = 'Toggle'
)
. 'M:\jjj\slam-windows.ps1'

$proxyTitle = 'SLAM proxy :8081'
$webTitle   = 'SLAM web :8080'

if ($Action -eq 'Toggle') {
    $Action = if (Test-SlamWindowVisible -Title $proxyTitle) { 'Hide' } else { 'Show' }
}

if ($Action -eq 'Show') {
    [void](Show-SlamWindow -Title $webTitle)
    $n = Show-SlamWindow -Title $proxyTitle -Foreground
    if ($n -eq 0) {
        # Nothing to show. Say so out loud: this script normally runs hidden, so a
        # silent no-op would look identical to a broken hotkey.
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show(
            "No SLAM server windows found - the servers are not running." + [Environment]::NewLine +
            "Start them with LButton & t.", 'SLAM servers') | Out-Null
    }
} else {
    [void](Hide-SlamWindow -Title $webTitle)
    [void](Hide-SlamWindow -Title $proxyTitle)
}
