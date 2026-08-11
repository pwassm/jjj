# vpn-rotate.ps1  (dev0649)
# Rotate Proton VPN to a different US WireGuard server.
#
# Drop a folder of Proton "WireGuard configuration" .conf files (US servers) into
#   M:\jjj\vpn-configs\
# then run vpn-rotate.bat after every batch of downloads. Each run tears down the
# current tunnel and brings up a different one, giving the downloader a fresh IP.
#
# Modes:
#   -Mode random   pick a random config, never one that was used RECENTLY (default)
#   -Mode cycle    walk the folder in sorted order, one server per run
#
# (dev0797) "random" used to exclude only the config used LAST, so with 18 servers a
# grind could land back on the exit it had just left after a single rotation — which is
# exactly the exit IG most recently saw traffic from (and, when a batch walls, the one
# that walled). It now keeps a recency list in state.json and excludes the last
# COUNT/2 servers used, so an exit gets ~9 rotations of rest before it can come round
# again. If the folder shrinks (or so many are excluded that nothing is left) the
# window narrows automatically rather than failing to pick.
#
# The .conf files hold PRIVATE KEYS -> vpn-configs\ is gitignored, never committed.

param(
    [ValidateSet('random','cycle')]
    [string]$Mode = 'random',
    [switch]$Stop      # tear down proton_active and hand control back to the Proton tray app
)

$ErrorActionPreference = 'Stop'
# PS 7.3+ turns a nonzero native exit into a terminating error under Stop; keep it off.
$PSNativeCommandUseErrorActionPreference = $false

# --- self-elevate (installing/removing a tunnel service needs admin) ------------
$admin = ([Security.Principal.WindowsPrincipal]`
          [Security.Principal.WindowsIdentity]::GetCurrent()`
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    $relaunch = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"",'-Mode',$Mode)
    if ($Stop) { $relaunch += '-Stop' }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $relaunch
    exit
}

# --- paths ----------------------------------------------------------------------
$ConfigDir = Join-Path $PSScriptRoot 'vpn-configs'
$WorkDir   = Join-Path $env:LOCALAPPDATA 'ProtonVpnRotate'
$Staging   = Join-Path $WorkDir 'proton_active.conf'   # tunnel name = 'proton_active'
$StateFile = Join-Path $WorkDir 'state.json'
$LogFile   = Join-Path $WorkDir 'vpn-rotate.log'
$TunName   = 'proton_active'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

function Log($msg) {
    $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
    Add-Content -Path $LogFile -Value $line
    Write-Host $line
}

# Any terminating error now lands in the log instead of a silent exit-1 (this is
# how the dev0649 "switching then nothing" failure would have been visible).
trap {
    try { Log ('FATAL: ' + $_.Exception.Message) } catch {}
    Start-Sleep 4
    exit 1
}

# Run wireguard.exe capturing all output, WITHOUT letting native stderr / nonzero
# exit throw (Windows PowerShell 5.1 turns native stderr into a terminating error
# under $ErrorActionPreference='Stop'; that killed the swap before dev0650).
function Wg([string[]]$wgArgs) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $text = (& $wg @wgArgs 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $ErrorActionPreference = $old
    return [pscustomobject]@{ code = $code; out = ($text -replace '\s+', ' ').Trim() }
}

