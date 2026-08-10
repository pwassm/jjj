#!/usr/bin/env python3
"""
measure-grid.py -- characterise a video that was shot by pointing a camera at a
screen (monitor / tablet / TV), so the screen-door pixel grid can be filtered out.

It reports three things:

  1. the crop rectangle, if the capture is pillar/letterboxed
  2. the screen-door pitch (px between the screen's own pixels, as imaged) and
     how it drifts over the clip -- it changes whenever the camera zooms or the
     distance to the screen changes
  3. a ready-to-paste ffmpeg `fftfilt` expression, plus the numbers that
     enhance-capture.ps1 wants

Why the pitch matters
---------------------
The screen can only show detail down to its own Nyquist limit: one cycle per two
screen pixels.  Imaged, that is a period of 2*pitch.  So EVERY spatial frequency
above 1/(2*pitch) in the capture is screen-door, sensor noise or moire -- never
real picture.  That leaves a clear window between 1/(2*pitch) and 1/pitch where a
low-pass removes the grid completely and costs nothing at all.

Usage
-----
  python measure-grid.py "M:\\path\\clip.mp4"
  python measure-grid.py clip.mp4 --json out.json --samples 60 --no-crop-detect
"""

import argparse
import json
import shutil
import subprocess
import sys

import numpy as np

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

# Grid periods we are willing to believe, in captured pixels.
MIN_PITCH = 3.0
MAX_PITCH = 40.0
# A peak must stand this far above the local spectral median to count as a grid.
MIN_PEAK_RATIO = 30.0


def probe(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_streams",
         "-show_format", "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    st = j["streams"][0]
    dur = float(st.get("duration") or j["format"]["duration"])
    num, den = (st.get("r_frame_rate") or "30/1").split("/")
    sar = st.get("sample_aspect_ratio") or "1:1"
    sn, sd = (int(v) for v in sar.split(":")) if ":" in sar else (1, 1)
    if sn <= 0 or sd <= 0:
        sn = sd = 1
    return {
        "width": int(st["width"]), "height": int(st["height"]),
        "fps": float(num) / float(den), "duration": dur,
        "sar_num": sn, "sar_den": sd,
        "codec": st.get("codec_name", "?"),
    }


def detect_crop(path, info, probe_seconds=20.0):
    """Find static black bars. Returns (w, h, x, y)."""
    start = min(2.0, info["duration"] / 10)
    res = subprocess.run(
        [FFMPEG, "-v", "info", "-ss", str(start), "-t", str(probe_seconds),
         "-i", path, "-vf", "cropdetect=limit=24:round=2", "-f", "null", "-"],
        capture_output=True, text=True).stderr
    votes = {}
    for line in res.splitlines():
        k = line.rfind("crop=")
        if k < 0:
            continue
        val = line[k + 5:].split()[0]
        votes[val] = votes.get(val, 0) + 1
    if not votes:
        return info["width"], info["height"], 0, 0
    best = max(votes, key=votes.get)
    try:
        w, h, x, y = (int(v) for v in best.split(":"))
    except ValueError:
        return info["width"], info["height"], 0, 0
    # Ignore a "crop" that shaves off only a sliver -- that is usually just
    # edge noise, not a real bar.
    if w > info["width"] * 0.97 and h > info["height"] * 0.97:
        return info["width"], info["height"], 0, 0
    return w, h, x, y


def sample_patches(path, crop, n_samples, patch, duration):
    """Decode `n_samples` grey patches from the centre of the cropped frame."""
    cw, ch, cx, cy = crop
    patch = min(patch, cw, ch)
    px = cx + (cw - patch) // 2
    py = cy + (ch - patch) // 2
    fps = max(n_samples / duration, 1e-6)
    vf = f"fps={fps:.6f},crop={patch}:{patch}:{px}:{py},format=gray"
    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-i", path, "-vf", vf,
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True).stdout
    n = len(raw) // (patch * patch)
    if n == 0:
        raise SystemExit("could not decode any frames -- check the input path")
    frames = np.frombuffer(raw, np.uint8)[:n * patch * patch]
    return frames.reshape(n, patch, patch).astype(np.float64), 1.0 / fps


