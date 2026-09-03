// ═══════════════════════════════════════════════════════════════════════════
// cardtypes.js  (dev0875, relaid dev0903) — flash-card TYPES: what a card is ABOUT.
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
//   renderSections turning that JSON into the card's back sections, IN ORDER
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
// styles anywhere below (the picture section is the one exception and has its
// own schema node). Headings, paragraphs, lists, strong/em, small, links,
// details/summary. Tables are in the schema and are still wrong here.
//
// <details> IS THE FORMAT, not a hazard. (It read as a prohibition in the
// original of this comment, written when a card back was ONE grid-cell face.)
// Every top-level item in sections 3 through 9 is a collapsible whose
// <summary> CARRIES THE POINT — collapsed, the summary is all you see, so a
// face reads as a list of claims you can open. A collapsible always ships
// CLOSED: `open` is read from HTML and never written back (dev0883).
//
// ── THE SECTION LADDER (dev0903) ────────────────────────────────────────────
// A card is ftext split on top-level <hr>. Every section is a FACE in G (swipe
// steps forward, the last returns to the picture) and a PAGE in the reader.
// An empty section is dropped, so a card has as many faces as it has content.
//
//   1  picture             the front
//   2  ID                  name + one or two lines naming what you look at
//   3  telling it apart    what the call rests on, what it is confused with
//   4  worth knowing       the interesting half — description and oddity
//   5  stories             NARRATIVE. long lines, each story its own source
//   6  names               etymology of the common name AND of the binomial
//   7  life                distribution habitat size lifespan breeding diet predators
//   8  in the field        what helps you place it, and its status
//   9  sources             one collapsible, links inside
//
// SECTIONS 2-4 ARE THE FLASH. They are read in a grid cell the size of a
// stamp, and a card should be a flash, not a book. Sections 5-9 are the
// reference half, read in the fullscreen reader, and they are allowed to be
// long — that is the whole point of splitting them off.
//
// ONE LINE IS ONE FACT. Lines get pulled OUT of these cards to build quiz
// questions, so every <p> inside a collapsible has to survive being read on
// its own with nothing around it. A line that only makes sense as the second
// half of the line above it is a broken line here.
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
  function sci(name) {
    var n = txt(name);
    // A scientific name is italic; "sp." / "cf." / an authority are not, but
    // splitting that out reliably is more trouble than the typography is worth.
    return n ? '<em>' + esc(n) + '</em>' : '';
  }
  // Lines. One <p> each, because one line is one fact and a quiz has to be
  // able to lift it out whole.
  function lines(a) {
    return arr(a).map(txt).filter(Boolean)
      .map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('');
  }
  // THE BUILDING BLOCK of every back section: the summary carries the point,
  // an optional <h3> names the thing, then the lines. No lines means no block
  // at all, so a field nobody filled leaves no hollow collapsible behind.
  // `heading` and `tail` arrive as HTML; `point` and `lines` as plain text.
  function block(point, heading, ls, tail) {
    var p = txt(point);
    var body = lines(ls) + (tail || '');
    if (!p || !body) return '';
    return '<details><summary>' + esc(p) + '</summary>'
         + (txt(heading) ? '<h3>' + heading + '</h3>' : '')
         + body + '</details>';
  }
  // A section is its heading plus its blocks — or nothing at all, so the face
  // list never holds a page carrying only a title.
  function section(title, parts) {
    var body = arr(parts).filter(Boolean).join('');
    return body ? '<h2>' + esc(title) + '</h2>' + body : '';
  }

  // The Astropecten already in the bucket — a real picture, so a sample card
  // has a real front rather than a broken-image box, and so the RAW dump below
  // is about something you can actually look at.
  var SAMPLE_IMG = 'https://media.sealifeandmore.com/flashimages/card-20260831-071121.jpg';

  // ── the registry ─────────────────────────────────────────────────────────
  var TYPES = {};
  function register(t) { TYPES[t.id] = t; return t; }

  // Reused schema shapes. `pointBlock` is the collapsible in schema form and
  // turns up half a dozen times below; defining it once keeps the wording of
  // `point` identical everywhere, which is what stops the model writing a
  // summary that carries the point in one field and a bare label in the next.
  function pointBlock(what) {
    return {
      type: 'object', additionalProperties: false,
      required: ['point', 'heading', 'lines'],
      properties: {
        point: {
          type: 'string',
          description: 'The claim itself, as a short sentence. This is the ONLY '
            + 'thing visible while the item is collapsed, so it must carry '
            + what + '. "A copper rockfish is often not copper" — never a bare '
            + 'label like "Color", and never a lead-in like "About its color".'
        },
        heading: {
          type: 'string',
          description: 'Optional short sub-heading naming the structure or idea, '
            + 'or "" for none. Not a repeat of `point`.'
        },
        lines: {
          type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' },
          description: 'Short flat lines, one idea each, almost no punctuation. '
            + 'Each must read correctly ON ITS OWN, out of order and with '
            + 'nothing around it.'
        }
      }
    };
  }
  function dossierField(label, hint) {
    return {
      type: 'object', additionalProperties: false,
      required: ['point', 'lines'],
      properties: {
        point: {
          type: 'string',
          description: 'The collapsed line for ' + label + '. Prefer the most '
            + 'telling fact over the label — "Holds one small patch of reef for '
            + 'years" beats "Where it lives". Fall back to the plain label only '
            + 'when nothing stands out.'
        },
        lines: {
          type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' },
          description: hint + ' One fact per line. Every measurement in BOTH '
            + 'metric and US units, rounded. If the sources searched do not say, '
            + 'return the single line "Not found in the sources searched".'
        }
      }
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // id1 — identification, and the same animal in its other guises
  // ═════════════════════════════════════════════════════════════════════════
  register({
    id: 'id1',
    label: 'Identification',
    blurb: 'Which species, what that rests on, how the sexes and the juveniles '
         + 'differ — then the species in depth: stories, names, life, status.',

    // ── what the model must return ────────────────────────────────────────
    // Plain JSON Schema. The wiring step wraps this in whatever envelope
    // output_config.format wants; nothing here should depend on that shape.
    //
    // THE ENUMS EARN THEIR KEEP. "no external difference between the sexes" and
    // "nobody has written this down" are completely different facts and a free
    // -text field renders them both as an empty-looking sentence. A status lets
    // the renderer say which, and lets a later pass filter on it.
    //
    // (dev0903) THE SCHEMA IS NOW IN TWO HALVES, and the split is the one the
    // section ladder already draws. `scientificName` … `maturityChanges` are
    // about THIS PHOTOGRAPH. `facts` … `conservation` are about THE SPECIES and
    // are identical on every card of it — which is exactly the half TODO.md
    // wants moved into taxoninfo.json later. Keeping them apart in the schema
    // makes that move a change of storage, not a re-authoring.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scientificName', 'commonName', 'rank', 'confidence',
                 'idLines', 'keyedOn', 'notVisible', 'alternatives',
                 'sexDifferences', 'maturityChanges',
                 'facts', 'stories', 'names', 'life', 'fieldNotes',
                 'conservation', 'sources'],
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

        // ── section 2: the flash ──────────────────────────────────────────
        idLines: {
          type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' },
          description: 'The one or two lines that would let someone recognize '
            + 'this animal again, drawn from what is actually visible here. This '
            + 'is the whole of the answer on the turned card, read in a cell the '
            + 'size of a stamp: "Pale stripe along the back two thirds of the '
            + 'lateral line". No hedging and no second clause.'
        },

        // ── section 3: telling it apart ───────────────────────────────────
        keyedOn: {
          type: 'array', minItems: 1, maxItems: 6,
          description: 'The visible features the identification rests on, most '
            + 'diagnostic first, one collapsible each.',
          items: pointBlock('what this feature settles')
        },
        notVisible: {
          type: 'array', maxItems: 5,
          items: { type: 'string' },
          description: 'REVIEWER FIELD. Diagnostic features this shot does NOT '
            + 'show, i.e. the honest limit on the identification, and what a '
            + 'better photograph would need to capture. Empty array only if the '
            + 'image really does show everything needed.'
        },
        alternatives: {
          type: 'array', maxItems: 4,
          description: 'Realistic confusions — what else this could plausibly be.',
          items: {
            type: 'object', additionalProperties: false,
            required: ['point', 'name', 'lines'],
            properties: {
              point: {
                type: 'string',
                description: 'Why this one comes up, as a sentence. "Brown '
                  + 'rockfish is the one it gets confused with".'
              },
              name: { type: 'string', description: 'Scientific name of the confusion.' },
              lines: {
                type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' },
                description: 'The characters that separate it, each phrased as '
                  + 'something checkable in a better photograph.'
              }
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

        // ── section 4: worth knowing ──────────────────────────────────────
        facts: {
          type: 'array', minItems: 3, maxItems: 10,
          description: 'The interesting half. What is odd, memorable or simply '
            + 'good about this animal — the things someone repeats afterwards. '
            + 'Not identification, and not the dossier below.',
          items: pointBlock('the fact itself')
        },

        // ── section 5: stories ────────────────────────────────────────────
        stories: {
          type: 'array', minItems: 0, maxItems: 6,
          description: 'A DIFFERENT KIND OF TEACHING, and the one section not '
            + 'written in short lines. Each is a small true story with a '
            + 'beginning and a point: an episode, a mistake people made and '
            + 'later corrected, a piece of research that changed the picture, an '
            + 'encounter. Titles of the kind wanted: "One diver\'s experience of '
            + 'a garibaldi", "How bat rays were mistakenly considered threats to '
            + 'oyster beds", "How did sea otters help eelgrass". Every story '
            + 'carries its OWN source, and a story you cannot source does not go '
            + 'in at all.',
          items: {
            type: 'object', additionalProperties: false,
            required: ['title', 'lines', 'source'],
            properties: {
              title: {
                type: 'string',
                description: 'The story\'s title, which is also the collapsed '
                  + 'line. Make it the hook, not a summary of the ending.'
              },
              lines: {
                type: 'array', minItems: 2, maxItems: 10, items: { type: 'string' },
                description: 'Full sentences, LONGER than anywhere else on the '
                  + 'card — narrative, not notes. Each still has to stand alone '
                  + 'well enough to be quoted, so no dangling "it" or "this" '
                  + 'reaching back to the sentence before.'
              },
              source: {
                type: 'object', additionalProperties: false,
                required: ['title', 'url'],
                properties: { title: { type: 'string' }, url: { type: 'string' } },
                description: 'The page this story came from. One story, one '
                  + 'source, and it must be a page that actually came back from '
                  + 'a search this turn.'
              }
            }
          }
        },

        // ── section 6: names ──────────────────────────────────────────────
        names: {
          type: 'object', additionalProperties: false,
          required: ['commonEtymology', 'genusMeaning', 'speciesMeaning',
                     'authority', 'family', 'otherNames'],
          properties: {
            commonEtymology: {
              type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' },
              description: 'Where the ENGLISH common name comes from and what it '
                + 'meant — the language, the word, who used it first if that is '
                + 'known. "Garibaldi, for the red shirts worn by Garibaldi\'s '
                + 'followers" is the shape of answer wanted.'
            },
            genusMeaning: {
              type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' },
              description: 'The genus name broken down: root language, the words '
                + 'it is built from, what it describes. "Sebastes, from Greek '
                + 'sebastos, august or venerable".'
            },
            speciesMeaning: {
              type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' },
              description: 'The specific epithet the same way. If it honors a '
                + 'person or a place, say who or where.'
            },
            authority: {
              type: 'string',
              description: 'Describer and year as normally written, e.g. '
                + '"Richardson, 1844". Parentheses if the species was later '
                + 'moved to another genus. "" if not found.'
            },
            family: { type: 'string', description: 'Family, with its English name if it has one.' },
            otherNames: {
              type: 'array', maxItems: 8, items: { type: 'string' },
              description: 'Other names in use: regional names, market names, and '
                + 'any scientific synonym still met in older books. One per line, '
                + 'each saying where the name is used.'
            }
          }
        },

        // ── section 7: life ───────────────────────────────────────────────
        life: {
          type: 'object', additionalProperties: false,
          required: ['distribution', 'habitat', 'size', 'lifespan',
                     'reproduction', 'diet', 'predators'],
          properties: {
            distribution: dossierField('distribution',
              'The range named end to end, plus where it is common as against '
              + 'merely recorded.'),
            habitat: dossierField('habitat',
              'The habitat it keeps to, the depths it is found at, and the '
              + 'conditions it needs.'),
            size: dossierField('size',
              'Maximum and typical size, and weight where it is known. Say which '
              + 'measurement is meant when it matters — total length, disc width, '
              + 'wingspan, shell diameter.'),
            lifespan: dossierField('lifespan',
              'How long it lives, how that is aged, and how old it is at '
              + 'maturity.'),
            reproduction: dossierField('reproduction',
              'How and when it breeds, what the young are like at the start, and '
              + 'any parental care.'),
            diet: dossierField('diet',
              'What it eats, how it takes it, and when it feeds.'),
            predators: dossierField('predators',
              'What eats it, at which stage, and how it defends itself.')
          }
        },

        // ── section 8: in the field ───────────────────────────────────────
        fieldNotes: {
          type: 'array', minItems: 0, maxItems: 8,
          description: 'The specifics that help you PLACE an animal rather than '
            + 'key it out: seasonal and breeding color, how it changes across the '
            + 'range, behavior that gives it away, what it is usually found near, '
            + 'time of day, tide, depth band, the sound it makes. Whatever '
            + 'someone standing in front of it would actually use.',
          items: pointBlock('what it lets you conclude')
        },
        conservation: {
          type: 'object', additionalProperties: false,
          required: ['status', 'lines'],
          properties: {
            status: {
              type: 'string',
              enum: ['not-evaluated', 'data-deficient', 'least-concern',
                     'near-threatened', 'vulnerable', 'endangered',
                     'critically-endangered', 'unknown'],
              description: 'The IUCN global category. Regional and national '
                + 'listings often differ and belong in `lines`, not here.'
            },
            lines: {
              type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' },
              description: 'The year assessed, the trend, the pressures on it, and '
                + 'any regional listing or fishery rule differing from the global '
                + 'category.'
            }
          }
        },

        // ── section 9: sources ────────────────────────────────────────────
        sources: {
          type: 'array', minItems: 0, maxItems: 12,
          items: {
            type: 'object', additionalProperties: false,
            required: ['title', 'url'],
            properties: { title: { type: 'string' }, url: { type: 'string' } }
          },
          description: 'Every page the card rests on that is not already attached '
            + 'to a story. Only pages that actually came back from a search this '
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
      'its life than badly photographed. Sex change, breeding and seasonal color,',
      'molt, and the intermediates between juvenile and adult all produce animals',
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
      'do is recognize the same species as the other sex, or as a juvenile. Search',
      'for these specifically — they are rarely in a top-line species description',
      'and usually sit in a full species account, a field guide or a monograph.',
      'Use the status enums exactly as defined. "No external difference between',
      'the sexes" is a real and useful finding; report it as none-external rather',
      'than dressing it up. Only use unknown when you searched and the answer was',
      'not there, and say so plainly in the text.',
      '',
      '── THE CARD HAS TWO HALVES AND THEY ARE WRITTEN DIFFERENTLY ──',
      '',
      'THE FLASH HALF is `idLines`, `keyedOn`, `alternatives` and `facts`. It is',
      'read on a card the size of a playing card, often in a grid cell the size of',
      'a stamp. Short flat lines, one idea each, almost no punctuation, more lines',
      'rather than longer ones. A flash card should be a FLASH, not a book.',
      '',
      'THE REFERENCE HALF is `stories`, `names`, `life`, `fieldNotes` and',
      '`conservation`. It is read full screen, one page at a time, and it is meant',
      'to be long — that is why it was split off. Do not ration it. A thin',
      'reference half is the commonest way to get this card wrong: what is wanted',
      'is CONSIDERABLY MORE fact per species, in several different forms.',
      '',
      'EVERY COLLAPSIBLE SUMMARY CARRIES ITS OWN POINT. Collapsed, the summary is',
      'the only thing on screen, so the face reads as a list of claims you can',
      'open. "A copper rockfish is often not copper" — not "Color", and not a',
      'lead-in like "About its color". The lines inside then support it.',
      '',
      'ONE LINE IS ONE FACT. Lines are pulled out of these cards to build quiz',
      'questions, so each line has to survive being shown ON ITS OWN, with nothing',
      'around it and in no particular order. No line may open with "it", "this",',
      '"they" or "the same" reaching back to the line above. Name the animal.',
      '',
      'UNITS: ALWAYS BOTH, ALWAYS ROUNDED. Every measurement anywhere on the card',
      'gives metric AND US customary, metric first and the other in parentheses,',
      'both rounded to what is actually known: "to about 66 cm (26 in)", "down to',
      '180 m (600 ft)", "up to 8 kg (18 lb)", "water around 12 C (54 F)". Round the',
      'conversion — 66 cm is 26 inches, not 25.98. Never give a bare metric figure,',
      'and never give a bare imperial one.',
      '',
      'STORIES ARE THE ONE PLACE YOU WRITE PROSE. Each is a small true story with a',
      'beginning and a point — an episode, a mistake people made and later',
      'corrected, a piece of research that changed how the animal is seen, a first',
      'hand encounter. Longer sentences, narrative voice. Each story carries its',
      'OWN source, and a story you cannot source does not go in at all. If you find',
      'no real stories for this species, return an empty list; inventing one, or',
      'padding the list with a restated fact, is much worse than returning none.',
      '',
      'ETYMOLOGY IS A REQUIRED PART OF THE CARD, both halves of it: where the',
      'ENGLISH common name came from, and what the genus and the epithet mean in',
      'the language they were built from. If the epithet honors a person or a',
      'place, say who or where. If a name is disputed or simply unrecorded, say so',
      'rather than picking the prettiest story.',
      '',
      'SOURCES. Cite only pages that came back from a search on this turn. Never',
      'construct a URL that looks right. Prefer species accounts, museum and',
      'institutional pages, regional field guides and monographs over aggregators.',
      'Zero sources is an acceptable and honest answer; a fabricated one is not.',
      'WoRMS settles nomenclature and nothing else — it will tell you the accepted',
      'name and it will not tell you how to recognize the animal.',
      '',
      'IF IT IS NOT AN ORGANISM, or the image is too poor to work from, set rank to',
      '"unknown", confidence to "low", and use notVisible to say what defeated you.',
      'Do not guess to fill the schema.',
      '',
      'FIELD TEXT IS PLAIN TEXT. No HTML, no markdown, no bullet characters, no',
      'bracketed citation markers. The renderer supplies every tag.',
      '',
      'AMERICAN SPELLING throughout: color, behavior, gray, recognize, meter.',
      '',
      'WHO EACH FIELD IS FOR. Everything is for the READER except `confidence`,',
      '`notVisible` and `agreement`, which are for the REVIEWER — they are how',
      'someone later judges whether to trust the card, and the renderer hides them',
      'from the finished slide. Write them for that reader: candid about what',
      'defeated you. Do not soften them because they might be seen, and do not',
      'smuggle their content into the reader-facing fields either.'
    ].join('\n'),

    // The per-image turn. `locationHint` is optional and, when it exists, is
    // worth more than any other single input — most identifications are settled
    // by range long before they are settled by morphology.
    userPrompt: function (opts) {
      var o = opts || {};
      var ls = ['Identify the organism in this image.'];
      if (txt(o.locationHint)) ls.push('Where it was taken: ' + txt(o.locationHint) + '.');
      if (txt(o.dateHint))     ls.push('When: ' + txt(o.dateHint) + '.');
      if (txt(o.note))         ls.push('The user adds: ' + txt(o.note));
      return ls.join('\n');
    },

    // ── JSON → the card's back sections, IN ORDER ─────────────────────────
    // (dev0903) Returns an ARRAY. It used to return { body, orig }, which
    // capped a card at two back faces and glued everything past the second onto
    // the end of it. Empty sections are dropped HERE rather than by the caller,
    // so a card ends up with exactly as many faces as it has content.
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

      // ── section 2 · the ID ──────────────────────────────────────────────
      // UID 2184 is the shape: the common name as the <h1>, the scientific name
      // under it, then the one or two lines you would actually look for. The
      // confidence readout is a reviewer's line — same rule as notVisible.
      var rankBit = (rank && rank !== 'species')
        ? '<p><small>' + esc(rank) + '-level — the picture will not carry it further</small></p>' : '';
      var s2 = (common ? '<h1>' + esc(common) + '</h1><p>' + heading + '</p>'
                       : '<h1>' + heading + '</h1>')
        + lines(d.idLines)
        + rankBit
        + '<div class="te-cut"><p><small>' + esc(conf) + ' confidence' + agreeBit + '</small></p></div>';

      // ── section 3 · telling it apart ────────────────────────────────────
      var s3parts = arr(d.keyedOn).map(function (k) {
        return block(k.point, esc(txt(k.heading)), k.lines);
      });
      arr(d.alternatives).forEach(function (x) {
        s3parts.push(block(x.point, sci(x.name), x.lines));
      });
      s3parts.push(block('Male and female', '', [statusText(d.sexDifferences, SEX_LEAD)]));
      s3parts.push(block('With maturity', '', [statusText(d.maturityChanges, MAT_LEAD)]));
      // BETWEEN US, NOT ON THE SLIDE (dev0885). What the picture could not
      // settle is how a reviewer judges the card; to a reader it is a list of
      // things they were not told. Kept in the row, wrapped in the teCut that
      // every render context hides.
      var nvBlock = block('What the picture cannot settle', 'Not visible here', d.notVisible);
      if (nvBlock) s3parts.push('<div class="te-cut">' + nvBlock + '</div>');
      var s3 = section('Telling it apart', s3parts);

      // ── section 4 · worth knowing ───────────────────────────────────────
      var s4 = section('Worth knowing', arr(d.facts).map(function (f) {
        return block(f.point, esc(txt(f.heading)), f.lines);
      }));

      // ── section 5 · stories ─────────────────────────────────────────────
      // The source rides INSIDE the story, because a story is worth exactly as
      // much as the page it came from and the two must not be separable by a
      // later hand edit. It is repeated in section 9 as well.
      var s5 = section('Stories', arr(d.stories).map(function (st) {
        st = st || {};
        var src = st.source;
        var tail = (src && /^https?:\/\//i.test(txt(src.url)))
          ? '<p><small>' + link(src.url, txt(src.title) || src.url) + '</small></p>' : '';
        return block(st.title, '', st.lines, tail);
      }));

      // ── section 6 · names ───────────────────────────────────────────────
      var n = d.names || {};
      var s6 = section('Names', [
        block('Where the name ' + (common || 'this animal') + ' comes from',
              '', n.commonEtymology),
        block('What ' + (txt(d.scientificName) || 'the scientific name') + ' means',
              heading, arr(n.genusMeaning).concat(arr(n.speciesMeaning))),
        // The authority is the point when there is one; without it this block
        // still has to carry the family, so it falls back to a placement line
        // rather than vanishing and taking the family with it.
        block(txt(n.authority) ? 'Described by ' + txt(n.authority)
                               : (txt(n.family) ? 'Where it sits' : ''), '',
              [txt(n.family) ? 'Family ' + txt(n.family) : '']),
        block('Other names it goes by', '', n.otherNames)
      ]);

      // ── section 7 · life ────────────────────────────────────────────────
      var L = d.life || {};
      var s7 = section('Life', LIFE_ORDER.map(function (k) {
        var f = L[k.key];
        return f ? block(txt(f.point) || k.label, '', f.lines) : '';
      }));

      // ── section 8 · in the field ────────────────────────────────────────
      var s8parts = arr(d.fieldNotes).map(function (f) {
        return block(f.point, esc(txt(f.heading)), f.lines);
      });
      var cons = d.conservation;
      if (cons) {
        s8parts.push(block(CONS_LABEL[txt(cons.status)] || 'Conservation status',
                           '', cons.lines));
      }
      var s8 = section('In the field', s8parts);

      // ── section 9 · sources ─────────────────────────────────────────────
      // ONE collapsible holding the lot (dev0903, restoring what went missing).
      // Story sources are repeated here so this face is the whole bibliography
      // and nobody has to walk the other faces to find a link.
      var seen = {};
      var srcs = arr(d.sources)
        .concat(arr(d.stories).map(function (st) { return st && st.source; }))
        .filter(function (s) { return s && /^https?:\/\//i.test(txt(s.url)); })
        .filter(function (s) { var u = txt(s.url); if (seen[u]) return false; seen[u] = 1; return true; })
        .map(function (s) { return link(s.url, txt(s.title) || s.url); });
      var s9 = srcs.length
        ? '<details><summary>Sources</summary>'
          + srcs.map(function (h) { return '<p>' + h + '</p>'; }).join('')
          + '</details>'
        : '';

      return [s2, s3, s4, s5, s6, s7, s8, s9].filter(Boolean);
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
        idLines: [
          'Cerata bunched in six clusters down each side',
          'Every ceras tipped opaque white over a red brown core'
        ],
        keyedOn: [
          { point: 'The cerata sit in clusters, not in a continuous fringe',
            heading: 'Cerata',
            lines: ['Six distinct clusters along each side',
                    'Each ceras opaque white at the tip',
                    'A red brown digestive gland shows through the stalk',
                    'An even unbroken fringe would rule this genus out'] },
          { point: 'Ringed rhinophores settle the genus on their own',
            heading: 'Rhinophores',
            lines: ['Distinctly annulate, that is ringed',
                    'Neither smooth nor papillate',
                    'Visible here against the pale body'] },
          { point: 'Oral tentacles as long as the rhinophores',
            heading: 'Oral tentacles',
            lines: ['Long and slender',
                    'Roughly the length of the rhinophores'] }
        ],
        notVisible: [
          'the foot corners, which are angled rather than rounded in this genus',
          'the radula, which separates the harder Flabellina pairs and needs a microscope regardless'
        ],
        alternatives: [
          { point: 'A nobilis carries the same colors in a different arrangement',
            name: 'Coryphella nobilis',
            lines: ['Cerata evenly spaced, never in discrete clusters',
                    'Rhinophores smooth rather than ringed'] },
          { point: 'A violet body would make it pedata instead',
            name: 'Flabellina pedata',
            lines: ['Body distinctly violet, not translucent white',
                    'A color difference a photograph settles at once'] }
        ],
        sexDifferences: {
          status: 'hermaphrodite',
          text: 'Simultaneous hermaphrodite, like all nudibranchs — every adult carries both sets of organs and there is nothing external to sex. Pairs align right side to right side to mate, and both may lay.'
        },
        maturityChanges: {
          status: 'changes',
          text: 'Juveniles under about 8 mm (0.3 in) carry far fewer ceratal clusters — often only two or three — and the white ceratal tips have not yet developed, so a young animal reads as a plain translucent slug. Adults reach roughly 35 mm (1.4 in).'
        },
        facts: [
          { point: 'It steals the stings of the animals it eats',
            heading: 'Kleptocnidae',
            lines: ['The slug feeds on hydroids',
                    'Hydroid stinging cells pass through the gut undischarged',
                    'The cells are stored alive in the ceratal tips',
                    'Those white tips are loaded batteries'] },
          { point: 'The cerata are gill, stomach and armor at once',
            heading: 'One structure, three jobs',
            lines: ['Digestive gland branches run up inside each ceras',
                    'The thin ceratal wall works as a gill',
                    'A ceras can be shed and grown again'] },
          { point: 'The slug can crawl upside down along the underside of the surface film',
            heading: 'Surface crawling',
            lines: ['The foot grips the water surface from below',
                    'A way to travel without touching the bottom'] }
        ],
        stories: [
          { title: 'How a slug that eats stinging cells does not sting itself',
            lines: [
              'The question sat unanswered for most of a century: a nudibranch swallows hydroid tissue packed with loaded nematocysts, and somehow those cells arrive at the tips of its cerata still loaded and still able to fire.',
              'The mucus lining the gut is now thought to keep the cells from discharging on the way through, and the slug appears to sort them on arrival, discarding the spent ones and shelving the live ones exactly where a fish would bite first.',
              'It is a piece of biology no field guide has room for, and it explains the one thing this photograph actually shows, which is why the ceratal tips are white.'
            ],
            source: { title: 'placeholder — layout fixture only', url: 'https://example.org/kleptocnidae' } }
        ],
        names: {
          commonEtymology: ['Named for the red digestive gland showing through the cerata',
                            'The cerata were long taken for gills, which is where gilled comes from'],
          genusMeaning: ['Flabellina from Latin flabellum, a small fan',
                         'For the fanned arrangement of the cerata'],
          speciesMeaning: ['verrucosa from Latin verruca, a wart',
                           'For the texture of the body wall'],
          authority: 'M. Sars, 1829',
          family: 'Flabellinidae',
          otherNames: ['Red-finger aeolis, in older British books',
                       'Coryphella verrucosa, the name used through much of the literature']
        },
        life: {
          distribution: { point: 'A cold water animal on both sides of the Atlantic',
            lines: ['North Atlantic on both coasts',
                    'South to Rhode Island in the west',
                    'South to the English Channel in the east'] },
          habitat: { point: 'Found wherever its hydroids grow',
            lines: ['Low intertidal down to about 40 m (130 ft)',
                    'On rock, pilings and kelp holdfasts',
                    'Always close to a hydroid colony'] },
          size: { point: 'A big one is the length of a thumbnail',
            lines: ['To about 35 mm (1.4 in)',
                    'Commonly 15 to 25 mm (0.6 to 1 in)'] },
          lifespan: { point: 'Under a year, start to finish',
            lines: ['Most live less than 12 months',
                    'Adults die after spawning'] },
          reproduction: { point: 'Both animals lay after mating',
            lines: ['Simultaneous hermaphrodite',
                    'Eggs laid in a white coiled ribbon',
                    'The ribbon is fixed to the hydroid the adults feed on'] },
          diet: { point: 'Hydroids, and little else',
            lines: ['Tubularia and related hydroids',
                    'Bites the polyp heads off the stalks'] },
          predators: { point: 'The stolen stings are the defense',
            lines: ['Few predators recorded',
                    'Nematocysts stored in the ceratal tips deter fish'] }
        },
        fieldNotes: [
          { point: 'Find the hydroids and you find the slug',
            heading: 'Search image',
            lines: ['Look over hydroid colonies, not over open rock',
                    'Egg ribbons on a colony mean adults are close by'] },
          { point: 'Spring is when they are everywhere',
            heading: 'Season',
            lines: ['Numbers peak in spring',
                    'Almost absent by late summer'] }
        ],
        conservation: {
          status: 'not-evaluated',
          lines: ['Not assessed by the IUCN',
                  'Common through its range',
                  'No fishery and no known targeted threat']
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

  // The dossier, in the order section 7 reads it. The label is the fallback
  // when the model found no better collapsed line than the plain question.
  var LIFE_ORDER = [
    { key: 'distribution', label: 'Where it lives' },
    { key: 'habitat',      label: 'The habitat it keeps to' },
    { key: 'size',         label: 'How big it gets' },
    { key: 'lifespan',     label: 'How long it lives' },
    { key: 'reproduction', label: 'How it breeds' },
    { key: 'diet',         label: 'What it eats' },
    { key: 'predators',    label: 'What eats it' }
  ];

  // Status → the collapsed line, so section 8 says the status without being
  // opened. "Not evaluated" is a real answer and reads as one here.
  var CONS_LABEL = {
    'not-evaluated':         'Not evaluated by the IUCN',
    'data-deficient':        'Too little known to assess',
    'least-concern':         'Least concern',
    'near-threatened':       'Near threatened',
    'vulnerable':            'Vulnerable',
    'endangered':            'Endangered',
    'critically-endangered': 'Critically endangered',
    'unknown':               'Conservation status not found'
  };

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
    + 'the disc-to-arm proportion together with aboral color. Several of those need '
    + 'a closer or oblique view than this frame gives. All of them need to be judged '
    + 'against the species list for a known locality.',

    'WHAT A LOCALITY WOULD BUY. This is the whole gate. Eastern Pacific, San Pedro '
    + 'Bay south to Ecuador: A. armatus is the common large sand star — five slender '
    + 'pointed arms turned up slightly at the tips, to about 17 cm (7 in) across, a '
    + 'small disc, the madreporite sitting very close to the disc edge, upper surface '
    + 'yellowish brown, dull pink or gray, underside pale yellow to ivory, on sand or '
    + 'soft gravel from 5 to 115 m (16 to 380 ft) and often half-buried. Western '
    + 'Atlantic and Caribbean: A. duplicatus and several congeners. Mediterranean: a '
    + 'well-worked fauna with published keys. The same photograph resolves to '
    + 'different answers in different oceans, and nothing in the picture tells you '
    + 'which ocean it is.',

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
  // PLAIN TEXT, not HTML — it goes through `lines()` like everything else now,
  // so escaping happens in exactly one place.
  function statusText(o, leads) {
    o = o || {};
    return ((leads[txt(o.status)] || '') + txt(o.text)).trim();
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

  // picture <hr> section 2 <hr> section 3 <hr> … — the sections grid.js splits
  // on, in the order makecard.js established and dev0881 opened up.
  function renderFtext(imgUrl, typeId, cardData) {
    var t = TYPES[typeId];
    if (!t) throw new Error('unknown cardType: ' + typeId);
    var secs = t.renderSections(cardData);
    if (!Array.isArray(secs)) secs = [secs.body, secs.orig];   // a pre-dev0903 type
    return [pictureSection(imgUrl)]
      .concat(secs.filter(Boolean))
      .join('\n<hr>\n');
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
