// ═══════════════════════════════════════════════════════════════════════════
// cardtypes.js  (dev0875) — flash-card TYPES: what a card is ABOUT.
//
// A flash card has two independent axes, and conflating them was the trap:
//
//   ltype    HOW FAR ALONG it is.  f0 swept → f1 identified → f2 Phil has
//            reviewed and agrees → f3 an expert has reviewed. The ladder is
//            the same whatever the card is about. Lives in core.js
//            (FLASH_LTYPE_RE) and gates the grid renderer.
//
//   cardType WHAT IT EMPHASISES.  'id1' is identification-and-lifecycle: which
//            species is this, what is that judgement resting on, and would I
//            recognise the other sex or a juvenile of the same animal. Later
//            types will emphasise behaviour, habitat, whatever — a new type is
//            an entry in this table, not a code change.
//
// A type owns three things, and NOTHING ELSE knows about them:
//   outputSchema   the JSON the model must return
//   systemPrompt   how it is asked
//   renderSections turning that JSON into the card's two back sections
//
// WHY JSON AND NOT HTML. The obvious design is to have the model write the
// card's HTML directly. Don't: an answer stored as prose can only ever be
// re-rendered by asking again (and paying again), and the tag whitelist becomes
// the model's problem instead of ours. Fields render to HTML here, so restyling
// every card ever made — or changing what this type emphasises — is a re-render
// over the stored `cardData`, free and offline.
//
// THE TAG BUDGET. ftext survives a round trip through Xe only if every tag is
// in BOTH core.js's _sanitizePastedHtml KEEP set AND the xe2.js schema, and
// EVERY ATTRIBUTE IS STRIPPED except a[href] and img[src|alt]. So: no inline
// styles anywhere below. Headings, paragraphs, lists, strong/em, small, links.
// Tables and <details> are technically in the schema, and are still wrong here
// — a card back is read in a grid cell the size of a stamp, and <details> wants
// a tap that the card itself has already claimed for turning over.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── small helpers ────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
  function txt(s) { return String(s == null ? '' : s).trim(); }
  function arr(a) { return Array.isArray(a) ? a : []; }

  // TipTap's default Link mark serialises with these two attributes, so an Xe
  // open + autosave leaves a rendered card byte-identical. Emitting a bare
  // <a href> instead would cost one cosmetic diff on the first save.
  function link(url, label) {
    var u = txt(url);
    if (!/^https?:\/\//i.test(u)) return esc(label || u);
    return '<a href="' + escAttr(u) + '" target="_blank" rel="noopener noreferrer nofollow">'
         + esc(label || u) + '</a>';
  }
  function ul(items) {
    var li = arr(items).map(function (h) { return '<li>' + h + '</li>'; }).join('');
    return li ? '<ul>' + li + '</ul>' : '';
  }
  function sci(name) {
    var n = txt(name);
    // A scientific name is italic; "sp." / "cf." / an authority are not, but
    // splitting that out reliably is more trouble than the typography is worth.
    return n ? '<em>' + esc(n) + '</em>' : '';
  }

  // The Astropecten already in the bucket — a real picture, so a sample card
  // has a real front rather than a broken-image box, and so the RAW dump below
  // is about something you can actually look at.
  var SAMPLE_IMG = 'https://media.sealifeandmore.com/flashimages/card-20260831-071121.jpg';

  // ── the registry ─────────────────────────────────────────────────────────
  var TYPES = {};
  function register(t) { TYPES[t.id] = t; return t; }

  // ═════════════════════════════════════════════════════════════════════════
  // id1 — identification, and the same animal in its other guises
  // ═════════════════════════════════════════════════════════════════════════
  register({
    id: 'id1',
    label: 'Identification',
    blurb: 'Which species, what that rests on, and how the sexes and the '
         + 'juveniles differ from the animal in the picture.',

    // ── what the model must return ────────────────────────────────────────
    // Plain JSON Schema. The wiring step wraps this in whatever envelope
    // output_config.format wants; nothing here should depend on that shape.
    //
    // THE ENUMS EARN THEIR KEEP. "no external difference between the sexes" and
    // "nobody has written this down" are completely different facts and a free
    // -text field renders them both as an empty-looking sentence. A status lets
    // the renderer say which, and lets a later pass filter on it.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scientificName', 'commonName', 'rank', 'confidence',
                 'keyedOn', 'notVisible', 'alternatives',
                 'sexDifferences', 'maturityChanges', 'sources'],
      properties: {
        scientificName: {
          type: 'string',
          description: 'The single best candidate, at the rank given in `rank`. '
            + 'No authority, no date. Empty string only if the subject is not a '
            + 'living organism.'
        },
        commonName: {
          type: 'string',
          description: 'The English common name in general use, or "" if there '
            + 'genuinely is not one. Do not invent one by translating the Latin.'
        },
        rank: {
          type: 'string',
          enum: ['species', 'genus', 'family', 'higher', 'unknown'],
          description: 'How far the VISIBLE EVIDENCE actually carries. Answering '
            + '"genus" is a correct answer, not a failed one.'
        },
        confidence: {
          type: 'string',
          enum: ['high', 'moderate', 'low'],
          description: 'Confidence in the name at the stated rank.'
        },
        keyedOn: {
          type: 'array',
          minItems: 1, maxItems: 6,
          description: 'The visible features the identification rests on, most '
            + 'diagnostic first.',
          items: {
            type: 'object', additionalProperties: false,
            required: ['feature', 'observation'],
            properties: {
              feature: { type: 'string', description: 'The structure, e.g. "cerata", "dorsal fin", "rhinophores".' },
              observation: { type: 'string', description: 'What is actually visible about it in THIS image, specifically. "in 5-7 distinct clusters, each opaque-white tipped" — not "orange".' }
            }
          }
        },
        notVisible: {
          type: 'array', maxItems: 5,
          items: { type: 'string' },
          description: 'Diagnostic features this shot does NOT show, i.e. the '
            + 'honest limit on the identification, and what a better photograph '
            + 'would need to capture. Empty array only if the image really does '
            + 'show everything needed.'
        },
        alternatives: {
          type: 'array', maxItems: 3,
          description: 'Realistic confusions — what else this could plausibly be.',
          items: {
            type: 'object', additionalProperties: false,
            required: ['name', 'howToTell'],
            properties: {
              name: { type: 'string' },
              howToTell: { type: 'string', description: 'The character that separates it from the first candidate, phrased as something checkable in a better photograph.' }
            }
          }
        },
        sexDifferences: {
          type: 'object', additionalProperties: false,
          required: ['status', 'text'],
          properties: {
            status: {
              type: 'string',
              enum: ['dimorphic', 'none-external', 'hermaphrodite', 'unknown'],
              description: 'dimorphic = males and females are externally tellable. '
                + 'none-external = they are not, and that is established. '
                + 'hermaphrodite = the question does not apply in the usual way. '
                + 'unknown = the sources found do not say.'
            },
            text: {
              type: 'string',
              description: 'For "dimorphic": how to tell them apart, and which '
                + 'the animal in the picture most likely is if that is readable. '
                + 'Otherwise one short sentence of context. Never empty.'
            }
          }
        },
        maturityChanges: {
          type: 'object', additionalProperties: false,
          required: ['status', 'text'],
          properties: {
            status: {
              type: 'string',
              enum: ['changes', 'little-change', 'unknown'],
              description: 'changes = a juvenile looks meaningfully different. '
                + 'little-change = it does not, beyond size. '
                + 'unknown = the sources found do not say.'
            },
            text: {
              type: 'string',
              description: 'What changes and at roughly what size or stage, and '
                + 'where in that range the animal pictured sits if that is '
                + 'readable. Never empty.'
            }
          }
        },
        sources: {
          type: 'array', minItems: 0, maxItems: 6,
          items: {
            type: 'object', additionalProperties: false,
            required: ['title', 'url'],
            properties: { title: { type: 'string' }, url: { type: 'string' } }
          },
          description: 'Only pages that actually came back from a search this '
            + 'turn. Never construct a plausible-looking URL.'
        }
      }
    },

    // ── how it is asked ───────────────────────────────────────────────────
    systemPrompt: [
      'You identify organisms in photographs and video frames, for a marine and',
      'natural-history study deck. Each image was taken by the user themselves.',
      '',
      'WHAT YOU CAN AND CANNOT DO HERE.',
      'You have web search. You do NOT have reverse image search: you cannot find',
      'this photograph anywhere, because it has never been published. There is no',
      'caption, no filename and no label to read — the image is the whole of the',
      'visual evidence. So the order of work is: look first and decide what the',
      'animal shows, then search to test that reading and to gather the facts.',
      'Never let a search result talk you into a feature you cannot actually see.',
      '',
      'RANK HONESTLY. Give the most specific taxon the VISIBLE evidence supports,',
      'and say in `rank` what that is. A great many animals cannot be taken to',
      'species from one photograph, and "genus" or "family" is then the correct',
      'answer. A confident species name that the picture does not support is the',
      'single worst thing you can return here: it is not merely wrong, it teaches',
      'the user something false and they have no way to notice.',
      '',
      'SHOW YOUR WORKING. `keyedOn` is what the identification actually rests on —',
      'name the structure and say what is visible about it in this specific image.',
      '"Orange, with frilly bits" is worthless; "cerata in 5-7 distinct clusters,',
      'each with an opaque white tip, rhinophores annulate" is the answer. Put the',
      'most diagnostic observation first.',
      '',
      '`notVisible` is the other half of that and matters just as much: the',
      'diagnostic characters this shot does not show. It is what tells the reader',
      'how far to trust the name, and what to photograph next time. Ask yourself',
      'what would rule this identification out, and whether the image could show it.',
      '',
      'DO NOT EXPLAIN AWAY WHAT YOU CAN SEE. An animal that looks washed out,',
      'patchy, or unlike the field-guide plate is more often at a real stage of',
      'its life than badly photographed. Sex change, breeding and seasonal colour,',
      'moult, and the intermediates between juvenile and adult all produce animals',
      'that match no plate — and those intermediates are exactly what the user',
      'cannot look up, so they are the most valuable thing a card can carry. Reach',
      'for the biology before you reach for the lighting. If you do conclude the',
      'image is at fault, say so in `notVisible`, where it can be argued with,',
      'rather than burying it in the identification as a confident aside.',
      '',
      'A PATTERN YOU CANNOT SEE WELL IS NOT A PATTERN THAT IS ABSENT. "Plain" is',
      'the weakest character a photograph offers and the easiest to get wrong:',
      'saddles, bars, spots and blotches wash out with distance, glare, turbid',
      'water, a blue-green depth cast, motion blur, or the animal simply being',
      'small in frame. Before you exclude a patterned species BECAUSE the animal',
      'looks plain, read the body at low contrast — faint repeated shapes along',
      'the back and flanks — and ask whether this shot could have shown the',
      'markings at all. If it could not, plainness rules nothing out: that belongs',
      'in `notVisible`, never in `keyedOn`. (A leopard shark was once carded as a',
      'soupfin shark on exactly this mistake, with "plain from nose to tail" given',
      'as the reason the leopard shark was ruled out. The saddles were there, faint.)',
      '',
      'THE TWO LIFECYCLE FIELDS ARE THE POINT OF THIS CARD, not an afterthought.',
      'The user can already look at the animal in front of them; what they cannot',
      'do is recognise the same species as the other sex, or as a juvenile. Search',
      'for these specifically — they are rarely in a top-line species description',
      'and usually sit in a full species account, a field guide or a monograph.',
      'Use the status enums exactly as defined. "No external difference between',
      'the sexes" is a real and useful finding; report it as none-external rather',
      'than dressing it up. Only use unknown when you searched and the answer was',
      'not there, and say so plainly in the text.',
      '',
      'SOURCES. Cite only pages that came back from a search on this turn. Never',
      'construct a URL that looks right. Prefer species accounts, museum and',
      'institutional pages, regional field guides and monographs over aggregators.',
      'Zero sources is an acceptable and honest answer; a fabricated one is not.',
      '',
      'IF IT IS NOT AN ORGANISM, or the image is too poor to work from, set rank to',
      '"unknown", confidence to "low", and use notVisible to say what defeated you.',
      'Do not guess to fill the schema.',
      '',
      'FIELD TEXT IS PLAIN TEXT. No HTML, no markdown, no bullet characters, no',
      'bracketed citation markers. Write in short, flat, factual sentences — this',
      'is read off a card the size of a playing card, not off a page.',
      '',
      'AMERICAN SPELLING throughout: color, behavior, gray, recognize, meter.',
      '',
      'WHO EACH FIELD IS FOR. `scientificName`, `commonName`, `keyedOn`,',
      '`sexDifferences` and `maturityChanges` are for the READER. `confidence`,',
      '`notVisible`, `agreement` and `alternatives` are for the REVIEWER — they',
      'are how someone later judges whether to trust the card, and the renderer',
      'hides them from the finished slide. Write them for that reader: candid',
      'about what defeated you. Do not soften them because they might be seen, and',
      'do not smuggle their content into the reader-facing fields either.'
    ].join('\n'),

    // The per-image turn. `locationHint` is optional and, when it exists, is
    // worth more than any other single input — most identifications are settled
    // by range long before they are settled by morphology.
    userPrompt: function (opts) {
      var o = opts || {};
      var lines = ['Identify the organism in this image.'];
      if (txt(o.locationHint)) lines.push('Where it was taken: ' + txt(o.locationHint) + '.');
      if (txt(o.dateHint))     lines.push('When: ' + txt(o.dateHint) + '.');
      if (txt(o.note))         lines.push('The user adds: ' + txt(o.note));
      return lines.join('\n');
    },

    // ── JSON → the card's two back sections ───────────────────────────────
    // body = section 2, the tap-to-turn face. It is read in a grid cell, so it
    //        gets the answer and nothing else: name, how sure, what on.
    // orig = section 3, the swipe face. The full workup.
    //
    // `agreement` is filled in by the CALLER, not the model — it is the record
    // of whether two independent passes landed on the same name, which is worth
    // more than any model's own confidence, because that is a self-report and
    // this is an observation.
    renderSections: function (d) {
      d = d || {};
      var name = sci(d.scientificName);
      var common = txt(d.commonName);
      var rank = txt(d.rank) || 'unknown';
      var conf = txt(d.confidence) || 'low';

      // "moderate · both passes agreed"
      var a = d.agreement;
      var agreeBit = '';
      if (a && a.passes > 1) {
        agreeBit = a.agreed
          ? ' · ' + a.passes + ' passes agreed'
          : ' · passes DISAGREED' + (arr(a.others).length ? ' (' + esc(arr(a.others).join(', ')) + ')' : '');
      }

      var heading = name || '<em>unidentified</em>';
      var rankBit = (rank && rank !== 'species')
        ? '<p><small>' + esc(rank) + '-level — the picture will not carry it further</small></p>' : '';

      // ── section 2 ──
      // (dev0885) The confidence readout is a reviewer's line, not a reader's —
      // same rule as notVisible above.
      var body = '<h4>' + heading + '</h4>'
        + (common ? '<p>' + esc(common) + '</p>' : '')
        + rankBit
        + '<div class="te-cut"><p><strong>' + esc(conf) + '</strong>' + agreeBit + '</p></div>';
      // FEATURE NAMES ONLY on the turn face. The first draft put the full
      // observations here and the card back became a paragraph — which the
      // shrink-to-fit panel then rendered at 7pt in a grid cell, i.e. unread.
      // "cerata · rhinophores · oral tentacles" tells you what the call rests
      // on; the swipe face says what was actually seen.
      var k0 = arr(d.keyedOn).slice(0, 3).map(function (k) { return txt(k.feature); }).filter(Boolean);
      if (k0.length) body += '<p><small>keyed on ' + esc(k0.join(' · ')) + '</small></p>';

      // ── section 3 ──
      var orig = '<h4>' + heading + (common ? ' · ' + esc(common) : '') + '</h4>'
        + '<p><strong>Confidence</strong> ' + esc(conf)
        + (rank === 'unknown' ? ' — not identified' : ' at ' + esc(rank) + ' level')
        + agreeBit + '</p>';

      var keyed = arr(d.keyedOn).map(function (k) {
        return '<strong>' + esc(txt(k.feature)) + '</strong> — ' + esc(txt(k.observation));
      });
      if (keyed.length) orig += '<h5>Keyed on</h5>' + ul(keyed);

      // (dev0885) BETWEEN US, NOT ON THE SLIDE. What the picture could not
      // settle is how a reviewer judges the card; to a reader it is a list of
      // things they were not told. Kept in the row, wrapped in the teCut every
      // render context hides.
      var nv = arr(d.notVisible).map(esc);
      if (nv.length) orig += '<div class="te-cut"><h5>Not visible in this shot</h5>' + ul(nv) + '</div>';

      var alts = arr(d.alternatives).map(function (x) {
        return sci(x.name) + ' — ' + esc(txt(x.howToTell));
      });
      if (alts.length) orig += '<h5>Could also be</h5>' + ul(alts);

      orig += '<h5>Male / female</h5><p>' + statusLine(d.sexDifferences, SEX_LEAD) + '</p>';
      orig += '<h5>With maturity</h5><p>' + statusLine(d.maturityChanges, MAT_LEAD) + '</p>';

      var srcs = arr(d.sources)
        .filter(function (s) { return /^https?:\/\//i.test(txt(s.url)); })
        .map(function (s) { return link(s.url, txt(s.title) || s.url); });
      if (srcs.length) orig += '<h5>Sources</h5>' + ul(srcs);

      return { body: body, orig: orig };
    },

    // A LAYOUT FIXTURE, NOT A REAL IDENTIFICATION. Every word of this was
    // written by hand to give the renderer realistic shapes to survive — a
    // hermaphrodite so the sex field has to handle "the question does not
    // apply", a microscope caveat, a genus-level fallback. Nothing here was
    // searched and the biology is not vouched for; the example.org URLs are
    // placeholders and say so. Do not calibrate anything on it. sampleRaw()
    // below is the real research output.
    sample: function () {
      return {
        scientificName: 'Flabellina verrucosa',
        commonName: 'red-gilled nudibranch',
        rank: 'species',
        confidence: 'moderate',
        agreement: { passes: 2, agreed: true, others: [] },
        keyedOn: [
          { feature: 'cerata', observation: 'in 6 distinct clusters along each side, each ceras opaque white at the tip over a red-brown digestive gland' },
          { feature: 'rhinophores', observation: 'distinctly annulate — ringed, not smooth or papillate' },
          { feature: 'oral tentacles', observation: 'long and slender, roughly as long as the rhinophores' }
        ],
        notVisible: [
          'the foot corners, which are angled rather than rounded in this genus',
          'the radula, which separates the harder Flabellina pairs and needs a microscope regardless'
        ],
        alternatives: [
          { name: 'Coryphella nobilis', howToTell: 'cerata evenly spaced rather than in discrete clusters, and rhinophores smooth' },
          { name: 'Flabellina pedata', howToTell: 'body distinctly violet rather than translucent white; a colour difference a photograph settles at once' }
        ],
        sexDifferences: {
          status: 'hermaphrodite',
          text: 'Simultaneous hermaphrodite, like all nudibranchs — every adult carries both sets of organs and there is nothing external to sex. Pairs align right side to right side to mate, and both may lay.'
        },
        maturityChanges: {
          status: 'changes',
          text: 'Juveniles under about 8 mm carry far fewer ceratal clusters — often only two or three — and the white ceratal tips have not yet developed, so a young animal reads as a plain translucent slug. Adults reach roughly 35 mm.'
        },
        sources: [
          { title: 'Sea Slug Forum — Flabellina verrucosa', url: 'https://example.org/seaslugforum/flabellina-verrucosa' },
          { title: 'Marine Species Identification Portal', url: 'https://example.org/msip/flabellina' }
        ]
      };
    },

    // The RAW research dump for this type — what comes back before anything
    // formats it. Unlike sample() above, this one is real. See ID1_RAW.
    sampleRaw: function () { return ID1_RAW; }
  });

  // ── the RAW stage ────────────────────────────────────────────────────────
  // What the research step produces BEFORE anything formats it. Phil is the
  // intermediary for the early cards: he wants to see the dump, cut it down by
  // hand, and let the shape he arrives at drive what the schema and the
  // renderer should be. So this is deliberately unstructured — paragraphs and
  // nothing else. Any heading or styling here would be the formatting decision
  // being made for him, which is the one thing this stage must not do.
  //
  // The two-section convention is MakeCard's, unchanged and exactly on point:
  // section 2 is the copy you cut down, section 3 is the untouched original.
  //
  // THE TEXT BELOW IS A REAL RESEARCH PASS on the sea-star image already in the
  // bucket, run 2026-09-02 with the single hint "this is a sea star" and no
  // locality. It is not invented — unlike the id1 sample(), which is a layout
  // fixture and was never searched.
  var ID1_RAW = [
    'SUBJECT: sea star (hint supplied by user). Aboral view, lying on open sand.',

    'BEST GUESS: Astropecten sp. Genus is secure. Species is NOT determinable '
    + 'from this image, and the reason is worth stating rather than hiding behind '
    + 'a low confidence score.',

    'WHY THE GENUS. The marginal plates are large and plainly visible from above, '
    + 'running as a paired fringe down each arm edge, the upper (superomarginal) '
    + 'series carrying upward-pointing spines and the lower (inferomarginal) series '
    + 'downward-pointing ones. This is the character that separates Astropecten from '
    + 'Luidia, the other genus of pale five-armed sand stars: in Luidia the upper '
    + 'marginal plates are replaced by paxillae and are not visible from the top at '
    + 'all. It is a character a photograph can settle, which is rare and useful. '
    + 'Supporting it: the arms show the fine reticulate mosaic of paxillae — short '
    + 'pillar-like ossicles crowned with spinelets, which keep sediment off the '
    + 'papulae in a burrowing star — and the overall form is right, a small disc with '
    + 'five long tapering arms. Tube feet in this group are pointed and lack suckers; '
    + 'not resolvable in this frame, but consistent with everything else.',

    'WHY NOT THE SPECIES. Astropecten is a large genus and the characters that '
    + 'separate its species are: whether the superomarginal plates carry spines at '
    + 'all or are merely covered in granules; if spined, whether each plate bears one '
    + 'strong spine and how those spines change in size along the arm; whether the '
    + 'inferomarginal plates are densely covered in overlapping squamules or nearly '
    + 'bare; the number and relative length of the inferomarginal fringe spines; and '
    + 'the disc-to-arm proportion together with aboral colour. Several of those need '
    + 'a closer or oblique view than this frame gives. All of them need to be judged '
    + 'against the species list for a known locality.',

    'WHAT A LOCALITY WOULD BUY. This is the whole gate. Eastern Pacific, San Pedro '
    + 'Bay south to Ecuador: A. armatus is the common large sand star — five slender '
    + 'pointed arms turned up slightly at the tips, to about 17 cm across, small disc, '
    + 'madreporite sitting very close to the disc edge, upper surface yellowish brown, '
    + 'dull pink or grey, underside pale yellow to ivory, on sand or soft gravel from '
    + '5 to 115 m and often half-buried. Western Atlantic and Caribbean: A. duplicatus '
    + 'and several congeners. Mediterranean: a well-worked fauna with published keys. '
    + 'The same photograph resolves to different answers in different oceans, and '
    + 'nothing in the picture tells you which ocean it is.',

    'NOTE ON THIS INDIVIDUAL. The left side looks like it carries a doubled or '
    + 'regenerating arm. Worth a second look — arm anomalies and regeneration are '
    + 'common in this group and are not a species character, so it should not be read '
    + 'as one.',

    'SOURCES. '
    + 'https://en.wikipedia.org/wiki/Astropecten_armatus ; '
    + 'https://en.wikipedia.org/wiki/Luidia ; '
    + 'https://en.wikipedia.org/wiki/Paxillosida ; '
    + 'https://en.wikipedia.org/wiki/Astropecten_irregularis ; '
    + 'https://tb.plazi.org/GgServer/html/FF6987EEFFA3FFC5FF5443937EC4FD38/1 ; '
    + 'https://www.marinespecies.org/aphia.php?p=taxdetails&id=123059'
  ].join('\n\n');

  // Blank line = paragraph. Nothing else — no headings, no emphasis, no lists.
  // A bare URL is left as text rather than linked: Xs auto-links scheme'd URLs
  // on its own, and a link here would be one more formatting decision taken out
  // of Phil's hands at exactly the stage where he wants them all.
  function rawToHtml(text) {
    return String(text || '').split(/\n{2,}/)
      .map(function (p) { return p.trim(); }).filter(Boolean)
      .map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; })
      .join('\n');
  }

  // Status → the leading sentence. This is where "we looked and there is
  // nothing" stops reading like "we did not look".
  var SEX_LEAD = {
    'dimorphic':     '',
    'none-external': 'No external difference — this species cannot be sexed from a photograph. ',
    'hermaphrodite': '',
    'unknown':       'Not found in the sources searched. '
  };
  var MAT_LEAD = {
    'changes':       '',
    'little-change': 'Little change beyond size. ',
    'unknown':       'Not found in the sources searched. '
  };
  function statusLine(o, leads) {
    o = o || {};
    var lead = leads[txt(o.status)] || '';
    var t = txt(o.text);
    return (esc(lead) + esc(t)).trim() || '<small>—</small>';
  }

  // ═════════════════════════════════════════════════════════════════════════
  // public surface
  // ═════════════════════════════════════════════════════════════════════════

  // The picture half of a flash card's ftext. ONE definition, shared by the
  // sweep (which writes an f0 with this and nothing else) and by the renderer
  // below. Carries inline styles, and is allowed to: xe2.js has a StyledImage
  // schema node precisely so a centred, capped image survives an Xe save. The
  // prose sections have no such node and so carry no styles at all.
  function pictureSection(imgUrl) {
    return '<p style="text-align:center;margin:0 0 10px 0;">'
         + '<img src="' + escAttr(imgUrl) + '" alt="" '
         + 'style="max-width:100%;max-height:82vh;height:auto;border-radius:8px;">'
         + '</p>';
  }

  // picture <hr> turn-face <hr> swipe-face — the three sections grid.js splits
  // on, in the order makecard.js established.
  function renderFtext(imgUrl, typeId, cardData) {
    var t = TYPES[typeId];
    if (!t) throw new Error('unknown cardType: ' + typeId);
    var s = t.renderSections(cardData);
    return pictureSection(imgUrl) + '\n<hr>\n' + s.body + '\n<hr>\n' + s.orig;
  }

  window.CardTypes = {
    DEFAULT: 'id1',
    get: function (id) { return TYPES[id] || null; },
    list: function () {
      return Object.keys(TYPES).map(function (k) {
        return { id: k, label: TYPES[k].label, blurb: TYPES[k].blurb };
      });
    },
    pictureSection: pictureSection,
    renderFtext: renderFtext,
    rawToHtml: rawToHtml,
    // The unformatted twin of renderFtext. Both back sections get the same raw
    // text, which is MakeCard's convention working exactly as intended: cut
    // section 2 down by hand, keep section 3 as the untouched original.
    rawFtext: function (typeId, imgUrl) {
      var id = typeId || 'id1';
      var t = TYPES[id];
      if (!t) throw new Error('unknown cardType: ' + id);
      if (typeof t.sampleRaw !== 'function') throw new Error('cardType ' + id + ' has no raw sample');
      var html = rawToHtml(t.sampleRaw());
      return pictureSection(imgUrl || SAMPLE_IMG) + '\n<hr>\n' + html + '\n<hr>\n' + html;
    },
    // Eyeball the layout with no API and no network:
    //   copy(CardTypes.sampleFtext())   → paste into a scratch row's ftext in Xe
    sampleFtext: function (typeId, imgUrl) {
      var id = typeId || 'id1';
      var t = TYPES[id];
      if (!t) throw new Error('unknown cardType: ' + id);
      return renderFtext(imgUrl || SAMPLE_IMG, id, t.sample());
    }
  };
})();
