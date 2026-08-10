<#
.SYNOPSIS
  Clean up video shot by pointing a camera at a screen: remove the screen-door
  pixel grid, steady the handheld shake, and cut it to a delivery size.

.DESCRIPTION
  Three stages, so the expensive one only runs once:

    1. crop the black bars -> de-screen -> scale        (slow; writes an intermediate)
    2. vidstabdetect on the intermediate                (fast)
    3. vidstabtransform -> sharpen -> pad -> encode     (fast)

  Re-running with -Reuse skips stage 1, so stabilisation and sharpening can be
  re-tried in seconds.

  The de-screen is a radial low-pass sitting in the gap between the real picture
  and the grid. A screen cannot show detail finer than one cycle per two of its
  own pixels, so everything above that in the capture is grid, not picture --
  which is why "medium" removes the grid by ~60 dB while leaving the real detail
  measurably untouched. Get the pitch numbers from measure-grid.py.

  As the camera zooms, the screen's pixels grow in the frame and the grid moves
  down in frequency, so the cutoff has to track it. fftfilt's eval=frame does
  that but re-runs the expression for every one of ~50M FFT bins on every frame
  (~0.005x realtime at 4K), so stage 1 instead cuts the clip into chunks short
  enough that the pitch is constant within one, and uses eval=init in each.

.EXAMPLE
  .\enhance-capture.ps1 -InputFile "M:\clip.mp4" -Crop 3316:2160:262:0 -PitchAt0 5.3028 -PitchPerSec 0.192096

.EXAMPLE
  .\enhance-capture.ps1 -InputFile "M:\clip.mp4" -Start 18 -Duration 6 -Stabilize strong -Reuse
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][Alias('i')][string]$InputFile,
    [Alias('o')][string]$OutputFile,

    # "w:h:x:y". Omit to let cropdetect find the black bars.
    [string]$Crop,

    # Screen-pixel pitch model from measure-grid.py: pitch(t) = PitchAt0 + PitchPerSec*t
    [double]$PitchAt0 = 0,
    [double]$PitchPerSec = 0,

    [ValidateSet('off', 'light', 'medium', 'strong', 'max')][string]$Descreen = 'medium',
    [ValidateSet('off', 'light', 'medium', 'strong')][string]$Stabilize = 'medium',
    [ValidateSet('off', 'light', 'medium')][string]$Sharpen = 'light',

    [int]$Height = 1080,
    # native = active area only; pad = 16:9 with the original side bars; fill = crop to 16:9
    [ValidateSet('native', 'pad', 'fill')][string]$Framing = 'pad',

    [ValidateSet('h264', 'hevc')][string]$Codec = 'h264',
    [int]$Crf = 18,
    [string]$Preset = 'slow',

    [double]$Start = 0,
    [double]$Duration = 0,

    # How far the pitch may drift inside one stage-1 chunk. The filter tolerates
    # ~10% before the grid creeps back; 0.06 leaves room for the fit's own error.
    [double]$MaxPitchDrift = 0.06,

    [switch]$Reuse,             # keep and re-use the stage-1 intermediate
    [switch]$KeepIntermediate,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Passband / stopband edges, in units of 1/pitch.
# Real picture stops at 0.5/pitch; the grid sits at 1.0/pitch.
$descreenBands = @{
    light  = @(0.70, 1.00)   # nulls the grid exactly, ~-35 dB in practice
    medium = @(0.58, 0.88)   # -60 dB, still entirely above real detail
    strong = @(0.44, 0.70)   # also bites into grid/sensor beat patterns
    max    = @(0.32, 0.52)   # cuts below the screen's own Nyquist: visibly soft
}
$stabPresets = @{
    light  = @{ detect = 'shakiness=6:accuracy=12:stepsize=6';  smooth = 8;  zoom = 0 }
    medium = @{ detect = 'shakiness=8:accuracy=15:stepsize=6';  smooth = 16; zoom = 0 }
    strong = @{ detect = 'shakiness=10:accuracy=15:stepsize=4'; smooth = 32; zoom = 1 }
}
$sharpenFilters = @{
    light  = 'unsharp=5:5:0.5:5:5:0.0'
    medium = 'unsharp=7:7:0.9:5:5:0.0'
}

