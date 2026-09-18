"""igclip.py — image step for igClassify (dev1005).

    python igclip.py --author schmidtocean            (one or more, comma-separated)
    python igclip.py --author x --limit 30            (first N posts; a timing run)
    python igclip.py --author x --frames-only         (timeline frames, no models)

For every post of the author(s) in ig.json (never written):
  1. FRAMES — evenly spaced frames from each video (6..16 by length, one per ~10s) and a
     copy of each photo, 320px wide, to igclass_frames/<author>/<id>/<file>_<k>.jpg.
     They are the review page's filmstrip/timeline AND the models' input. Cached: an
     existing frame is never re-extracted.
  2. CLIP (ViT-B-32 laion2b) — what KIND of picture each frame is: sea-animal, person,
     text slide, cartoon, landscape, ship/gear, microscope, ...
  3. BioCLIP (imageomics/bioclip) — WHICH organism group: fish, sea slug, cephalopod,
     jelly, coral, crustacean, echinoderm, worm, ..., algae, plant, fungi, protist.
Writes igclass.clip.json {rows:{<id>:{frames:[{src,t,fi,c,cp,b,bp}], durs, clipFrac,
clipMax, bio}}} (other authors' rows kept) + frame embeddings to igclass_emb/ for later
training. igClassify.js fuses this with the caption verdict. Models download once to
M:\\hf_cache (not C:).
"""
import argparse, json, math, os, sys, time
os.environ.setdefault('HF_HOME', r'M:\hf_cache')
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IG = ROOT / 'ig.json'
OUT = ROOT / 'igclass.clip.json'
FRAMES = ROOT / 'igclass_frames'
EMB = ROOT / 'igclass_emb'
MEDIA = ROOT / 'ig_media'
VID_EXT = {'.mp4', '.webm', '.mov', '.mkv', '.m4v'}
THUMB_W = 320

