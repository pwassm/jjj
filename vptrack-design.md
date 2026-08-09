# V crop overlay — tracking window + pillarbox bleed

**Status: built in dev0777, feature B revised in dev0778.** This document is the design as
implemented. Two things changed during the build — §4.5 (the features are independent) and
§4 itself (bars dropped in favour of the intersection). Both are marked.

Two additions to the `vp.js` crop overlay / `proxy.js` ffmpeg builder:

- **A. Tracking crop** — a crop window that moves during the clip, so a drifting subject
  stays framed. Defined by stamping the window over the subject at two (or more) points
  in time.
- **B. Reach past the edge** — let the crop rect be *wider than the source frame*, so a
  landscape crop of a portrait video can capture more vertical extent. **Only the part of
  the rect that is actually picture is rendered** — no black is ever encoded — which makes
  the gesture a continuous output-aspect dial rather than a bar generator.

Both land on the same pipeline change and share one new prefix filter, so they are
specified together.

---

## 1. Verified foundations

Everything below was measured against `ffmpeg 2026-04-09-git-d3d0b7a5ee` (the build the
proxy already spawns), not assumed. These four facts are what make the design work.

| # | Claim | Evidence |
|---|---|---|
| 1 | `crop`'s **x/y accept per-frame expressions** in `t` (only `w`/`h` are configure-time constants) | `crop=320:240:x='(t/5)*320':y='(t/5)*240'` vs static crops at the matching offsets: **49.0 dB** at mid-clip, **51.9 dB** at t=0. Control (moving frame vs the *wrong* static position): **2.4 dB**. |
| 2 | An expression crop **does not re-time the stream** | Source `640x480, 30/1, 150 frames` → output `320x240, 30/1, 150 frames`. Identical. |
| 3 | `-ss` before `-i` **rebases the filter clock to 0** | First frame of a `-ss 2.0 -to 4.0` render with `x='(t/2)*320'` vs source@2.0s cropped at x=0: **54.7 dB**. Track times are therefore clip-relative — same convention `drawtext` already uses. |
| 4 | `pad` → `crop` composes, and the bars are **exactly symmetric** | 480×640 source, `pad=854:640:187:0:black,crop=854:480:0:80`. Left bar (x 0–180) and right bar (x 674–854) both average `RGB(4,0,6)`; centre strip `RGB(121,133,128)`. |

Plus the piecewise interpolator itself, 3 keyframes with a ramp, a reversal and a
post-last hold, checked **frame-exactly** (`select=eq(n,N)`, not `-ss`, which lands
between frames at 30 fps):

| frame | t | expected x | PSNR |
|---|---|---|---|
| 15 | 0.500 | 100 | 53.5 dB |
| 45 | 1.500 | 300 (key) | 60.4 dB |
| 72 | 2.400 | 180 | 56.0 dB |
| 105 | 3.500 | 100 (held past last key) | 50.7 dB |

### Why this matters: tracking should **not** use `zoompan`

Ken Burns (dev0720) uses `zoompan` because it was the only stock filter that could move
the visible region per frame *while changing its size*. A constant-size pan does not need
that, and `crop`-with-expressions is strictly better for it:

|  | `zoompan` (Ken Burns) | `crop` expr (tracking) |
|---|---|---|
| Output frame rate | **zoompan sets it** → source rate must be ffprobe'd first, render refused if unknown | untouched (fact 2) → **no fps probe at all** |
| Resampling | rescales the window → output *every frame* | pure pixel copy; one `scale` at the end |
| Time reference | frame index `on`, so times must be converted via fps | `t` in seconds directly |
| Failure mode | ramp length wrong if the probe lies | none of that machinery exists |

So: **tracking = constant-size window = `crop` expressions.** Zoom stays with `Z`/Ken
Burns. The two compose (§4) but are separate tools.

---

## 2. Pipeline

Current:

```
[rotate=…:c=black,]  crop=w:h:x:y  [,zoompan | ,scale]  [,pause chain]  [,drawtext…]
```

