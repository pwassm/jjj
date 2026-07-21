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

# --- swap the tunnel ------------------------------------------------------------
# Always stage the chosen config under one fixed name so the tunnel name is stable
# and the original filenames (which may be long or have odd characters) never matter.
$u = Wg @('/uninstalltunnelservice', $TunName)   # fine to fail — tunnel may not exist yet
if ($u.code -ne 0) { Log ("(uninstall old tunnel: exit {0}{1})" -f $u.code, $(if($u.out){' - '+$u.out}else{''})) }
Start-Sleep -Milliseconds 1500
Copy-Item -LiteralPath $chosen.FullName -Destination $Staging -Force
$i = Wg @('/installtunnelservice', $Staging)
if ($i.code -ne 0) {
    Log ("ERROR: installtunnelservice failed (exit {0}): {1}" -f $i.code, $i.out)
    Start-Sleep 5; exit 1
}
Log ("tunnel service installed{0}" -f $(if($i.out){' - '+$i.out}else{''}))

# --- confirm the new public IP --------------------------------------------------
$ip = $null; $city = ''; $country = ''
foreach ($try in 1..6) {
    Start-Sleep 2
    try {
        $r = Invoke-RestMethod -Uri 'https://ipinfo.io/json' -TimeoutSec 6
        if ($r.ip) { $ip = $r.ip; $city = $r.city; $country = $r.country; break }
    } catch {
        try { $ip = (Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 6).ip; if ($ip) { break } } catch {}
    }
}

# Record the result LAST (single write). The I screen / proxy read this file and
# wait for `at` to change, so writing it only after the IP is known means the UI
# never shows a half-switched state. lastFile also drives -Mode cycle next run.
@{ lastFile = $chosen.Name; at = (Get-Date -Format o); ip = $ip; city = $city; country = $country } |
    ConvertTo-Json | Set-Content -Path $StateFile

$where = @($city, $country | Where-Object { $_ }) -join ', '
if ($ip) { Log ("CONNECTED  {0}   public IP {1}  ({2})" -f $chosen.Name, $ip, $where) }
else     { Log ("CONNECTED  {0}   (couldn't read public IP -- tunnel is up though)" -f $chosen.Name) }
