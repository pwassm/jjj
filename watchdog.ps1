# ============================================================================
#  SLAM proxy watchdog  (dev0657)
#  The "SlamProxyWatchdog" per-user scheduled task runs this every minute.
#  If nothing is listening on :8081 the proxy has died (the #1 cause of the
#  I screen's "no VPN exit would come up" - a WireGuard rotation RSTs an
#  in-flight socket and, pre-dev0656, that killed node). We relaunch it via
#  restart-proxy.ps1 so the proxy is self-healing with zero clicks.
#
#  Per-user, runs only when logged on, NO elevation. To turn it off:
#     schtasks /end /tn SlamProxyWatchdog   (this run)
#     schtasks /delete /tn SlamProxyWatchdog /f   (permanently)
#  or use the "Watchdog" toggle in the I screen's Fix panel.
# ============================================================================
$ErrorActionPreference = 'SilentlyContinue'

function Test-ProxyUp {
    return [bool](Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue)
}

if (Test-ProxyUp) { return }          # proxy alive - nothing to do

# Give a restart that may already be in flight (node booting, not yet bound) a
# moment to finish, so we don't kick a second overlapping restart.
Start-Sleep -Seconds 3
if (Test-ProxyUp) { return }

$log = Join-Path $env:LOCALAPPDATA 'ProtonVpnRotate\watchdog.log'
try { "$([DateTime]::Now.ToString('s'))  proxy :8081 down -> relaunching" | Add-Content -Path $log } catch {}
& (Join-Path $PSScriptRoot 'restart-proxy.ps1') *>> $log