def grid_peak(img):
    """Strongest near-axis periodic component. Returns (pitch, angle, ratio) x2."""
    n = img.shape[0]
    win = np.hanning(n)[:, None] * np.hanning(n)[None, :]
    spec = np.fft.fftshift(np.abs(np.fft.fft2((img - img.mean()) * win)))
    c = n // 2
    med = np.median(spec)
    yy, xx = np.mgrid[0:n, 0:n]
    fx, fy = (xx - c) / n, (yy - c) / n
    r = np.hypot(fx, fy)
    band = (r > 1.0 / MAX_PITCH) & (r < 1.0 / MIN_PITCH)
    ang = np.degrees(np.arctan2(fy, fx))
    out = []
    for mask in (band & ((np.abs(ang) < 25) | (np.abs(ang) > 155)),   # vertical lines
                 band & (np.abs(np.abs(ang) - 90) < 25)):             # horizontal lines
        sel = np.where(mask, spec, 0.0)
        idx = np.unravel_index(np.argmax(sel), sel.shape)
        out.append((1.0 / r[idx], float(ang[idx]), float(sel[idx] / med)))
    return out


def fit_pitch(times, pitches):
    """Least-squares line through the pitch samples, with the outliers dropped."""
    t = np.asarray(times, float)
    p = np.asarray(pitches, float)
    keep = np.ones(len(t), bool)
    for _ in range(3):
        if keep.sum() < 3:
            break
        c = np.polyfit(t[keep], p[keep], 1)
        resid = np.abs(p - np.polyval(c, t))
        s = max(resid[keep].std(), 1e-6)
        new = resid < 3 * s
        if (new == keep).all():
            break
        keep = new
    c = np.polyfit(t[keep], p[keep], 1) if keep.sum() >= 2 else np.array([0.0, p.mean()])
    resid = p[keep] - np.polyval(c, t[keep])
    return float(c[1]), float(c[0]), float(np.abs(resid).max()), int(keep.sum())


PRESETS = {           # (passband edge, stopband edge), both in units of 1/pitch
    "light":  (0.70, 1.00),
    "medium": (0.58, 0.88),
    "strong": (0.44, 0.70),
    "max":    (0.32, 0.52),
}