# ---- CLIP: what kind of picture ----
CLIP_CLASSES = {
    'sea-animal': ['an underwater photo of a sea animal', 'a deep-sea creature filmed by an underwater robot',
                   'a close-up photo of a marine invertebrate', 'a fish swimming underwater', 'a jellyfish in dark water'],
    'land-animal': ['a photo of an insect', 'a photo of a wild animal on land', 'a photo of a lizard or a frog'],
    'bird': ['a photo of a bird', 'a seabird flying over the ocean'],
    'plant': ['a close-up photo of a flower', 'a photo of a plant', 'seaweed or kelp underwater'],
    'mushroom': ['a photo of a mushroom', 'a photo of a fungus or slime mold'],
    'microscope': ['a microscope image of cells', 'a micrograph of a tiny organism', 'a microscopic image of plankton'],
    'person': ['a photo of a person', 'a person talking to the camera', 'a portrait of a scientist', 'a selfie'],
    'people': ['a group of people', 'people working on the deck of a ship', 'scientists working in a laboratory'],
    'diver': ['a scuba diver underwater'],
    'text': ['a slide with text', 'a title card with words', 'a screenshot of text', 'an infographic with words'],
    'cartoon': ['a cartoon illustration', 'a drawing or a painting', 'an animated graphic', 'a digital artwork'],
    'landscape': ['a landscape photo', 'a beach and a coastline', 'a sunset over the ocean', 'mountains and sky',
                  'an aerial view of an island'],
    'gear': ['a research ship at sea', 'an underwater robot', 'scientific equipment on a ship',
             'a control room with many screens'],
    'seafloor': ['an empty rocky seafloor', 'underwater rocks and sediment', 'a hydrothermal vent chimney'],
    'blank': ['a black screen', 'dark empty water', 'a blurry out of focus image'],
}
# ---- BioCLIP: which organism group ----
BIO_CLASSES = {
    'fish': ['Actinopterygii ray-finned fish', 'Elasmobranchii shark or ray', 'a fish'],
    'seaslug': ['Nudibranchia nudibranch sea slug', 'Aplysiida sea hare', 'a sea slug'],
    'cephalopod': ['Cephalopoda octopus', 'Cephalopoda squid', 'Sepiida cuttlefish'],
    'gelatinous': ['Scyphozoa jellyfish', 'Siphonophorae siphonophore', 'Ctenophora comb jelly',
                   'Hydrozoa hydromedusa', 'Thaliacea salp'],
    'coral-anemone': ['Anthozoa coral', 'Actiniaria sea anemone', 'Alcyonacea soft coral', 'Pennatulacea sea pen'],
    'crustacean': ['Brachyura crab', 'Caridea shrimp', 'Galatheoidea squat lobster', 'Copepoda copepod', 'Amphipoda amphipod'],
    'echinoderm': ['Asteroidea sea star', 'Ophiuroidea brittle star', 'Echinoidea sea urchin',
                   'Holothuroidea sea cucumber', 'Crinoidea feather star'],
    'worm': ['Polychaeta bristle worm', 'Annelida segmented worm', 'Nemertea ribbon worm', 'Platyhelminthes flatworm'],
    'sponge': ['Porifera sponge', 'Hexactinellida glass sponge'],
    'mollusc-other': ['Gastropoda sea snail', 'Bivalvia clam', 'Polyplacophora chiton'],
    'tunicate': ['Ascidiacea sea squirt', 'Pyrosomatida pyrosome', 'Appendicularia larvacean'],
    'marine-mammal': ['Cetacea whale', 'Delphinidae dolphin', 'Pinnipedia seal'],
    'sea-turtle': ['Cheloniidae sea turtle'],
    'bird': ['Aves bird'],
    'insect-spider': ['Insecta insect', 'Arachnida spider'],
    'land-vertebrate': ['Mammalia mammal', 'Squamata lizard', 'Amphibia frog'],
    'fungi': ['Agaricales mushroom', 'Myxomycetes slime mold'],
    'plant': ['Magnoliopsida flowering plant', 'Tracheophyta plant', 'Zosteraceae seagrass'],
    'algae': ['Phaeophyceae kelp seaweed', 'Rhodophyta red algae', 'Chlorophyta green algae'],
    'protist': ['Bacillariophyceae diatom', 'Radiolaria radiolarian', 'Foraminifera foraminiferan', 'Dinoflagellata dinoflagellate'],
    'human': ['Homo sapiens human'],
}


def load_json(p, dflt):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return dflt


def write_json_atomic(p, obj):
    tmp = Path(str(p) + f'.tmp-{os.getpid()}')
    tmp.write_text(json.dumps(obj, separators=(',', ':')), encoding='utf-8')
    os.replace(tmp, p)


# ---------- frames ----------
def n_frames(dur):
    return int(min(16, max(6, math.ceil((dur or 0) / 10))))


def save_thumb(img, dest):
    from PIL import Image
    w, h = img.size
    if w > THUMB_W:
        img = img.resize((THUMB_W, max(1, round(h * THUMB_W / w))), Image.BILINEAR)
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.convert('RGB').save(dest, 'JPEG', quality=80)


def video_frames(src, fi, outdir, rel):
    """Evenly spaced frames; returns (duration, [(t, relpath)])."""
    import cv2
    from PIL import Image
    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        return 0, []
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    cnt = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    dur = cnt / fps if fps > 0 else 0
    n = n_frames(dur)
    out = []
    for k in range(n):
        t = (k + 0.5) / n * dur if dur else 0
        dest = outdir / f'{fi}_{k}.jpg'
        if not dest.exists():
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ok, frame = cap.read()
            if not ok:
                continue
            save_thumb(Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)), dest)
        out.append((round(t, 2), f'{rel}/{fi}_{k}.jpg'))
    cap.release()
    return round(dur, 2), out