After:

```
[rotate=…:c=black, | pad=ow:oh:px:py:black,]  crop=w:h:x='X(t)':y='Y(t)'  [,zoompan | ,scale]  [,pause chain]  [,drawtext…]
```

Two edits only: a new optional `pad` prefix (mutually exclusive with `rotate`, see §3.4),
and `crop`'s literal `x`/`y` becoming expressions when a track is present. Every existing
payload produces a byte-identical command line.

**Ordering note.** `crop` sits *before* the `tpad` pause chain, so track keyframe times are
read against the **un-lengthened** timeline. This is the opposite of caption times, which
`_vpTextRenderList` already maps onto the pause-lengthened timeline. Do not run track keys
through that mapping. (Behaviour is correct: a freeze holds a frame of the
already-tracked picture, so the framing sits still during the pause.)

---

## 3. Feature A — tracking crop window

### 3.1 Interaction

One rect, several stamped positions — *not* two boxes on screen at once. The rect the user
already knows how to drag becomes the tracking window:

1. Open the crop overlay (`C`), size the rect to the framing you want. This fixes the
   window **size** for the whole track.
2. Scrub to the start of the clip, drag the rect over the subject, press **`r`**.
   → keyframe 1 stamped at the playhead. A green ghost outline stays behind.
3. Scrub to the end, drag the rect onto the subject's new position, press **`r`** again.
   → keyframe 2, red ghost. A thin line joins the keyframe centres = the path.
4. Add intermediate keyframes the same way if the drift isn't straight — pressing `r`
   at a time that already has a keyframe (±0.05 s) **replaces** it rather than adding.
5. `G` renders as usual.

**Size lock.** After the first stamp the corner handles grey out and resizing is refused
with a toast (`size is locked while a track is armed — ⇧R clears it`). This prevents the
one case `crop` can't render (a window that changes size) by construction, rather than
discovering it at render time. Zoom during a track is `Z` (§4).

**Live preview.** While a track is armed and the video is playing, the rect follows the
interpolated path so you can watch whether the subject stays inside it. Driven by `rAF`,
suspended while dragging. The preview **must** call the same `_vpTrackAt()` the payload is
built from — if the two formulas drift the preview is a lie.

### 3.2 Hotkeys

Free-checked against every binding in `vpKeyHandler` and `_vpImgKey`
(taken: `m c t w e k z g l F 1 2 a s d f`, space, arrows).

| key | action |
|---|---|
| **`r`** | stamp / replace a track keyframe at the playhead (first press arms tracking) |
| **`⇧R`** | clear the whole track, unlock the size |
| **`q`** | toggle pillarbox bleed (§4) |

Left-hand per house style. `b` is also free and has the nicer mnemonic for bleed, but
`⇧B`-adjacency is exactly the class of bug dev0719 hit when a lower-casing handler ate
the shifted keys — `q`/`⇧R` have no shifted sibling in use, so take the safe pair.

### 3.3 Data model

Client, on `state` (the crop session object built in `_vpMountCropOverlay`):

```js
state.track = {
  on:    false,
  keys:  [],                 // [{ t, x, y }] — t = ABSOLUTE video seconds
                             //   x,y = rect top-left as a fraction of the source frame
  ease:  'linear',           // 'linear' | 'smooth'
  preview: true
};
state.bleed = false;         // §4
```

Payload to `/exec/ffmpeg`, alongside the existing `crop`:

```js
track: {
  keys: [ { t: 0.000, x: 412, y:   0 },     // t = seconds from CLIP start (A)
          { t: 8.400, x: 412, y: 980 } ],   // x,y = top-left in CANVAS pixels, ints
  ease: 'linear'
}
```

Canvas pixels (not fractions) to match `crop`'s existing units; canvas = the padded /
rotated frame, same space `crop.x/y` already live in. When `track` is present the proxy
ignores `crop.x/y` and uses the expressions; `crop.w/h` still carry the window size.

### 3.4 Proxy: expression builder

