# vpn-rotate.ps1  (dev0649)
# Rotate Proton VPN to a different US WireGuard server.
#
# Drop a folder of Proton "WireGuard configuration" .conf files (US servers) into
#   M:\jjj\vpn-configs\
# then run vpn-rotate.bat after every batch of downloads. Each run tears down the
# current tunnel and brings up a different one, giving the downloader a fresh IP.
#
# Modes:
#   -Mode random   pick a random config, never the same one twice in a row (default)
#   -Mode cycle    walk the folder in sorted order, one server per run
#
# The .conf files hold PRIVATE KEYS -> vpn-configs\ is gitignored, never committed.

param(
    [ValidateSet('random','cycle')]
    [string]$Mode = 'random'
)

$ErrorActionPreference = 'Stop'
# PS 7.3+ turns a nonzero native exit into a terminating error under Stop; keep it off.
$PSNativeCommandUseErrorActionPreference = $false

# --- self-elevate (installing/removing a tunnel service needs admin) ------------
$admin = ([Security.Principal.WindowsPrincipal]`
          [Security.Principal.WindowsIdentity]::GetCurrent()`
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList @(
        '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"",'-Mode',$Mode
    )
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

# --- gather configs -------------------------------------------------------------
$configs = @(Get-ChildItem -Path $ConfigDir -Filter '*.conf' -File -ErrorAction SilentlyContinue |
             Sort-Object Name)
if ($configs.Count -eq 0) {
    Log "ERROR: no .conf files in $ConfigDir"
    Log '       Proton dashboard -> Downloads -> WireGuard configuration -> pick US servers ->'
    Log '       save each .conf into that folder, then run again.'
    Start-Sleep 5; exit 1
}

# --- read last choice -----------------------------------------------------------
$lastName = $null
if (Test-Path $StateFile) {
    try { $lastName = (Get-Content $StateFile -Raw | ConvertFrom-Json).lastFile } catch {}
}

# --- choose the next config -----------------------------------------------------
if ($Mode -eq 'cycle') {
    $idx = 0
    if ($lastName) {
        $prev = [Array]::IndexOf(($configs.Name), $lastName)
        if ($prev -ge 0) { $idx = ($prev + 1) % $configs.Count }
    }
    $chosen = $configs[$idx]
}
else {  # random, avoid an immediate repeat
    $pool = if ($configs.Count -gt 1 -and $lastName) {
        @($configs | Where-Object { $_.Name -ne $lastName })
    } else { $configs }
    $chosen = $pool | Get-Random
}

Log ("switching -> {0}   (mode={1}, {2} US servers available)" -f $chosen.Name, $Mode, $configs.Count)

# Always write state.json at the end of EVERY run (success or fail) with a fresh
# `at` and an `ok` flag, so the proxy/I-screen see the result immediately instead
# of waiting out the switch timeout. `ok:$false` leaves no proton_active adapter,
# so the UI reads it as VPN OFF and the downloader retries/stops.
function WriteState([bool]$ok, $ip, $city, $country) {
    @{ lastFile = $chosen.Name; at = (Get-Date -Format o); ip = $ip; city = $city; country = $country; ok = $ok } |
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
