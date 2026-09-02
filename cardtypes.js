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
      'is read off a card the size of a playing card, not off a page.'
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
      var body = '<h4>' + heading + '</h4>'
        + (common ? '<p>' + esc(common) + '</p>' : '')
        + rankBit
        + '<p><strong>' + esc(conf) + '</strong>' + agreeBit + '</p>';
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

      var nv = arr(d.notVisible).map(esc);
      if (nv.length) orig += '<h5>Not visible in this shot</h5>' + ul(nv);

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

    // A realistic answer, so the renderer can be eyeballed before a single API
    // call is made. Deliberately a card with a caveat on it rather than a clean
    // one — the awkward shapes are what the layout has to survive.
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
    }
  });

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
    // Eyeball the layout with no API and no network:
    //   copy(CardTypes.sampleFtext())   → paste into a scratch row's ftext in Xe
    sampleFtext: function (typeId, imgUrl) {
      var id = typeId || 'id1';
      var t = TYPES[id];
      if (!t) throw new Error('unknown cardType: ' + id);
      return renderFtext(imgUrl || 'https://media.sealifeandmore.com/flashimages/card-20260831-071121.jpg',
                         id, t.sample());
    }
  };
})();