```js
// Per-frame crop coordinate from ascending keyframes. Mirrors _vpTrackAt() on the client.
function trackExpr(keys, ease) {
  const f = n => (+n).toFixed(4);
  if (keys.length === 1) return f(keys[0].v);
  let out = f(keys[keys.length - 1].v);                 // past the last key: hold
  for (let i = keys.length - 2; i >= 0; i--) {
    const t0 = f(keys[i].t), t1 = f(keys[i + 1].t);
    const v0 = f(keys[i].v), v1 = f(keys[i + 1].v);
    const p  = `((t-${t0})/(${t1}-${t0}))`;
    const e  = ease === 'smooth' ? `(${p})*(${p})*(3-2*(${p}))` : p;
    out = `if(lt(t,${t1}),${v0}+(${v1}-${v0})*${e},${out})`;
  }
  return `if(lt(t,${f(keys[0].t)}),${f(keys[0].v)},${out})`;   // before the first: hold
}
```

Emitted as `crop=W:H:x='…':y='…'` — **single-quote both**, for the same reason the
`zoompan` expressions are quoted: the commas inside `if(…)` would otherwise read as filter
separators. This is the exact shape measured in §1.

Size: ~60 chars/segment linear, ~120 smooth. At the 8-key cap that's ~1.7 KB across both
axes — well inside what ffmpeg parses.

**Default ease is `linear`, not smoothstep.** A subject drifting through frame moves at
roughly constant velocity; smoothstep would make the camera decelerate while the jelly
keeps going. Smoothstep is right for Ken Burns (a deliberate camera move) and stays the
default *there*. Offer `smooth` for tracks whose keys don't span the whole clip.

### 3.5 Validation (proxy)

- `keys` is an array, `1 ≤ length ≤ 8`.
- `t` finite, `≥ 0`, **strictly ascending**, minimum gap `0.05 s` (guards the
  divide-by-zero in the interpolator).
- `x`, `y` integers with `0 ≤ x ≤ canvasW − crop.w` and `0 ≤ y ≤ canvasH − crop.h`.
  Validating the *keys* is enough — linear and smoothstep interpolation are both convex
  combinations, so an in-bounds pair can never interpolate out of bounds. That keeps the
  expression free of `min`/`max` clamp wrappers.
- `ease ∈ {'linear','smooth'}`.
- `must(!(p.track && p.image), …)` — stills have no timeline.

### 3.6 Known limits worth stating in the cheat sheet

- **Pixel-quantised pan.** `crop` takes integer x/y, so the expression's result is rounded
  per frame. A slow pan (< 1 px/frame) therefore advances unevenly. In practice invisible,
  because the render downscales afterwards (a 2160→1080 output halves the jitter to a
  sub-pixel). Only a concern at `resHeight: 'source'` with a very slow pan.
- Track times are clip-relative and **not** pause-mapped (§2).

---

## 4. Feature B — reach past the edge

> **dev0778 revision.** As first built (dev0777) this padded the surplus with symmetric
> black bars. It no longer does: the render is the rect's **intersection with the frame**,
> and the output is whatever shape that is. §4.2a records why. The `pad` payload and its
> `vppad` flag survive in the proxy, unused by the client, for the day something genuinely
> needs a fixed output aspect — re-enabling it is one line in `_vpGoSave`.

### 4.1 The problem

Source is **2160 × 3840** portrait. A 16:9 crop at full frame width is capped at
`2160 × 1215` — to capture more of the subject vertically you need a *wider* rect than the
frame has pixels, and the surplus has to be black.

### 4.2a Why the surplus is discarded, not filled (dev0778)

Four reasons, in order of weight:

1. **Bars are irreversible; aspect is not.** You can letterbox at display time, or add bars
   later in one pass. You can never get back the pixels spent on black — for the same
   output height, a padded file carries strictly less picture.
2. **V and the slideshow already `contain`** (`vp.js:7769`, `vp.js:8559`,
   `slideshow.js:1720`). They letterbox on their own, so baked bars land *inside* the
   container's bars and the content renders smaller than it needs to.