$inv = [Globalization.CultureInfo]::InvariantCulture
function Fmt([double]$v, [string]$f = '0.######') { $v.ToString($f, $inv) }

function Resolve-Tool([string]$name) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $c) { throw "$name not found on PATH" }
    return $c.Source
}
$ffmpeg = Resolve-Tool ffmpeg
$ffprobe = Resolve-Tool ffprobe

function Invoke-FFmpeg([string[]]$FFArgs, [string]$Label) {
    if ($Label) { Write-Host "  $Label" -ForegroundColor DarkGray }
    if ($DryRun) { Write-Host "    ffmpeg $($FFArgs -join ' ')" -ForegroundColor DarkYellow; return }
    & $ffmpeg @FFArgs
    if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
}

function Get-EvenInt([double]$v) { [int]([math]::Round($v / 2) * 2) }

# ---------------------------------------------------------------- probe input
$InputFile = (Resolve-Path -LiteralPath $InputFile).Path
$probeJson = & $ffprobe -v error -select_streams v:0 -show_streams -show_format -of json $InputFile | ConvertFrom-Json
$vs = $probeJson.streams[0]
$srcW = [int]$vs.width
$srcH = [int]$vs.height
$fpsParts = ($vs.r_frame_rate -split '/')
$fps = [double]$fpsParts[0] / [double]$fpsParts[1]
$srcDur = [double]$probeJson.format.duration
$sar = if ($vs.sample_aspect_ratio -and $vs.sample_aspect_ratio -match '^\d+:\d+$') { $vs.sample_aspect_ratio } else { '1:1' }
$sarN, $sarD = ($sar -split ':') | ForEach-Object { [double]$_ }
if ($sarN -le 0 -or $sarD -le 0) { $sarN = 1; $sarD = 1 }

Write-Host "source     ${srcW}x${srcH} $($vs.codec_name) $(Fmt $fps '0.###') fps  $(Fmt $srcDur '0.##')s  SAR $sar" -ForegroundColor Cyan