def weight_expr(p0, p1, fps, a, b, chroma=False, frame_offset=0):
    """Hann-tapered radial low-pass whose cutoff tracks the drifting pitch.

    fftfilt indexes the spectrum so that frequency = X/(2*WS) cycles/px
    (verified empirically; the array holds only positive frequencies).
    clip() makes the taper saturate at 1 below the passband and 0 above the
    stopband, so no branching is needed.
    """
    half = "/2" if chroma else ""          # 4:2:0 chroma planes halve the pitch
    off = f"+{frame_offset}" if frame_offset else ""
    pitch = f"(({p0}+{p1}*(N{off})/{fps:g}){half})"
    freq = "hypot(X/(2*WS),Y/(2*HS))"
    return f"0.5*(1+cos(PI*clip(({freq}*{pitch}-{a})/({b - a:.6g}),0,1)))"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("--samples", type=int, default=40, help="frames to analyse (default 40)")
    ap.add_argument("--patch", type=int, default=1024, help="analysis patch size (default 1024)")
    ap.add_argument("--preset", default="medium", choices=sorted(PRESETS),
                    help="which strength to print the expression for")
    ap.add_argument("--no-crop-detect", action="store_true")
    ap.add_argument("--json", help="also write the findings to this file")
    ap.add_argument("--verbose", action="store_true", help="print every sample")
    args = ap.parse_args()

    info = probe(args.input)
    print(f"source   {info['width']}x{info['height']} {info['codec']} "
          f"{info['fps']:.3f} fps  {info['duration']:.2f}s  "
          f"SAR {info['sar_num']}:{info['sar_den']}")

    crop = ((info["width"], info["height"], 0, 0) if args.no_crop_detect
            else detect_crop(args.input, info))
    cw, ch, cx, cy = crop
    if (cw, ch) != (info["width"], info["height"]):
        print(f"crop     {cw}:{ch}:{cx}:{cy}   (black bars removed)")
    else:
        print("crop     none needed")

    frames, dt = sample_patches(args.input, crop, args.samples,
                                args.patch, info["duration"])
    times, pv, ph, weak = [], [], [], 0
    for i, f in enumerate(frames):
        (p_v, a_v, r_v), (p_h, a_h, r_h) = grid_peak(f)
        if r_v < MIN_PEAK_RATIO and r_h < MIN_PEAK_RATIO:
            weak += 1
            continue
        times.append(i * dt)
        pv.append(p_v)
        ph.append(p_h)
        if args.verbose:
            print(f"  t={i * dt:6.2f}s  V {p_v:6.2f}px @{a_v:+7.2f}deg (x{r_v:5.0f})"
                  f"   H {p_h:6.2f}px @{a_h:+7.2f}deg (x{r_h:5.0f})")

    if len(times) < 3:
        print("\nNo screen-door grid found. Either this is not a screen capture, "
              "or the grid is finer than the sensor resolved. Nothing to de-screen.")
        return 1

    # The finer of the two axes is the conservative choice: filtering to kill it
    # also kills the coarser one, and the coarser one is what actually caps the
    # real detail, so nothing is lost.
    pitch = np.minimum(pv, ph)
    p0, p1, err, used = fit_pitch(times, pitch)
    lo, hi = np.polyval([p1, p0], [0.0, info["duration"]])
    print(f"\ngrid     pitch(t) = {p0:.4f} + {p1:.6f} * t   px"
          f"   [{lo:.2f} -> {hi:.2f} px over the clip]")
    print(f"         fitted from {used}/{len(frames)} samples, max residual "
          f"{err:.2f}px" + (f", {weak} too weak to use" if weak else ""))
    if abs(p1) * info["duration"] > 0.15 * p0:
        print("         the pitch moves a lot -- the camera zooms, so a fixed "
              "blur cannot work; the filter below tracks it")

    px_start, px_end = cw / lo, cw / hi
    print(f"\nthe frame spans about {px_start:.0f} screen pixels at the start and "
          f"{px_end:.0f} at the end, so the")
    print(f"finest real detail has a period of {2 * lo:.1f}px (start) to {2 * hi:.1f}px "
          f"(end) in this {cw}px-wide capture.")
    print("Anything finer is screen-door, so a low-pass between the two removes the "
          "grid at no cost.")
    print(f"It also means {min(px_start, px_end):.0f} pixels across is all the real "
          "resolution there is -- a 1080p delivery")
    print("is already generous, and going higher only makes the file bigger.")

    a, b = PRESETS[args.preset]
    print(f"\nfftfilt expression ({args.preset}: pass to {a}/pitch, stop at {b}/pitch)")
    print("NB eval=frame re-runs this for every FFT bin on every frame and is far too "
          "slow at 4K;")
    print("enhance-capture.ps1 chunks the clip and uses eval=init instead.\n")
    for plane, chroma in (("Y", False), ("U", True), ("V", True)):
        print(f"  weight_{plane}='{weight_expr(p0, p1, info['fps'], a, b, chroma=chroma)}'")

    print("\nfor enhance-capture.ps1:")
    print(f"  -Crop '{cw}:{ch}:{cx}:{cy}' -PitchAt0 {p0:.4f} -PitchPerSec {p1:.6f}")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({
                "input": args.input, "source": info,
                "crop": {"w": cw, "h": ch, "x": cx, "y": cy},
                "pitch_at_0": p0, "pitch_per_sec": p1,
                "pitch_start": float(lo), "pitch_end": float(hi),
                "fit_max_residual_px": err, "samples_used": used,
            }, fh, indent=2)
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