3. **In G, bars defeat the framing control that already exists.** G cover-fits cell media
   (`grid.js:1134`) and dev0758 added `object-position`/COI precisely so a mismatched clip
   can be reframed inside its cell. A bar-padded 16:9 file in a 16:9 cell has *zero* cover
   overflow — as that code's own comment notes — so the COI has nothing to move and you are
   stuck with the black. Shipping the real aspect keeps the cell full-bleed and the framing
   adjustable.
4. **It turns a binary into a dial.** With the 16:9 lock, widening the rect walks the output
   continuously from 16:9 through square to the source's own shape. One drag answers "how
   much height do I want".

The cost, stated plainly: a non-16:9 clip in a 16:9 G cell **will be cover-cropped** back
toward 16:9, with the COI choosing the slice. If a particular clip must show its full
height inside a 16:9 cell, bars are the only way — which is why the proxy keeps `pad`.

### 4.2b The consequence for `resHeight`

`resHeight` is the **short side**: the proxy emits `scale=-2:H` for `L` and `scale=H:-2`
for `P`. Once the output is no longer a locked 16:9, the `L`/`P` flag can no longer come
from the rect's lock — it has to be derived from the rendered pixels. On a 2160×3840
source the output crosses into portrait at about **1.78×**, so without this the scale would
land on the wrong axis for the whole upper half of the dial. `_vpEffAspect(sw, sh)` does
it, and `_vpOutputDims` and `_vpCropUpscaleFactor` both take the derived value.

The same clipping has to be applied to **caption geometry**: text boxes are stored as
fractions of the *drawn* rect, so when the rendered crop is narrower they must be
re-expressed against the intersection before the wrap is computed, or every caption sits
too far left and wraps too narrow. `_vpGoSave` does this on a shallow clone so the live
boxes on screen keep their own coordinates.

### 4.2 Symmetric by construction, not by correction (superseded — see 4.2a)

*Retained because the arithmetic still governs the `pad` path the proxy keeps.*

The brief asks for symmetric bars with "minor asymmetries corrected". A snapping heuristic
isn't needed — the asymmetry can be designed out entirely:

> **Bleed is only ever produced by making the rect larger than the frame, never by dragging
> a smaller rect off the edge.** While `rectW ≤ frameW` the existing
> `clamp(x, 0, 1−w)` stays exactly as it is. Once `rectW > frameW`, `x` is *pinned* to
> `(1 − w)/2` and horizontal dragging is disabled.

Consequences, all exact:

```
padX = (rectW − VW) / 2          per side
ow   = VW + 2·padX = rectW       the padded canvas is exactly the rect's width
crop.x = padX + x·VW = 0         the crop spans the whole canvas horizontally
```

`rectW` and `VW` are both forced even (`even()` already exists on both paths), so
`rectW − VW` is even and `padX` is a whole pixel. **There is no rounding asymmetry left to
correct.** Same algebra on `y` for the letterbox case (landscape source, portrait crop).

### 4.3 The dial — measured, for a 2160×3840 source with a 16:9 lock

Produced by running the shipped `_vpEffFrac` / `_vpEffAspect` / `even()` math:

| rect × frame | output | shape | L/P | height vs 16:9 |
|---|---|---|---|---|
| 1.00× | 2160 × 1214 | 16:9 | L | — |
| 1.19× | 2160 × 1444 | 3:2  | L | +19 % |
| **1.33×** | **2160 × 1614** | **4:3** | L | **+33 %** |
| 1.58× | 2160 × 1918 | 1.13:1 | L | +58 % |
| 1.78× | 2160 × 2162 | 1:1 | **P** | +78 % |
| 2.22× | 2160 × 2696 | 4:5 | P | +122 % |
| 3.16× | 2160 × 3838 | 9:16 | P | +216 % |

Note the L→P flip at 1.78× — that is 4.2b in practice. Nothing here trips the upscale
warning: the output never exceeds the source on either axis.

