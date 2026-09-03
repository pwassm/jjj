# TODO

Deferred work, newest first. An item leaves here when it ships (with the dev
number) or when it is decided against (with the reason).

---

# HANDOFF — flash cards, as of dev0885 (2026-09-02)

Written to close a long thread. Everything below is what a fresh thread needs
to pick the work up cold.

## The shape of the thing

A flash card is an ml.json row with no `link` and an `ftext` split on top-level
`<hr>`. Two independent axes, and keeping them apart is the whole design:

- **`ltype` = how far along it is.** `f0` swept in, picture only · `f1`
  identified · `f2` Phil has reviewed and agrees · `f3` an expert has reviewed.
  Bare `f` is the legacy MakeCard value and still renders. One regex,
  `FLASH_LTYPE_RE` in core.js, backs both the filter pill and grid.js's card
  gate so they cannot drift.
- **`cardType` = what the card is about.** `id1` is identification-and-lifecycle.
  Later types (behaviour, habitat, …) are entries in the cardtypes.js table, not
  code changes.

## What shipped

| dev | what |
|---|---|
| 0874 | `M:\wm\flashcandidates\` drop folder → Housekeeping ▸ Sweep Flash Candidates → JPEG → R2 → `f0` rows. Proxy `/card/candidates` + `/card/sweep` (one file per request so a 200-shot run reports progress and stops on Esc). The `🃏 flash` filter pill. Grid card gate widened off the bare `'f'`. |
| 0875 | `cardtypes.js` — the `id1` type: `outputSchema`, `systemPrompt`, `renderSections`. |
| 0876 | Housekeeping ▸ Sample Flash Card / Remove Sample Cards — review a card type as a real row, not as source. |
| 0877 | Housekeeping ▸ Sample RAW Flash Card — the research dump before anything formats it. |
| 0879 | ↑ on a flash card opens the reader on the face you were reading (`_gridCardSectionIdx`), not always the picture. |
| 0880 | Xe: stepping a body line's size inside a `<details>` carries the `<summary>` with it, so a title can no longer end up smaller than its own body. |
| 0903 | **Nine sections.** `id1` rewritten: `renderSections` returns a LIST, empty sections dropped, and the ladder is picture / ID / telling it apart / worth knowing / stories / names / life / in the field / sources. Schema gains `idLines`, `facts`, `stories`, `names`, `life`, `fieldNotes`, `conservation`; `keyedOn` and `alternatives` become collapsible-shaped (`point` + `heading` + `lines`). Units rule (metric AND US, rounded) and the one-line-is-one-fact rule in the prompt. Sources restored as their own face. |
| 0885 | American spelling throughout. Reviewer-facing blocks (what the picture could not settle, where the identification came from, the confidence readout) are wrapped in a teCut: kept in the row, hidden from every render. `id1.systemPrompt` now says which fields are for the reader and which for the reviewer, and `renderSections` hides the latter. |
| 0884 | UID 2175 rebuilt — the pale sheephead is a female mid sex-change, not a depth artefact. The same trap guarded in `id1.systemPrompt`: reach for the biology before the lighting. |
| 0883 | A collapsible ships CLOSED. Every way of opening one in Xe wrote the schema `open` attribute and that attribute was serialised, so reading a card in the editor shipped every answer showing. `open` is now read from HTML and never written back. UIDs 2175 (sheephead) and 2174 (garibaldi) populated. |
| 0882 | Xe ⊘ HideLine + Alt+X (and the empty-teCut footgun that silently cut a slide from that point down). The fullscreen reader's column and type size follow the viewport. A reader page holding collapsibles gets an auto Show all / Hide all. |
| 0881 | **A card has as many faces as it has sections.** `makeCardSplit` returns a `sections` list (`body`/`orig` kept as the first two, so no caller moved); G addresses faces by INDEX — turncells tag `s<i>`, an indexed back panel, and a forward swipe that STEPS to the next face with the last one returning to the picture. At three sections that is byte-for-byte the dev0860 gesture. UID **2184** is the first card written in the 4-section layout. |

## The section ladder — SHIPPED dev0903

Phil's target, and what the renderer now emits. A card is ftext split on
top-level `<hr>`; every section is a FACE in G (swipe steps forward, the last
returns to the picture) and a PAGE in the reader. **An empty section is
dropped**, so a card has exactly as many faces as it has content.

| # | face | what goes on it |
|---|---|---|
| 1 | picture | the front |
| 2 | ID | name, plus the one or two lines that name what you look at |
| 3 | telling it apart | what the call rests on, and what it is confused with |
| 4 | worth knowing | the interesting half — description and oddity |
| 5 | stories | NARRATIVE. long lines, **each story its own source** |
| 6 | names | etymology of the common name AND of the binomial |
| 7 | life | distribution habitat size lifespan breeding diet predators |
| 8 | in the field | what helps you place it, and its conservation status |
| 9 | sources | one collapsible, every link inside it |

**The card has two halves and they are written differently.** Sections 2-4 are
the FLASH: read in a grid cell the size of a stamp, short flat lines, one idea
each. Sections 5-9 are the REFERENCE half: read full screen, one page at a
time, and deliberately long — that is why they were split off. A thin
reference half is the commonest way to get a card wrong.

**Section 5 is the one place prose is written.** A small true story with a
beginning and a point — "How bat rays were mistakenly considered threats to
oyster beds", "How did sea otters help eelgrass". Longer sentences, narrative
voice, and every story carries its own source. **A story that cannot be
sourced does not go in**, and padding the list with a restated fact is worse
than returning none.

**ONE LINE IS ONE FACT.** Lines get pulled OUT of these cards to build the
language quiz, so each `<p>` has to survive being shown on its own, out of
order, with nothing around it. No line may open with "it" / "this" / "they"
reaching back to the line above.

**UNITS: BOTH, ALWAYS, ROUNDED.** Metric first, US customary in parentheses,
both rounded to what is actually known — "to about 66 cm (26 in)", "down to
180 m (600 ft)". Never a bare metric figure and never a bare imperial one.
This applies everywhere on the card, not just to section 7.

**UID 2184 is still the worked example** for sections 1-4 (a copper rockfish,
hand-written, cell 2c of the FlashTry1 config). Nothing has been written by
hand in the full nine yet — `CardTypes.sampleFtext()` renders the layout with
the `sample()` fixture, which is a LAYOUT FIXTURE and not vouched-for biology.

**A known gap this opened.** `makeCardBuildHtml` (makecard.js), the standalone
.html export, still emits only the picture and `parts.body`. It dropped
section 3 before dev0881 and now drops 3 through 9. One line —
`parts.sections` — but it changes what an exported card contains, so it wants
a decision, not a drive-by fix.

**Still to argue about in the ladder.** Sections 6, 7 and 8 were specified as
"specific facts that might help in identification", with etymology named for 6
and distribution / habitat / lifespan / reproduction / diet / predators /
conservation named as the general list. The split above puts etymology alone
on 6, the dossier on 7, and placing-an-animal plus conservation on 8. That
division is the renderer's guess, not Phil's instruction, and moving a field
between 6, 7 and 8 is a two-line change in `renderSections`.

## The markup Phil wants for section 3

Every top-level item is collapsible. The `<summary>` **carries the point** — it
is the only thing visible collapsed, so the whole card reads as a list of
claims you can open. Inside: an optional `<h3>` sub-heading, then short lines.

```html
<h1>California sheephead</h1>
<details><summary>Every sheephead starts as a female</summary>
<h3>Protogynous hermaphrodite</h3>
<p>All begin female</p>
<p>Some later become male</p>
</details>
```

Do **not** put the point outside the `<details>` as a statement with a lead-in
inside — that was the first attempt and it reads backwards.

Content style: short phrases, one idea per line, more lines, almost no
punctuation. UID 2184 holds a worked example.

## Turn vs expand — Phil's rule (unimplemented)

The conflict: on a card a tap turns the card, so a `<details>` cannot be opened
by tapping. His answer:

- Taps execute **turn-card only on side 1**.
- Side 2 displays for **3 seconds** then reverts to side 1 by itself, unless
  clicked anywhere in the slide.
- Once clicked, a **transparent arrow, upper right** returns to side 1.
- Picking another cell on the grid also reverts it.

## NEXT: one species, many pictures

Raised 2026-09-02. Nothing built. The problem arrives the moment the sweep
brings in a second garibaldi: sections 3 and 4 are ~2.5 KB of species text that
is identical on every card of that species, duplicated per row and — worse —
re-authored and re-corrected per row.

**The 4-section layout already draws the line in the right place.** Sections 1
and 2 are about THIS PHOTOGRAPH (the picture, and the least that says how this
image was read). Sections 3 and 4 are about THE SPECIES. So the split is not a
refactor, it is a storage decision about the back half.

**`taxoninfo.json` is already the right store and already exists** — 515
entries keyed kebab-case on the scientific name (`hypsypops-rubicundus`,
`bodianus-pulcher` are both in it today; `sebastes-caurinus` is not yet).
Built in the taxon-info work for card backs and DictSize, which is the same
shape of data.

The shape to build:

- a card row gains a `taxon` key (`hypsypops-rubicundus`)
- its ftext holds ONLY sections 1 and 2
- sections 3 and 4 render from the taxon record at display time — in
  `_gridCardParts` / the reader, appended after the row's own sections
- correcting a species fact is then one edit that fixes every card of it

Two things to decide before building. **Where the species text lives inside
taxoninfo** — its records are Wikipedia-shaped (`note`, `descr`, `wiki`), so
the card sections want their own key rather than being squeezed into `note`.
And **what Xe edits** — opening a card in Xe must not silently detach it from
the shared record. Simplest answer: Xe edits sections 1-2 only, and the shared
half is edited through its own screen.

A cheaper interim, if this is too big: keep the text per-row but write it ONCE
and copy it to siblings, with `taxon` recorded so the copies can be found and
re-synced later. That gets the correcting-in-one-place benefit without a
render-time join.

## NEXT: promotion to f2 puts a species chip in tags

Raised 2026-09-02, and it needs a step that does not exist: **there is no f1 → f2
action at all.** The ladder is only ever a value someone types. So this is two
pieces:

1. A promote action (Housekeeping, or a T hotkey on the focused rows): f1 → f2,
   with whatever review gate Phil wants.
2. On promotion, add the species as a tag chip, so the card joins the tag
   system and can be found by species like everything else.

The tag text is a settled question already: `tags.json` `common` is lowercase
unless proper-noun derived, and the alias hygiene rules (comma-free,
`stripAuthorship()`) apply. The chip should carry the same key as the taxon
record above, so tags and `taxoninfo.json` cannot drift.

## Still open

- ~~The renderer still emits the old 3-section shape.~~ DONE dev0903 —
  `renderSections` returns a list, `renderFtext` joins picture + all of it,
  and a non-array return is still accepted so an older card type would not
  break.
- ~~cardtypes.js's header comment contradicts the design.~~ DONE dev0903 —
  the header now says `<details>` IS the format and carries the section ladder.
- **UID 2179 is no longer a worked example.** It was re-swept back to a
  picture-only f0 on 2026-09-02. 2184 replaces it as the reference card.
- **No API wiring, deliberately.** Phil: "too early to do API." The schema and
  prompt exist to be argued with first.
- **`locationHint` is the highest-value input in the pipeline** and nothing
  fills it. The Astropecten pass settled this: genus is reachable from a photo
  (marginal plates visible from above separate *Astropecten* from *Luidia*), but
  every character that separates the species has to be judged against a known
  locality. The same photograph resolves differently in different oceans, so
  locality is the gate — not resolution, and not model choice.
- **Two-pass agreement.** Run each image twice and record whether the passes
  agree; `id1.outputSchema` already has the `agreement` field. A model's own
  confidence is a self-report, agreement between passes is an observation.
  Through the API that means Opus 5 + Sonnet 5 — note Perplexity Pro cannot
  reach Opus 5 at all, only Max can, so the API is the *cheaper* route to it.

## Things already settled — do not re-litigate

- **Xe does NOT destroy `<details>` content.** Claimed once, then disproved: a
  headless jsdom round trip of seven shapes — links inside `<details>` included
  — came back byte-identical, and the paste path routes through
  `_sanitizePastedHtml`, which keeps `A[href]` and `details`/`summary`. The
  empty Sources and gutted section 3 on UID 2179 came from hand editing.
- **`id1.sample()` is a layout fixture, not model output.** Hand-written to give
  the renderer awkward shapes to survive; the biology is not vouched for and the
  `example.org` URLs are placeholders. `id1.sampleRaw()` is the real one.
- **Source hierarchy.** WoRMS is nomenclature only — it will tell you
  *Bodianus pulcher* is now the accepted name for the California sheephead, but
  not how to recognise one. FishBase is fish-only (SeaLifeBase is its
  invertebrate sibling). Descriptive material came from Wikipedia species
  accounts, ADW, aquarium and sanctuary pages, and Plazi treatments for real keys.

## Headless Xe test recipe

Worth rebuilding when Xe needs proving; it is the only way to test the editor
without driving a toolbar.

1. jsdom is already in `node_modules`.
2. Make a JSDOM window, copy its globals onto `global`, set `localStorage.xe2 = '1'`.
3. `window.eval` **`xe2-bundle.js` first, then `xe2.js`** (xe2.js reads
   `window.XE2Lib` from the bundle and bails without it).
4. `XE2.createEditor(host, ftext, {editable:true})` returns a **wrapper**, not
   the editor — read the result with `.getFtext()`, and reach the real editor at
   `.editor`.
5. `XE2._stepBlockSize` and `_summaryPosForBody` are exported for exactly this.

---

## Xe / Xs — summary vs detail size across render contexts
Raised 2026-09-02. **Partly fixed in dev0880.**

The A+/A− case is done: stepping a body line inside a `<details>` now carries
its `<summary>` with it. What remains is the render-context half — the Xs slide
CSS and the Xe editor CSS style the same ftext differently (see memory
`reference_xe_render_contexts`), so a size relationship that looks right in one
can still look wrong in the other. Fix in both or not at all.