def post_frames(row):
    from PIL import Image
    author, pid = row.get('author') or '_', row['id']
    outdir = FRAMES / author / pid
    rel = f'igclass_frames/{author}/{pid}'
    frames, durs = [], []
    for fi, name in enumerate(row.get('localFiles') or []):
        src = MEDIA / name
        if not src.exists():
            durs.append(None)
            continue
        if src.suffix.lower() in VID_EXT:
            d, fr = video_frames(src, fi, outdir, rel)
            durs.append(d)
            frames += [{'src': r, 't': t, 'fi': fi} for t, r in fr]
        else:
            dest = outdir / f'{fi}_0.jpg'
            try:
                if not dest.exists():
                    with Image.open(src) as im:
                        save_thumb(im, dest)
                frames.append({'src': f'{rel}/{fi}_0.jpg', 't': None, 'fi': fi})
            except Exception as e:
                print(f'  ! {pid} {name}: {e}', file=sys.stderr)
            durs.append(0)
    return frames, durs


# ---------- models ----------
def load_model(name, pretrained):
    import open_clip, torch
    if name.startswith('hf-hub:'):
        model, _, pre = open_clip.create_model_and_transforms(name)
        tok = open_clip.get_tokenizer(name)
    else:
        model, _, pre = open_clip.create_model_and_transforms(name, pretrained=pretrained)
        tok = open_clip.get_tokenizer(name)
    model.eval()
    return model, pre, tok


def class_text(model, tok, classes):
    import torch
    keys = list(classes)
    with torch.no_grad():
        mats = []
        for k in keys:
            e = model.encode_text(tok(classes[k]))
            e = e / e.norm(dim=-1, keepdim=True)
            m = e.mean(0)
            mats.append(m / m.norm())
        return keys, torch.stack(mats)