The size label names the shape live while dragging (`2160 × 1614 · 4:3`), snapping to the
familiar ratios within half a percent because even-pixel rounding stops 2160×1214 from
reducing to 16:9 on its own (it lands on 1080:607).

### 4.4 Payload and filter

Mirrors the existing `rotate` contract exactly — *"the caller has already expressed
crop.x/y in this canvas"*:

```js
pad: { ow, oh, x, y }     →     `pad=${ow}:${oh}:${x}:${y}:black,`
```

Validation: all four non-negative even integers, `ow`/`oh` ≤ 16384 (x264's ceiling, and a
cheap guard against a runaway rect), and `crop.x + crop.w ≤ ow`, `crop.y + crop.h ≤ oh` —
the same bounds check `rotate` gets.

**`pad` and `rotate` are mutually exclusive.** They don't need to co-exist: `rotate`
already expands onto a `D × D` black canvas with `D = hypot(VW, VH)`, which for
2160 × 3840 is **4406** — wider than every practical bleed in the table above. So when the
rect is tilted, the client just widens `D` if the rect needs more
(`D = even(max(hypot(VW,VH), rectW, rectH))`) and drops `pad`. The only client change on
the tilt path is relaxing the `cx0 = max(0, min(D − sw, …))` clamp, which currently pins
the crop inside the frame.

### 4.5 Bleed × tracking — the features are independent

**Corrected during the build.** The first draft coupled these, describing tracking as
"vertical only when bled" and proposing UI to enforce it. That was wrong as a design:
tracking and bleed are separate requests and neither should constrain the other's
implementation. Nothing in the code couples them.

What is true is a geometric *consequence*, not a rule anyone has to write down or enforce.
Horizontal bleed means the rect is wider than the frame, so `pad` makes the canvas exactly
the rect's width and the only in-bounds value for `crop.x` is 0. The generic clamp
`0 ≤ x ≤ canvasW − cropW` collapses to a single point on its own. A track's x therefore
comes out constant, the expression folds to a literal, and y carries the whole move —
without a single line of special-casing.

It costs nothing either, because when the rect is wider than the frame the entire source
width is already visible: there is no subject horizontal panning could bring into view.
Where horizontal tracking *is* meaningful — a rect narrower than the frame — there is no
bleed on that axis and x moves freely. Tracking is never restricted anywhere it would do
something.

### 4.6 Bleed × Ken Burns

`zoompan` runs after `crop`, on the padded picture, so a Ken Burns move inside a bled crop
would zoom into the black bars as well as the content. Legal but rarely wanted — warn once
on arming both, don't block.

---

## 5. Composition summary

| combination | renders as | needs fps probe |
|---|---|---|
| crop | `crop` | no |
| crop + track | `crop` w/ expressions | **no** |
| crop + reach | `crop` of the intersection — no extra filter at all | no |
| crop + reach + track | `crop` w/ expressions (y only) | no |
| crop + Ken Burns | `crop,zoompan` | yes (unchanged) |
| crop + track + Ken Burns | `crop`(expr)`,zoompan` — pan the window, zoom within it | yes |

---

## 6. Work plan

### `proxy.js`

1. `trackExpr(keys, ease)` helper (§3.4) + `buildTrackCrop()` that assembles the
   `crop=W:H:x=…:y=…` token.
2. `buildFfmpegArgs`: `pad` prefix branch next to `rotate`; swap the literal crop token for
   the expression one when `p.track` is present; validation per §3.5 / §4.4.
3. Header comment block (the payload contract at ~line 700) — `pad` and `track` entries.
4. `PROXY_BUILD` bump, `/version` features `+ 'vptrack', 'vppad'`. **Restart required.**

### `vp.js`

5. `_vpMountCropOverlay` — `state.track`, `state.bleed`; ghost-outline + path layer inside
   `rect`'s parent (ghosts are frame-relative, not rect-relative, so they must sit *outside*
   the rect element or they'd move with it).
6. `onMove` — overhang-aware clamps in both the `move` and `resize` branches (§4.2);
   refuse resize while a track is armed.
