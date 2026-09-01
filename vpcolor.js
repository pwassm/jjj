// vpcolor.js — (dev0867) COLOUR GRADING FOR THE CROP TOOL
// ═══════════════════════════════════════════════════════════════════════════
//
// Six sliders over the V crop overlay and the still-image crop, previewed live
// on the frame and baked into the render.
//
// THE ONE DECISION EVERYTHING ELSE FOLLOWS FROM
//
// A colour tool is only worth having if the preview is the render. That is
// normally the hard part, because the browser grades in sRGB with CSS/SVG
// filters and ffmpeg grades in YUV with `eq`, and the two do genuinely
// different arithmetic. So instead of building one and approximating it with
// the other, this picks a colour model that BOTH can express exactly:
//
//     stage 1   per-channel  v -> slope * v^(1/gamma) + lift
//               browser: feComponentTransfer (gamma, then linear)
//               ffmpeg : lutrgb
//
//     stage 2   one fused 3x3 saturation matrix
//               browser: feColorMatrix
//               ffmpeg : colorchannelmixer
//
// Both in sRGB — hence color-interpolation-filters="sRGB" on the filter, which
// is the single most important attribute in this file. Without it the browser
// works in linearRGB (the SVG default) and the preview quietly stops matching.
//
// The matrix is computed HERE, with the same Rec.709 luma coefficients CSS
// saturate() uses, and the nine numbers are handed to ffmpeg. Nothing has to
// agree with a filter's private idea of what "saturation" means, because only
// one of the two ever decides.
//
// WHY THE OFFSET CAN SIT ON EITHER SIDE OF THE MATRIX
//
// Stage 1's lift is the same number on all three channels, and a saturation
// matrix's rows each sum to 1 — so M·(k,k,k) = (k,k,k). The lift therefore
// commutes with the matrix, and both renderers can apply it first (where the
// per-channel clamp behaves identically) without changing the result. That is
// what lets stage 1 collapse into a single LUT.
//
// WHITE BALANCE IS EXPONENTIAL, NOT LINEAR
//
// Warmth drives gR = 2^w and gB = 2^-w, so ±1 spans a 4:1 red-to-blue ratio —
// enough to pull a real underwater cast back, while staying gentle near zero
// where most grades live. It is also luminance-neutral by construction: the two
// gains multiply to 1 at every setting. A linear ±0.35 ramp was the first cut
// and could not reach far enough to fix the footage this was built for.
//
// HDR SOURCES ARE THE ONE PLACE THIS GOT AWAY FROM US
//
// A phone shooting HLG or HDR10 hands ffmpeg BT.2020 pixels on a log curve.
// Chrome tone-maps those to SDR before painting them — so the preview was
// honest — while ffmpeg read them as sRGB and graded a violet picture nobody
// had seen. dev0868 tone-maps in the proxy first (see TONEMAP_CHAIN there, and
// the calibration against Chrome recorded beside it). Nothing in THIS file
// changes for HDR: the browser was already doing the right thing.
//
// The grade is STICKY: it survives moving to the next clip and reloading the
// page, because a batch of dives shares one cast. That is only safe because the
// crop bar carries an amber "graded" chip whenever one is loaded — a sticky
// setting you cannot see is a trap, and this is the thing that makes it not one.