def encode_images(model, pre, paths, bs=32):
    import torch
    from PIL import Image
    feats = []
    with torch.no_grad():
        for i in range(0, len(paths), bs):
            ims = [pre(Image.open(ROOT / p).convert('RGB')) for p in paths[i:i + bs]]
            f = model.encode_image(torch.stack(ims))
            feats.append(f / f.norm(dim=-1, keepdim=True))
    return torch.cat(feats) if feats else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--author', default='')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--frames-only', action='store_true')
    a = ap.parse_args()
    authors = [s.strip() for s in a.author.split(',') if s.strip()]
    if not a.all and not authors:
        sys.exit('usage: python igclip.py --author <a[,b]> | --all [--limit N] [--frames-only]')

    t0 = time.time()
    rows = [r for r in json.loads(IG.read_text(encoding='utf-8')) if a.all or r.get('author') in authors]
    if a.limit:
        rows = rows[:a.limit]
    print(f'{len(rows)} posts · ig.json read in {time.time() - t0:.1f}s', flush=True)

    # 1. frames — one post per worker process (cv2 seeking is the slow part)
    from concurrent.futures import ProcessPoolExecutor
    t1 = time.time()
    per = {}
    with ProcessPoolExecutor(max_workers=max(1, (os.cpu_count() or 8) // 2)) as ex:
        for i, (r, (fr, durs)) in enumerate(zip(rows, ex.map(post_frames, rows, chunksize=4))):
            per[r['id']] = {'frames': fr, 'durs': durs}
            if (i + 1) % 200 == 0:
                print(f'  frames {i + 1}/{len(rows)} · {time.time() - t1:.0f}s', flush=True)
    nfr = sum(len(v['frames']) for v in per.values())
    print(f'frames: {nfr} for {len(rows)} posts in {time.time() - t1:.1f}s', flush=True)

    out = load_json(OUT, {'_meta': {}, 'rows': {}})
    if not a.frames_only and nfr:
        import torch, numpy as np
        torch.set_num_threads(max(1, (os.cpu_count() or 8) // 2))
        paths = [f['src'] for v in per.values() for f in v['frames']]
        owners = [(pid, j) for pid, v in per.items() for j in range(len(v['frames']))]
        EMB.mkdir(exist_ok=True)
        tag = ('all' if a.all else '+'.join(authors)) + (f'.limit{a.limit}' if a.limit else '')
        def run(key, name, pre_name, classes, frame_paths):
            t2 = time.time()
            model, pre, tok = load_model(name, pre_name)
            keys, txt = class_text(model, tok, classes)
            print(f'{key}: model ready in {time.time() - t2:.0f}s, encoding {len(frame_paths)} frames…', flush=True)
            t3 = time.time()
            img = encode_images(model, pre, frame_paths)
            probs = (100.0 * img @ txt.T).softmax(dim=-1).numpy()
            np.save(EMB / f'{key}.{tag}.npy', img.numpy().astype('float16'))
            (EMB / f'{key}.{tag}.frames.json').write_text(json.dumps(frame_paths), encoding='utf-8')
            print(f'{key}: {len(frame_paths) / max(0.1, time.time() - t3):.1f} frames/s', flush=True)
            return keys, probs

        # 2. CLIP on every frame
        ck, cp = run('clip', 'ViT-B-32', 'laion2b_s34b_b79k', CLIP_CLASSES, paths)
        want = {'sea-animal', 'land-animal', 'bird', 'plant', 'mushroom', 'microscope', 'diver'}
        want_i = [ck.index(k) for k in want]
        for idx, (pid, j) in enumerate(owners):
            ci = int(cp[idx].argmax())
            per[pid]['frames'][j].update(c=ck[ci], cp=round(float(cp[idx][ci]), 3))
        # 3. BioCLIP only where CLIP sees something alive: up to 6 frames per post, most
        #    animal-like first. A post with none gets no organism guess (bio.on = 0).
        bio_idx, start = [], 0
        for pid, v in per.items():
            n = len(v['frames'])
            live = [start + i for i in range(n) if v['frames'][i]['c'] in want]
            live.sort(key=lambda g: -float(cp[g][want_i].sum()))
            bio_idx += sorted(live[:6])
            start += n
        bk, bp = (run('bio', 'hf-hub:imageomics/bioclip', None, BIO_CLASSES, [paths[g] for g in bio_idx])
                  if bio_idx else (list(BIO_CLASSES), None))
        bio_at = {g: k for k, g in enumerate(bio_idx)}
        for g, (pid, j) in enumerate(owners):
            if g in bio_at:
                row = bp[bio_at[g]]
                bi = int(row.argmax())
                per[pid]['frames'][j].update(b=bk[bi], bp=round(float(row[bi]), 3))
        # per-post aggregates (frames are contiguous per post, in `per` order)
        start = 0
        for pid, v in per.items():
            n = len(v['frames'])
            if n:
                c = cp[start:start + n]
                tops = [f['c'] for f in v['frames']]
                v['clipFrac'] = {k: round(tops.count(k) / n, 3) for k in set(tops)}
                v['clipMax'] = {k: round(float(c[:, i].max()), 3) for i, k in enumerate(ck) if c[:, i].max() >= 0.05}
                rows_b = [bp[bio_at[g]] for g in range(start, start + n) if g in bio_at]
                if rows_b:
                    dist = np.mean(rows_b, axis=0)
                    v['bio'] = {'top': bk[int(dist.argmax())], 'p': round(float(dist.max()), 3), 'on': len(rows_b),
                                'dist': {k: round(float(dist[i]), 3) for i, k in enumerate(bk) if dist[i] >= 0.05}}
                else:
                    v['bio'] = {'top': None, 'p': 0, 'on': 0, 'dist': {}}
            start += n
            v['at'] = time.strftime('%Y-%m-%d %H:%M:%S')
            out['rows'][pid] = v
    else:
        for pid, v in per.items():
            prev = out['rows'].get(pid, {})
            prev.update(v)
            out['rows'][pid] = prev
    out['_meta'] = {'models': {'clip': 'ViT-B-32/laion2b_s34b_b79k', 'bio': 'imageomics/bioclip'},
                    'updated': time.strftime('%Y-%m-%d %H:%M:%S'), 'rows': len(out['rows'])}
    write_json_atomic(OUT, out)
    print(f'wrote igclass.clip.json ({len(out["rows"])} rows) · total {time.time() - t0:.0f}s', flush=True)


if __name__ == '__main__':
    main()