7. `_vpTrackStamp()` / `_vpTrackClear()` / `_vpTrackAt(keys, ease, t)` / `paintTrack()`.
8. rAF preview loop, suspended while dragging.
9. `vpKeyHandler` + `_vpImgKey`: `r`, `⇧R`, `q`. (`r`/`⇧R` are video-only — a still has no
   timeline. `q` applies to both; a bled still crop is just as useful.)
10. `_vpCropUpscaleFactor` — judge by the **visible** strip, not the padded rect, so a crop
    bled on *both* axes can't hide a genuine enlargement behind black pixels.
11. `_vpGoSave` — build `pad` + `track`; filename tokens `trk<N>` and `pb<F>x`; feature
    gates for `vptrack` and `vppad`.
12. `snapshot()` (≈5621) and the `.edit` loader — round-trip `track` and `bleed`, both
    defaulting to off so pre-existing `.edit` files load unchanged.
13. Cheat-sheet panel: the three new keys + the two limits in §3.6.

### `index.html`

14. `HELP_VERSION_STR` bump, commit + push.

### Feature gates are not optional here

A stale proxy that ignores `track` renders a **static** crop — looks like a clean success
until you play it. One that ignores `pad` applies canvas-space coordinates to the raw
frame and grabs the **wrong region**. Both are silent wrong answers on a long encode, so
both get the hard refusal treatment `rotate` / `noaudio` / `kenburns` already have.

---

## 7. Test list (for the user, after the bump)

1. Portrait disk clip, `C`, rect at default. Press `r` at 0 s, scrub to the end, drag the
   rect down, `r` again. Confirm: two ghosts + a path line, corner handles greyed, chip
   reads `◈ track 2`.
2. Play it back — the rect should glide along the path and sit still after the last key.
3. `G`. The rendered clip should keep the subject framed, be the **same duration and frame
   count** as an equivalent static crop, and be silent/audible per `M` as before.
4. `⇧R` → ghosts gone, handles live again.
5. `q`, then drag a corner outward past the frame edge. Confirm the rect grows past the
   edge, snaps horizontally centred, refuses to be dragged sideways, and the label reads
   the output size and shape (`2160 × 1614 · 4:3`), changing as you widen.
6. `G`. Check there is **no black anywhere**, the extra height is there, and the file is
   the shape the label promised. `⇧Q` then `G` should give the whole frame.
7. `q` + `r` together — a reaching rect tracks vertically (its x has nowhere to go).
7b. A caption (`E`) on a reaching crop must land where it was drawn, at the drawn width.
8. Regression: a plain crop, a Ken Burns crop, a crop with captions, and a crop with a
   pause must all still render. Ken Burns especially — it shares the `crop` token.
9. `K` an `.edit` with a track + bleed, `E` it back, confirm both restore.

---

## 8. Deferred

- **Blur-fill instead of black bars.** The social-media look: a zoomed, blurred copy of the
  source behind the sharp strip. Fits in one `-filter:v` graph
  (`split[bg][fg];[bg]scale=…:force_original_aspect_ratio=increase,crop=OW:OH,gblur=sigma=30[b];[fg]…[f];[b][f]overlay=(W-w)/2:(H-h)/2`)
  but it turns the linear chain into a labelled graph, which every downstream stage
  (`zoompan`, `tpad`, `drawtext`) then has to be threaded through. Worth doing, worth doing
  second.
- **Pan + zoom in one track** (windows of differing size). Needs the `zoompan` fallback and
  the fps probe. Only build it if the size lock turns out to be annoying in practice.
- **Automatic tracking.** Draw one box on the subject, have a Python/OpenCV CSRT tracker
  behind a new proxy endpoint generate the keyframes. There's precedent for a Python helper
  (`ig_impersonate_fetch.py`), and it would turn the comb-jelly case into two clicks. Hold
  it until manual keyframes prove insufficient — for a slow drift, two keys usually are
  enough, and the manual path is the fallback the auto path would need anyway.