(function () {
  'use strict';

  const SVG_NS     = 'http://www.w3.org/2000/svg';
  const PANEL_ID   = 'vp-color-panel';
  const MENU_ID    = 'vp-color-menu';
  const SVG_ID     = 'vp-color-svg';
  const FILTER_ID  = 'vpColorFx';
  const CHIP_ID    = 'vp-crop-colour';
  // Same layer as the crop cheat-sheet: above the slideshow menu (42000) and
  // the V player (41000), so no host stacking context can clip it.
  const PANEL_Z    = 42500;
  const PROXY_BASE = 'http://127.0.0.1:8081';

  const LS_GRADE   = 'vpColorGrade';
  const LS_PRESETS = 'vpColorPresets';
  const LS_POS     = 'vpColorPanelPos';

  // Rec.709 luma — the coefficients CSS saturate() and SVG feColorMatrix
  // type="saturate" are defined with. Using anything else here would be the one
  // way left for the preview and the render to disagree.
  const LR = 0.213, LG = 0.715, LB = 0.072;

  // ±1 warmth = a 4:1 red:blue ratio; ±1 tint = 1.62x green. See the header.
  const WARM_A = 1.0;
  const TINT_A = 0.7;
  // (dev0868) …and the sliders run to ±3, not ±1. A blue-lit aquarium measured
  // out at a needed warmth of 2.64 — the ceiling was the thing stopping the
  // correction, not the model. The COEFFICIENT is unchanged, so the first third
  // of the travel behaves exactly as it did; the rest is headroom that was not
  // there before. At ±3 the gain is x8 one way and ÷8 the other.
  const WB_RANGE = 3;

  // colorchannelmixer clamps its coefficients to ±2. At saturation 1.8 the
  // largest fused coefficient is 1.74, so this is the ceiling that keeps ffmpeg
  // from silently truncating one into a colour nobody asked for.
  const SAT_MAX = 1.8;

  const NEUTRAL = { warmth: 0, tint: 0, bright: 0, contrast: 1, sat: 1, gamma: 1 };

  const SLIDERS = [
    { key: 'warmth',   label: 'Warmth',   min: -300, max: 300, signed: true,
      hint: 'blue/cyan cast → warm. The underwater knob. Past ±1 it is pulling hard.' },
    { key: 'tint',     label: 'Tint',     min: -300, max: 300, signed: true,
      hint: 'green water ↔ magenta' },
    { key: 'bright',   label: 'Bright',   min:  -25, max:  25, signed: true,
      hint: 'lifts or drops the whole picture' },
    { key: 'contrast', label: 'Contrast', min:   50, max: 200, signed: false,
      hint: 'flat, hazy water needs more of this' },
    { key: 'sat',      label: 'Satur.',   min:    0, max: 180, signed: false,
      hint: '0 is monochrome; 1.8 is the ceiling ffmpeg will take' },
    { key: 'gamma',    label: 'Gamma',    min:   60, max: 160, signed: false,
      hint: 'opens the shadows without blowing the highlights' }
  ];

  let grade   = loadGrade();
  let mediaEl = null;    // the element currently wearing the preview
  let bypass  = false;   // ◧ compare, held down

  // ── numbers ──────────────────────────────────────────────────────────────

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function num(v, dflt) { const n = +v; return Number.isFinite(n) ? n : dflt; }

  function sane(g) {
    const o = Object.assign({}, NEUTRAL, g || {});
    o.warmth   = clamp(num(o.warmth,   0), -WB_RANGE, WB_RANGE);
    o.tint     = clamp(num(o.tint,     0), -WB_RANGE, WB_RANGE);
    o.bright   = clamp(num(o.bright,   0), -0.25, 0.25);
    o.contrast = clamp(num(o.contrast, 1), 0.5, 2);
    o.sat      = clamp(num(o.sat,      1), 0, SAT_MAX);
    o.gamma    = clamp(num(o.gamma,    1), 0.6, 1.6);
    return o;
  }

  function gainsOf(g) {
    return { r: Math.pow(2,  WARM_A * g.warmth),
             g: Math.pow(2,  TINT_A * g.tint),
             b: Math.pow(2, -WARM_A * g.warmth) };
  }

  // Stage 1, per channel: v -> slope * v^gx + k, where gx = 1/gamma.
  // Deriving the fused form: gamma, then gain and lift, then contrast —
  //   v1 = v^gx
  //   v2 = gain*v1 + bright
  //   v3 = contrast*(v2 - 0.5) + 0.5 = (contrast*gain)*v1 + contrast*bright + 0.5*(1-contrast)
  function lutOf(g) {
    const gn = gainsOf(g), c = g.contrast;
    return { gx: 1 / g.gamma,
             sr: c * gn.r, sg: c * gn.g, sb: c * gn.b,
             k:  c * g.bright + 0.5 * (1 - c) };
  }

  // Stage 2: the standard saturate matrix, written out so the same nine numbers
  // go to feColorMatrix and to colorchannelmixer.
  function mixOf(g) {
    const s = g.sat;
    return { rr: LR + s * (1 - LR), rg: LG - s * LG,       rb: LB - s * LB,
             gr: LR - s * LR,       gg: LG + s * (1 - LG), gb: LB - s * LB,
             br: LR - s * LR,       bg: LG - s * LG,       bb: LB + s * (1 - LB) };
  }

  const near = (a, b) => Math.abs(a - b) < 1e-6;
  function lutNeutral(g) {
    return near(g.warmth, 0) && near(g.tint, 0) && near(g.bright, 0) &&
           near(g.contrast, 1) && near(g.gamma, 1);
  }
  function mixNeutral(g) { return near(g.sat, 1); }
  function isNeutral(g)  { return lutNeutral(g) && mixNeutral(g); }

  // ── persistence ──────────────────────────────────────────────────────────

  function loadGrade() {
    try { return sane(JSON.parse(localStorage.getItem(LS_GRADE) || 'null')); }
    catch (_) { return sane(null); }
  }
  function saveGrade() {
    try { localStorage.setItem(LS_GRADE, JSON.stringify(grade)); } catch (_) {}
  }
  function loadPresets() {
    try {
      const a = JSON.parse(localStorage.getItem(LS_PRESETS) || '[]');
      return Array.isArray(a) ? a.filter(p => p && p.name && p.g).slice(0, 40) : [];
    } catch (_) { return []; }
  }
  function savePresets(list) {
    try { localStorage.setItem(LS_PRESETS, JSON.stringify(list.slice(0, 40))); } catch (_) {}
  }

  // ── the SVG filter (the preview) ──────────────────────────────────────────

  function ensureSvg() {
    let svg = document.getElementById(SVG_ID);
    if (svg) return svg;
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.id = SVG_ID;
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;' +
                        'overflow:hidden;pointer-events:none;';
    const f = document.createElementNS(SVG_NS, 'filter');
    f.setAttribute('id', FILTER_ID);
    // THE attribute. The SVG default is linearRGB, which would put the preview
    // in a different colour space from the file and make every slider lie.
    f.setAttribute('color-interpolation-filters', 'sRGB');
    // Pin the filter region to the element box. The default (-10%..120%) makes
    // the browser allocate a surface larger than the video for no gain.
    f.setAttribute('x', '0%');
    f.setAttribute('y', '0%');
    f.setAttribute('width', '100%');
    f.setAttribute('height', '100%');

    const ctG = document.createElementNS(SVG_NS, 'feComponentTransfer');
    const ctL = document.createElementNS(SVG_NS, 'feComponentTransfer');
    ['R', 'G', 'B'].forEach(ch => {
      const a = document.createElementNS(SVG_NS, 'feFunc' + ch);
      a.setAttribute('type', 'gamma');
      a.setAttribute('amplitude', '1');
      a.setAttribute('offset', '0');
      a.setAttribute('exponent', '1');
      ctG.appendChild(a);
      const b = document.createElementNS(SVG_NS, 'feFunc' + ch);
      b.setAttribute('type', 'linear');
      b.setAttribute('slope', '1');
      b.setAttribute('intercept', '0');
      ctL.appendChild(b);
    });
    const cm = document.createElementNS(SVG_NS, 'feColorMatrix');
    cm.setAttribute('type', 'matrix');
    cm.setAttribute('values', '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0');

    f.appendChild(ctG);
    f.appendChild(ctL);
    f.appendChild(cm);
    svg.appendChild(f);
    document.body.appendChild(svg);
    // Alpha is deliberately untouched by all three primitives, so the
    // transparent ground outside an image stays transparent and the lift can
    // never paint a halo around the picture.
    return svg;
  }

  function paintFilter() {
    const svg = ensureSvg();
    const L = lutOf(grade), M = mixOf(grade);
    const fns = svg.querySelectorAll('feComponentTransfer');
    const slope = [L.sr, L.sg, L.sb];
    if (fns[0]) {
      Array.prototype.forEach.call(fns[0].children, fn => fn.setAttribute('exponent', L.gx.toFixed(6)));
    }
    if (fns[1]) {
      Array.prototype.forEach.call(fns[1].children, (fn, i) => {
        fn.setAttribute('slope', slope[i].toFixed(6));
        fn.setAttribute('intercept', L.k.toFixed(6));
      });
    }
    const cm = svg.querySelector('feColorMatrix');
    if (cm) {
      cm.setAttribute('values',
        [M.rr, M.rg, M.rb, 0, 0,
         M.gr, M.gg, M.gb, 0, 0,
         M.br, M.bg, M.bb, 0, 0,
         0, 0, 0, 1, 0].map(n => (+n).toFixed(6)).join(' '));
    }
  }

  function applyPreview() {
    if (!mediaEl) return;
    if (bypass || isNeutral(grade)) { mediaEl.style.filter = ''; return; }
    paintFilter();
    mediaEl.style.filter = 'url(#' + FILTER_ID + ')';
  }

  // ── the crop-bar chip ────────────────────────────────────────────────────
  //
  // A sticky grade that is not on screen is a trap, so this is not optional
  // decoration: it is the thing that makes stickiness safe.
  function paintChip() {
    const chip = document.getElementById(CHIP_ID);
    if (!chip) return;
    const on = !isNeutral(grade);
    chip.textContent = on ? '🎨 graded' : '🎨 colour';
    chip.style.background = on ? '#5a4a1a' : '#234';
    chip.style.color      = on ? '#ffd24a' : '';
  }

  // ── the panel ────────────────────────────────────────────────────────────

  function fmt(key, v) {
    if (key === 'contrast' || key === 'sat' || key === 'gamma') return '×' + v.toFixed(2);
    return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
  }

  function isOpen() { return !!document.getElementById(PANEL_ID); }

  function close() {
    const el = document.getElementById(PANEL_ID);
    if (el) el.remove();
    closeMenu();
  }

  function toggle() {
    if (isOpen()) { close(); return; }
    if (!mediaEl) {
      if (typeof toast === 'function') toast('Colour: open the crop tool first (C)', 2200);
      return;
    }
    open();
  }

  function open() {
    close();
    const el = document.createElement('div');
    el.id = PANEL_ID;
    el.style.cssText =
      'position:fixed;z-index:' + PANEL_Z + ';width:274px;background:rgba(10,10,22,0.97);' +
      'border:2px solid #4af;border-radius:9px;color:#dfe6f0;' +
      'font:12px ui-monospace,Consolas,monospace;box-shadow:0 8px 32px rgba(0,0,0,0.9);' +
      'user-select:none;';

    let html =
      '<div id="vp-color-drag" style="display:flex;align-items:center;gap:6px;cursor:move;' +
        'padding:5px 7px;border-bottom:1px solid rgba(102,170,255,0.3);">' +
        '<b style="color:#8ef;">Colour</b>' +
        '<span id="vp-color-auto" title="Auto white balance — ffmpeg averages the frame inside the crop rect and neutralises the cast. A starting point, not a verdict." ' +
          'style="margin-left:auto;cursor:pointer;padding:1px 6px;background:#234;border-radius:3px;">⚖ auto</span>' +
        '<span id="vp-color-reset" title="Back to neutral" ' +
          'style="cursor:pointer;padding:1px 6px;background:#234;border-radius:3px;">↺</span>' +
        '<span id="vp-color-close" title="Close the panel (B) — the grade stays on" ' +
          'style="cursor:pointer;padding:1px 6px;background:#234;border-radius:3px;">✕</span>' +
      '</div><div style="padding:6px 7px 7px;">';

    SLIDERS.forEach(sl => {
      html +=
        '<div style="display:flex;align-items:center;gap:5px;margin:3px 0;">' +
          '<span class="vp-color-lbl" data-k="' + sl.key + '" title="' + sl.hint +
            ' · double-click to reset this one" ' +
            'style="width:56px;cursor:pointer;opacity:0.85;">' + sl.label + '</span>' +
          '<input class="vp-color-sl" data-k="' + sl.key + '" type="range" ' +
            'min="' + sl.min + '" max="' + sl.max + '" step="1" style="flex:1;min-width:0;">' +
          '<span class="vp-color-val" data-k="' + sl.key + '" ' +
            'style="width:44px;text-align:right;">–</span>' +
        '</div>';
    });

    html +=
        '<div style="display:flex;align-items:center;gap:5px;margin-top:6px;">' +
          '<span id="vp-color-cmp" title="Hold to see the picture ungraded" ' +
            'style="cursor:pointer;padding:2px 6px;background:#234;border-radius:3px;">◧ before</span>' +
          '<span id="vp-color-presets" title="Saved grades — click one to load it · right-click an entry to delete it" ' +
            'style="cursor:pointer;padding:2px 6px;background:#234;border-radius:3px;">▾ presets</span>' +
          '<span id="vp-color-save" title="Save this grade under a name" ' +
            'style="margin-left:auto;cursor:pointer;padding:2px 6px;background:#234;border-radius:3px;">＋ save</span>' +
        '</div>' +
      '</div>';
    el.innerHTML = html;
    document.body.appendChild(el);

    // Default to the LEFT, clear of the crop cheat-sheet which parks itself on
    // the right; a remembered position wins.
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(LS_POS) || 'null'); } catch (_) {}
    el.style.left = ((pos && Number.isFinite(pos.x)) ? pos.x : 16) + 'px';
    el.style.top  = ((pos && Number.isFinite(pos.y)) ? pos.y : 64) + 'px';
    clampPanel(el);

    // Nothing in here may reach #gridFullscreen's click handler, which closes V.
    el.addEventListener('click',       e => e.stopPropagation());
    el.addEventListener('pointerdown', e => e.stopPropagation());
    el.addEventListener('mousedown',   e => e.stopPropagation());
    el.addEventListener('wheel',       e => e.stopPropagation());
    // Escape closes the panel rather than the video. vpKeyHandler stands down
    // for anything inside this panel (see its #vp-color-panel guard), so this
    // listener is the only one that sees the key.
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });

    el.querySelectorAll('.vp-color-sl').forEach(inp => {
      inp.addEventListener('input', () => {
        grade[inp.dataset.k] = (+inp.value) / 100;
        grade = sane(grade);
        commit();
      });
    });
    el.querySelectorAll('.vp-color-lbl').forEach(lb => {
      lb.addEventListener('dblclick', () => {
        grade[lb.dataset.k] = NEUTRAL[lb.dataset.k];
        commit();
      });
    });
    el.querySelector('#vp-color-close').addEventListener('click', close);
    el.querySelector('#vp-color-reset').addEventListener('click', () => {
      grade = sane(null);
      commit();
      if (typeof toast === 'function') toast('↺ colour back to neutral', 1400);
    });
    el.querySelector('#vp-color-auto').addEventListener('click', autoBalance);
    el.querySelector('#vp-color-presets').addEventListener('click', presetMenu);
    el.querySelector('#vp-color-save').addEventListener('click', savePreset);

    const cmp = el.querySelector('#vp-color-cmp');
    const hold = on => { bypass = on; cmp.style.background = on ? '#5a4a1a' : '#234'; applyPreview(); };
    cmp.addEventListener('pointerdown', e => { e.preventDefault(); hold(true); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev =>
      cmp.addEventListener(ev, () => hold(false)));

    dragBy(el, el.querySelector('#vp-color-drag'));
    paintPanel();
  }

  // Every path that changes the grade ends here: repaint the sliders, the
  // preview, the bar chip, and remember it.
  function commit() {
    grade = sane(grade);
    saveGrade();
    paintPanel();
    applyPreview();
    paintChip();
  }

  function paintPanel() {
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    SLIDERS.forEach(sl => {
      const v = grade[sl.key];
      const inp = el.querySelector('.vp-color-sl[data-k="' + sl.key + '"]');
      const out = el.querySelector('.vp-color-val[data-k="' + sl.key + '"]');
      if (inp) inp.value = String(Math.round(v * 100));
      if (out) {
        out.textContent = fmt(sl.key, v);
        out.style.color = near(v, NEUTRAL[sl.key]) ? '#8a93a0' : '#ffd24a';
      }
    });
  }

  function clampPanel(el) {
    const b = el.getBoundingClientRect();
    const x = Math.max(2, Math.min(window.innerWidth  - b.width  - 2, parseFloat(el.style.left) || 0));
    const y = Math.max(2, Math.min(window.innerHeight - b.height - 2, parseFloat(el.style.top)  || 0));
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
  }

  function dragBy(el, handle) {
    let d = null;
    handle.addEventListener('pointerdown', e => {
      if (e.target !== handle && !e.target.matches('b')) return;   // chips keep their clicks
      e.preventDefault(); e.stopPropagation();
      const b = el.getBoundingClientRect();
      d = { dx: e.clientX - b.left, dy: e.clientY - b.top };
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    });
    handle.addEventListener('pointermove', e => {
      if (!d) return;
      el.style.left = (e.clientX - d.dx) + 'px';
      el.style.top  = (e.clientY - d.dy) + 'px';
    });
    handle.addEventListener('pointerup', e => {
      if (!d) return;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      d = null;
      clampPanel(el);
      try {
        localStorage.setItem(LS_POS, JSON.stringify({
          x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0
        }));
      } catch (_) {}
    });
  }

  // ── presets ──────────────────────────────────────────────────────────────

  function closeMenu() {
    const m = document.getElementById(MENU_ID);
    if (m) m.remove();
  }

  function savePreset() {
    if (isNeutral(grade)) {
      if (typeof toast === 'function') toast('nothing to save — this grade is neutral', 2000);
      return;
    }
    const name = prompt('Name this grade (e.g. "Red Sea 20m"):', '');
    if (!name) return;
    const clean = String(name).trim().slice(0, 40);
    if (!clean) return;
    const list = loadPresets().filter(p => p.name !== clean);
    list.unshift({ name: clean, g: Object.assign({}, grade) });
    savePresets(list);
    if (typeof toast === 'function') toast('✓ saved "' + clean + '"', 1800);
  }

  function presetMenu(e) {
    if (e) e.stopPropagation();
    closeMenu();
    const list = loadPresets();
    const anchor = document.getElementById('vp-color-presets');
    const b = anchor ? anchor.getBoundingClientRect() : { left: 20, bottom: 80 };
    const m = document.createElement('div');
    m.id = MENU_ID;
    m.style.cssText =
      'position:fixed;left:' + Math.round(b.left) + 'px;top:' + Math.round(b.bottom + 4) + 'px;' +
      'z-index:' + (PANEL_Z + 10) + ';min-width:190px;max-height:52vh;overflow-y:auto;' +
      'background:rgba(10,10,22,0.98);border:2px solid #4af;border-radius:7px;padding:5px;' +
      'color:#dfe6f0;font:12px ui-monospace,Consolas,monospace;box-shadow:0 8px 32px rgba(0,0,0,0.9);';
    if (!list.length) {
      const d = document.createElement('div');
      d.style.cssText = 'padding:5px 7px;opacity:0.7;';
      d.textContent = 'No saved grades yet — ＋ save keeps this one';
      m.appendChild(d);
    } else {
      const hd = document.createElement('div');
      hd.style.cssText = 'padding:3px 7px 5px;opacity:0.6;border-bottom:1px solid rgba(102,170,255,0.3);margin-bottom:4px;';
      hd.textContent = 'click to load · right-click to delete';
      m.appendChild(hd);
      list.forEach(p => {
        const d = document.createElement('div');
        d.style.cssText = 'padding:5px 7px;border-radius:5px;cursor:pointer;white-space:nowrap;';
        d.textContent = p.name;
        d.onmouseenter = () => { d.style.background = '#12325c'; };
        d.onmouseleave = () => { d.style.background = ''; };
        d.onclick = ev => {
          ev.stopPropagation();
          grade = sane(p.g);
          commit();
          closeMenu();
          if (typeof toast === 'function') toast('🎨 ' + p.name, 1600);
        };
        d.oncontextmenu = ev => {
          ev.preventDefault(); ev.stopPropagation();
          savePresets(loadPresets().filter(q => q.name !== p.name));
          closeMenu();
          if (typeof toast === 'function') toast('deleted "' + p.name + '"', 1600);
        };
        m.appendChild(d);
      });
    }
    m.addEventListener('click', ev => ev.stopPropagation());
    document.body.appendChild(m);
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
  }

  // ── auto white balance ───────────────────────────────────────────────────
  //
  // Grey world: assume the average of the region should be neutral, and solve
  // the warmth/tint model for the gains that would make it so.
  //
  //   warmth: gR/gB = 2^(2*WARM_A*w) must equal b/r   ->  w = log2(b/r) / (2*WARM_A)
  //   tint:   gG    = 2^(TINT_A*t)   must equal sqrt(r*b)/g
  //                                              ->  t = log2(sqrt(r*b)/g) / TINT_A
  //
  // Measured by ffmpeg on the source file rather than by a canvas on the video
  // element: the page and the proxy are different origins, so a getImageData
  // read would taint and throw — and even where it didn't, it would be
  // measuring the browser's yuv->rgb conversion instead of the pixels that are
  // about to be graded.
  async function autoBalance(e) {
    if (e) e.stopPropagation();
    const ctx = (typeof window._vpColorAutoContext === 'function')
      ? window._vpColorAutoContext() : null;
    if (!ctx) {
      if (typeof toast === 'function') {
        toast('⚖ auto needs the file on disk — no path for this row', 2600);
      }
      return;
    }
    const btn = document.getElementById('vp-color-auto');
    const was = btn ? btn.textContent : '';
    if (btn) btn.textContent = '⚖ …';
    try {
      const r = await fetch(PROXY_BASE + '/frame/average', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ctx)
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) {
        if (typeof toast === 'function') {
          toast('⚖ auto failed: ' + ((j && j.error) || r.status) +
                ' — proxy restarted on 8081?', 4200);
        }
        return;
      }
      // A near-black frame has no cast to read; balancing it would amplify
      // whatever noise happened to be brightest.
      const R = j.r, G = j.g, B = j.b;
      if (R + G + B < 24) {
        if (typeof toast === 'function') toast('⚖ that frame is too dark to balance', 2600);
        return;
      }
      const r1 = Math.max(1, R), g1 = Math.max(1, G), b1 = Math.max(1, B);
      const w = Math.log2(b1 / r1) / (2 * WARM_A);
      const t = Math.log2(Math.sqrt(r1 * b1) / g1) / TINT_A;
      const pinned = (Math.abs(w) > WB_RANGE) || (Math.abs(t) > WB_RANGE);
      grade.warmth = clamp(w, -WB_RANGE, WB_RANGE);
      grade.tint   = clamp(t, -WB_RANGE, WB_RANGE);
      commit();
      // (dev0868) A channel this dark carries almost nothing to amplify. Say so
      // — the alternative is the user dragging a slider that can only ever turn
      // the noise in an empty channel into confetti.
      const floor = Math.min(R, G, B);
      const note = pinned ? ' — cast is past the slider, pinned at full'
                 : (floor < 12 ? ' — but one channel is nearly empty (' + floor +
                                 '/255): this light is close to a single colour, ' +
                                 'and balancing cannot invent what was not recorded'
                              : '');
      if (typeof toast === 'function') {
        toast('⚖ balanced from rgb(' + R + ',' + G + ',' + B + ')' +
              (j.hdr ? ' · HDR→SDR' : '') + note, floor < 12 || pinned ? 6000 : 3200);
      }
    } catch (err) {
      if (typeof toast === 'function') {
        toast('⚖ auto failed: ' + ((err && err.message) || err) +
              ' — proxy restarted on 8081?', 4200);
      }
    } finally {
      if (btn) btn.textContent = was || '⚖ auto';
    }
  }

  // ── what vp.js talks to ──────────────────────────────────────────────────

  // Called when the crop overlay is revealed. `el` is the <video> or the <img>.
  window.vpColorMount = function (el) {
    // Only ever a real element. On a YouTube or Vimeo row _vpState.player is
    // the provider's own object, and asking that for a .style would throw
    // where today it simply grades nothing.
    mediaEl = (el && el.nodeType === 1 && el.style) ? el : null;
    bypass = false;
    applyPreview();
    paintChip();
    const chip = document.getElementById(CHIP_ID);
    if (chip && !chip._vpColorWired) {
      chip._vpColorWired = true;
      chip.addEventListener('click', ev => { ev.stopPropagation(); toggle(); });
    }
  };

  // Called when it is hidden or disposed. The preview MUST come off here: the
  // slideshow reuses its <img> element, so a leaked filter would go on to tint
  // the whole show.
  window.vpColorUnmount = function () {
    if (mediaEl) { try { mediaEl.style.filter = ''; } catch (_) {} }
    mediaEl = null;
    bypass = false;
    close();
  };

  window.vpColorToggle = toggle;
  window.vpColorActive = function () { return !isNeutral(grade); };

  // The render payload. Null when neutral, so an ungraded render sends nothing
  // and takes exactly the path it always has.
  window.vpColorPayload = function () {
    if (isNeutral(grade)) return null;
    const out = {};
    if (!lutNeutral(grade)) out.lut = lutOf(grade);
    if (!mixNeutral(grade)) out.mix = mixOf(grade);
    return (out.lut || out.mix) ? out : null;
  };

  // One compact token for the sidecar description, naming only what was moved.
  window.vpColorDetailToken = function () {
    if (isNeutral(grade)) return '';
    const bits = [];
    const sgn = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
    if (!near(grade.warmth, 0))   bits.push('w' + sgn(grade.warmth));
    if (!near(grade.tint, 0))     bits.push('t' + sgn(grade.tint));
    if (!near(grade.bright, 0))   bits.push('b' + sgn(grade.bright));
    if (!near(grade.contrast, 1)) bits.push('c' + grade.contrast.toFixed(2));
    if (!near(grade.sat, 1))      bits.push('s' + grade.sat.toFixed(2));
    if (!near(grade.gamma, 1))    bits.push('g' + grade.gamma.toFixed(2));
    return 'col ' + bits.join(' ');
  };
})();