# ------------------------------------------------------------------- geometry
if (-not $Crop) {
    Write-Host "cropdetect running..." -ForegroundColor DarkGray
    $probeStart = [math]::Min(2.0, $srcDur / 10)
    $cdOut = & $ffmpeg -v info -ss $probeStart -t 20 -i $InputFile -vf 'cropdetect=limit=24:round=2' -f null - 2>&1
    $votes = @{}
    foreach ($line in $cdOut) {
        if ("$line" -match 'crop=(\d+:\d+:\d+:\d+)') { $votes[$Matches[1]] = 1 + ($votes[$Matches[1]] ?? 0) }
    }
    $Crop = if ($votes.Count) { ($votes.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key }
            else { "${srcW}:${srcH}:0:0" }
}
$cw, $ch, $cx, $cy = ($Crop -split ':') | ForEach-Object { [int]$_ }
# 4:2:0 chroma cannot land on an odd edge, and ffmpeg's crop filter silently
# rounds down to suit. Do it here instead so the geometry printed and the
# geometry rendered are the same number.
$cwOdd, $chOdd = $cw, $ch
$cw -= $cw % 2
$ch -= $ch % 2
Write-Host "crop       ${cw}:${ch}:${cx}:${cy}$(if ($cw -ne $cwOdd -or $ch -ne $chOdd) { "   (from ${cwOdd}x${chOdd} — rounded to even for 4:2:0)" })" -ForegroundColor Cyan

# Width the active area should have once pixels are square.
$displayW = $cw * $sarN / $sarD
$noScale = ($Height -le 0)          # -Height 0 = keep the crop's own pixels

if ($noScale) {
    # Native mode: no resampling at all beyond what the stabiliser's warp does.
    # Square-pixel sources pass through untouched; a non-square SAR still has to
    # be corrected, or the output would come out geometrically wrong.
    $stage1W = if ($sarN -eq $sarD) { $cw } else { Get-EvenInt $displayW }
    $stage1H = $ch
    $padTo = $null
    $Framing = 'native'
    $finalW = $stage1W
    Write-Host "output     ${stage1W}x${stage1H}  (native — no downscale)" -ForegroundColor Cyan
}
else {
    $activeW = Get-EvenInt ($Height * $displayW / $ch)
    $boxW = Get-EvenInt ($Height * 16 / 9)
    switch ($Framing) {
        'native' { $stage1W = $activeW; $stage1H = $Height; $padTo = $null }
        'pad'    { $stage1W = $activeW; $stage1H = $Height
                   $padTo = if ($boxW -gt $activeW) { @($boxW, $Height) } else { $null } }
        'fill'   { $stage1W = $boxW; $stage1H = Get-EvenInt ($boxW * $ch / $displayW); $padTo = $null }
    }
    $finalW = if ($padTo) { $padTo[0] } elseif ($Framing -eq 'fill') { $boxW } else { $stage1W }
    Write-Host "output     ${finalW}x${Height}  ($Framing)" -ForegroundColor Cyan
}

# ------------------------------------------------------------------ filenames
if (-not $OutputFile) {
    $dir = Split-Path -Parent $InputFile
    $base = [IO.Path]::GetFileNameWithoutExtension($InputFile)
    $tag = "$(if ($noScale) { 'native' } else { "${Height}p" }) ds-$Descreen st-$Stabilize"
    if ($Duration -gt 0) { $tag = "preview $tag" }
    $OutputFile = Join-Path $dir "$base [$tag].mp4"
}
$outDir = [IO.Path]::GetDirectoryName($OutputFile)
if (-not $outDir) { $outDir = (Get-Location).Path; $OutputFile = Join-Path $outDir $OutputFile }
# Keyed off the INPUT, not the output, so -Reuse still finds the intermediate
# when the same source is re-rendered to a different file.
$work = Join-Path (Split-Path -Parent $InputFile) '.enhance-work'
if (-not (Test-Path $work)) { New-Item -ItemType Directory -Path $work | Out-Null }
$stamp = '{0}_{1}_{2}_{3}' -f ([IO.Path]::GetFileNameWithoutExtension($InputFile) -replace '\W', ''), $Descreen,
         $(if ($noScale) { 'native' } else { $Height }), $Framing
if ($Duration -gt 0) { $stamp += "_s$(Fmt $Start)_d$(Fmt $Duration)" }
$interFile = Join-Path $work "$stamp.mp4"
# vidstab's result=/input= value sits inside a filtergraph, where ':' separates
# options -- neither escaping nor quoting a drive letter survives the parser, so
# the vidstab passes are run from $work and refer to the file by bare name.
$trfName = "$stamp.trf"
$trfFile = Join-Path $work $trfName

# ------------------------------------------------- stage 1: de-screen + scale
$startFrame = [int][math]::Round($Start * $fps)
$totalFrames = [int][math]::Round($srcDur * $fps)
$wantFrames = if ($Duration -gt 0) { [int][math]::Round($Duration * $fps) } else { $totalFrames - $startFrame }
$wantFrames = [math]::Max(1, [math]::Min($wantFrames, $totalFrames - $startFrame))

if ($Descreen -ne 'off' -and $PitchAt0 -le 0) {
    throw "-Descreen $Descreen needs -PitchAt0 (and usually -PitchPerSec). Run measure-grid.py first, or pass -Descreen off."
}

# Everything stage 1 does to a frame, split so the de-screen can be inserted
# between the crop and the scale. In native mode stage1W/H equal the crop, so no
# scale filter is emitted at all (a non-square SAR still forces one, or the
# output would come out geometrically wrong).
$cropFilter = "crop=${cw}:${ch}:${cx}:${cy}"
$tail = @()
if ($stage1W -ne $cw -or $stage1H -ne $ch) { $tail += "scale=${stage1W}:${stage1H}:flags=lanczos" }
if ($Framing -eq 'fill') { $tail += "crop=${boxW}:${Height}" }
$tail += 'setsar=1'
$preChain = @($cropFilter) + $tail

# The intermediate exists only so the SLOW de-screen pass isn't repeated. With
# -Descreen off stage 1 is just a crop, so stages 2 and 3 read the source
# directly instead: faster, and one encode generation cleaner. -Reuse and
# -KeepIntermediate force the cached path for quick stabiliser re-tries.
$useIntermediate = ($Descreen -ne 'off') -or $Reuse -or $KeepIntermediate

if (-not $useIntermediate) {
    Write-Host "stage 1    skipped — no de-screen, rendering straight from the source" -ForegroundColor DarkGray
}
elseif ($Reuse -and (Test-Path $interFile)) {
    Write-Host "stage 1    reusing $([IO.Path]::GetFileName($interFile))" -ForegroundColor Yellow
}
else {
    # Split into chunks short enough that the pitch barely moves inside one.
    # Solving P(end) <= (1+d)*P(mid) for the chunk length gives the bound below.
    $chunks = @()
    $f = $startFrame
    $endFrame = $startFrame + $wantFrames
    while ($f -lt $endFrame) {
        $n = $endFrame - $f
        if ($Descreen -ne 'off' -and $PitchPerSec -gt 0) {
            $pStart = $PitchAt0 + $PitchPerSec * ($f / $fps)
            $lenSec = 2 * $MaxPitchDrift * $pStart / ($PitchPerSec * (1 - $MaxPitchDrift))
            $n = [math]::Max(1, [math]::Min($n, [int][math]::Round($lenSec * $fps)))
        }
        $chunks += , @($f, $n)
        $f += $n
    }

    if ($Descreen -ne 'off') {
        $a, $b = $descreenBands[$Descreen]
        $pEnd = $PitchAt0 + $PitchPerSec * (($endFrame - 1) / $fps)
        $pBeg = $PitchAt0 + $PitchPerSec * ($startFrame / $fps)
        Write-Host ("de-screen  {0}  pass {1}/pitch, stop {2}/pitch;  pitch {3} -> {4} px over {5} chunk(s)" -f `
            $Descreen, $a, $b, (Fmt $pBeg '0.##'), (Fmt $pEnd '0.##'), $chunks.Count) -ForegroundColor Cyan
    }

    Write-Host "stage 1    de-screen + scale" -ForegroundColor DarkGray
    $chunkFiles = @()
    $ci = 0
    foreach ($c in $chunks) {
        $f0, $n = $c
        $ci++
        $chunkPath = Join-Path $work ("{0}_c{1:d3}.mp4" -f $stamp, $ci)
        $chunkFiles += $chunkPath

        $chain = @($cropFilter)
        if ($Descreen -ne 'off') {
            $a, $b = $descreenBands[$Descreen]
            $span = Fmt ($b - $a)
            $pMid = $PitchAt0 + $PitchPerSec * (($f0 + $n / 2.0) / $fps)
            # fftfilt indexes the spectrum so frequency = X/(2*WS) cycles/px, holding
            # only positive frequencies. clip() saturates the Hann taper at both ends,
            # so the weight is flat 1 below the passband and flat 0 above the stopband.
            $freq = 'hypot(X/(2*WS),Y/(2*HS))'
            $wy = "0.5*(1+cos(PI*clip(($freq*$(Fmt $pMid)-$a)/$span,0,1)))"
            $wc = "0.5*(1+cos(PI*clip(($freq*$(Fmt ($pMid / 2))-$a)/$span,0,1)))"   # 4:2:0 chroma: half the pitch
            $chain += "fftfilt=weight_Y='$wy':weight_U='$wc':weight_V='$wc'"
        }
        $chain += $tail

        Invoke-FFmpeg @('-hide_banner', '-v', 'warning', '-stats', '-y',
            '-ss', (Fmt ($f0 / $fps) '0.########'), '-i', $InputFile,
            '-frames:v', "$n", '-an', '-vf', ($chain -join ','),
            '-c:v', 'libx264', '-crf', '12', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
            $chunkPath) ("chunk {0}/{1}  frames {2}-{3}" -f $ci, $chunks.Count, $f0, ($f0 + $n - 1))
    }

    if ($chunkFiles.Count -eq 1) {
        if (-not $DryRun) { Move-Item -LiteralPath $chunkFiles[0] -Destination $interFile -Force }
    }
    else {
        $listFile = Join-Path $work "$stamp.concat.txt"
        ($chunkFiles | ForEach-Object { "file '$($_ -replace "'", "'\''")'" }) |
            Set-Content -LiteralPath $listFile -Encoding utf8
        Invoke-FFmpeg @('-hide_banner', '-v', 'warning', '-y', '-f', 'concat', '-safe', '0',
            '-i', $listFile, '-c', 'copy', $interFile) 'joining chunks'
        if (-not $DryRun) {
            Remove-Item -LiteralPath $listFile -ErrorAction SilentlyContinue
            $chunkFiles | ForEach-Object { Remove-Item -LiteralPath $_ -ErrorAction SilentlyContinue }
        }
    }
}

# ------------------------------------------------------- stages 2/3: stabilise
# Reading the intermediate means the crop/scale is already baked in; reading the
# source means every pass has to re-apply it first.
$seek = @()
if ($Start -gt 0) { $seek += @('-ss', (Fmt $Start)) }
if ($Duration -gt 0) { $seek += @('-t', (Fmt $Duration)) }
$videoIn = if ($useIntermediate) { @('-i', $interFile) } else { $seek + @('-i', $InputFile) }
$lead = if ($useIntermediate) { @() } else { $preChain }

$post = @()
if ($Stabilize -ne 'off') {
    $sp = $stabPresets[$Stabilize]
    Push-Location $work        # vidstab can only take a bare .trf filename
    try {
        Invoke-FFmpeg (@('-hide_banner', '-v', 'warning', '-stats', '-y') + $videoIn +
            @('-vf', ((@($lead) + "vidstabdetect=$($sp.detect):result=$trfName") -join ','),
              '-f', 'null', '-')) "stage 2    analysing motion ($Stabilize)"
    }
    finally { Pop-Location }
    $post += "vidstabtransform=input=$trfName" +
             ":smoothing=$($sp.smooth):optzoom=1:zoom=$($sp.zoom):maxangle=-1:crop=black:interpol=bicubic"
}
if ($Sharpen -ne 'off') { $post += $sharpenFilters[$Sharpen] }
if ($padTo) { $post += "pad=$($padTo[0]):$($padTo[1]):(ow-iw)/2:(oh-ih)/2:black" }
$post += 'setsar=1'

# Audio is always copied from the source. When the video also comes from the
# source that is one input and one map; otherwise the source joins as input 1.
$encoder = if ($Codec -eq 'hevc') { @('-c:v', 'libx265', '-tag:v', 'hvc1') } else { @('-c:v', 'libx264') }
$inputs = if ($useIntermediate) { $videoIn + $seek + @('-i', $InputFile) } else { $videoIn }
$maps = if ($useIntermediate) { @('-map', '0:v:0', '-map', '1:a:0?') } else { @('-map', '0:v:0', '-map', '0:a:0?') }

Push-Location $work
try {
    Invoke-FFmpeg (@('-hide_banner', '-v', 'warning', '-stats', '-y') + $inputs + $maps +
        @('-vf', ((@($lead) + $post) -join ','))  + $encoder +
        @('-crf', "$Crf", '-preset', $Preset, '-pix_fmt', 'yuv420p',
          '-c:a', 'copy', '-shortest', '-movflags', '+faststart', $OutputFile)) `
        'stage 3    stabilise + sharpen + encode'
}
finally { Pop-Location }

if (-not ($KeepIntermediate -or $Reuse -or $DryRun)) {
    Remove-Item -LiteralPath $interFile, $trfFile -ErrorAction SilentlyContinue
    if (-not (Get-ChildItem -LiteralPath $work -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $work -ErrorAction SilentlyContinue
    }
}

if (-not $DryRun) {
    $mb = [math]::Round((Get-Item -LiteralPath $OutputFile).Length / 1MB, 1)
    Write-Host "`ndone       $OutputFile  (${mb} MB)" -ForegroundColor Green
}