# --- locate wireguard.exe -------------------------------------------------------
$wg = @(
    (Join-Path $env:ProgramFiles        'WireGuard\wireguard.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'WireGuard\wireguard.exe'),
    (Join-Path $env:LOCALAPPDATA        'WireGuard\wireguard.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $wg) {
    $cmd = Get-Command wireguard.exe -ErrorAction SilentlyContinue
    if ($cmd) { $wg = $cmd.Source }
}
if (-not $wg) {
    Log 'ERROR: wireguard.exe not found. Install WireGuard from https://www.wireguard.com/install/'
    Start-Sleep 4; exit 1
}

# --- read the previous state ONCE (last choice + recency list) -------------------
# Read before -Stop so a Drop-VPN doesn't erase the recency list: the servers used in
# the last hour are still the recently-used ones when the next rotation happens.
$prevState = $null
if (Test-Path $StateFile) {
    try { $prevState = Get-Content $StateFile -Raw | ConvertFrom-Json } catch {}
}
$lastName = if ($prevState) { $prevState.lastFile } else { $null }
# (dev0799) An exit REQUESTED by the app (proxy.js writes next.json, biased by the
# measured per-exit speed ledger in ig_media\vpn-speed.json). It comes through a file
# rather than a parameter because the switch is fired with `schtasks /run`, whose
# arguments are fixed when the task is registered — that is what keeps rotation
# UAC-free. One-shot: consumed and deleted here, so a stale request can never pin the
# grind to one exit, and this script's own recency-aware random still runs whenever
# no request is waiting.
$NextFile  = Join-Path $WorkDir 'next.json'
$requested = $null
if (Test-Path $NextFile) {
    try { $requested = (Get-Content $NextFile -Raw | ConvertFrom-Json).server } catch {}
    Remove-Item $NextFile -Force -ErrorAction SilentlyContinue
}
$recent   = @()
if ($prevState -and $prevState.recent) { $recent = @($prevState.recent | Where-Object { $_ }) }
# Older state.json files predate `recent` — seed it from lastFile so the very first
# run after this upgrade still refuses the exit it is sitting on.
if ($recent.Count -eq 0 -and $lastName) { $recent = @($lastName) }
$RECENT_KEEP = 40   # how much history state.json carries (the window is a slice of it)

# --- -Stop: tear down the tunnel and hand control back to the Proton tray --------
if ($Stop) {
    $r = Wg @('/uninstalltunnelservice', $TunName)
    @{ lastFile = ''; at = (Get-Date -Format o); ip = $null; city = ''; country = ''; ok = $false; stopped = $true; recent = $recent } |
        ConvertTo-Json | Set-Content -Path $StateFile
    Log ("STOPPED  proton_active removed (exit {0}). The Proton tray app now controls the VPN." -f $r.code)
    exit 0
}

# --- gather configs -------------------------------------------------------------
$configs = @(Get-ChildItem -Path $ConfigDir -Filter '*.conf' -File -ErrorAction SilentlyContinue |
             Sort-Object Name)
if ($configs.Count -eq 0) {
    Log "ERROR: no .conf files in $ConfigDir"
    Log '       Proton dashboard -> Downloads -> WireGuard configuration -> pick US servers ->'
    Log '       save each .conf into that folder, then run again.'
    Start-Sleep 5; exit 1
}

# --- choose the next config -----------------------------------------------------
$skipped = 0
$askedFor = $null
if ($requested) { $askedFor = @($configs | Where-Object { $_.Name -eq $requested }) | Select-Object -First 1 }
if ($askedFor) {
    $chosen = $askedFor
    Log ("app requested -> {0}   (speed-ranked pick; {1} US servers available)" -f $chosen.Name, $configs.Count)
}
elseif ($Mode -eq 'cycle') {
    $idx = 0
    if ($lastName) {
        $prev = [Array]::IndexOf(($configs.Name), $lastName)
        if ($prev -ge 0) { $idx = ($prev + 1) % $configs.Count }
    }
    $chosen = $configs[$idx]
}
else {
    # random, refusing anything used recently. Start with half the folder excluded and
    # narrow the window until something survives, so a shrunken/renamed config folder
    # degrades to "avoid the last one" and finally to "anything" instead of crashing.
    $window = [math]::Min($recent.Count, [math]::Min($configs.Count - 1, [math]::Floor($configs.Count / 2)))
    $pool = @()
    while ($window -gt 0) {
        $avoid = @($recent | Select-Object -First $window)
        $pool  = @($configs | Where-Object { $avoid -notcontains $_.Name })
        if ($pool.Count -gt 0) { break }
        $window--
    }
    if ($pool.Count -eq 0) { $pool = $configs; $window = 0 }
    $skipped = $window
    $chosen = $pool | Get-Random
}

if (-not $askedFor) {
    Log ("switching -> {0}   (mode={1}, {2} US servers available{3})" -f $chosen.Name, $Mode, $configs.Count,
         $(if ($skipped) { ", {0} recently-used excluded, {1} eligible" -f $skipped, $pool.Count } else { '' }))
}

# Always write state.json at the end of EVERY run (success or fail) with a fresh
# `at` and an `ok` flag, so the proxy/I-screen see the result immediately instead
# of waiting out the switch timeout. `ok:$false` leaves no proton_active adapter,
# so the UI reads it as VPN OFF and the downloader retries/stops.
# `recent` is written on FAILURE too: a server that wouldn't hand shake is the last
# thing we want offered again on the very next rotation.
function WriteState([bool]$ok, $ip, $city, $country) {
    $hist = @($chosen.Name) + @($recent | Where-Object { $_ -ne $chosen.Name })
    $hist = @($hist | Select-Object -First $RECENT_KEEP)
    @{ lastFile = $chosen.Name; at = (Get-Date -Format o); ip = $ip; city = $city; country = $country; ok = $ok; recent = $hist } |
        ConvertTo-Json | Set-Content -Path $StateFile
}

# --- swap the tunnel ------------------------------------------------------------
# Always stage the chosen config under one fixed name so the tunnel name is stable
# and the original filenames (which may be long or have odd characters) never matter.
$u = Wg @('/uninstalltunnelservice', $TunName)   # fine to fail — tunnel may not exist yet
if ($u.code -ne 0) { Log ("(uninstall old tunnel: exit {0}{1})" -f $u.code, $(if($u.out){' - '+$u.out}else{''})) }
Start-Sleep -Seconds 2

# Baseline (home) IP captured while NO tunnel is up — the truth-check below needs
# it: a server whose tunnel doesn't really route leaves us on this exact IP.
$homeIp = $null
try { $homeIp = (Invoke-RestMethod 'https://ipinfo.io/json' -TimeoutSec 6).ip } catch {}
Log ("baseline (no-tunnel) IP: {0}" -f $(if($homeIp){$homeIp}else{'(unknown)'}))

Copy-Item -LiteralPath $chosen.FullName -Destination $Staging -Force
$i = Wg @('/installtunnelservice', $Staging)
if ($i.code -ne 0) {
    Log ("ERROR: installtunnelservice failed (exit {0}): {1}" -f $i.code, $i.out)
    WriteState $false $null '' ''; Start-Sleep 3; exit 1
}
Log ("tunnel service installed{0}" -f $(if($i.out){' - '+$i.out}else{''}))

# --- VERIFY the tunnel actually routes (dev0651) --------------------------------
# 1) the proton_active interface must get its 10.2.x WireGuard address.
$ifUp = $false
foreach ($t in 1..12) {
    Start-Sleep -Milliseconds 800
    if (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $TunName -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -like '10.2.*' }) { $ifUp = $true; break }
}
if (-not $ifUp) {
    Log ("FAIL: {0} never brought the tunnel interface up (server dead/full?). Removing it." -f $chosen.Name)
    Wg @('/uninstalltunnelservice', $TunName) | Out-Null
    WriteState $false $null '' ''; Start-Sleep 2; exit 2
}

# 2) traffic must actually EXIT via the tunnel — the public IP has to change away
#    from the home baseline. A dead free server leaves us on the home IP (this is
#    exactly the wg-US-FREE-40 failure). Retry to allow the handshake to complete.
$ip = $null; $city = ''; $country = ''; $org = ''
foreach ($try in 1..8) {
    Start-Sleep 2
    try {
        $r = Invoke-RestMethod -Uri 'https://ipinfo.io/json' -TimeoutSec 6
        if ($r.ip) { $ip = $r.ip; $city = $r.city; $country = $r.country; $org = $r.org
            if (-not $homeIp -or $ip -ne $homeIp) { break } }
    } catch {}
}
if (-not $ip -or ($homeIp -and $ip -eq $homeIp)) {
    Log ("FAIL: {0} up but traffic still exits the home IP {1} (handshake failed). Removing it." -f $chosen.Name, $(if($ip){$ip}else{'(no internet)'}))
    Wg @('/uninstalltunnelservice', $TunName) | Out-Null
    WriteState $false $ip $city $country; Start-Sleep 2; exit 3
}

WriteState $true $ip $city $country
$where = @($city, $country | Where-Object { $_ }) -join ', '
Log ("CONNECTED  {0}   public IP {1}  ({2})  [{3}]" -f $chosen.Name, $ip, $where, $org)
