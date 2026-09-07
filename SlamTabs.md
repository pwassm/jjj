# slam.com menu tabs — how they work, and where they should go

**Status: BUILT in dev0940.** Written 2026-09-05 against dev0930 as a design note;
the bar became data on 2026-09-06. Sections 1–3 are the reasoning and still read
true. **Sections 4 and 5 describe the code as it was BEFORE the switch** and are
kept only as the record of what was replaced — do not follow them.

Three things shipped differently from this note:

- **`Kind`, not the magic gnames.** A tab row's identity is a `Kind` column
  (`prose` / `intro` / `signin` / `grids` / `flash` / `search` / `saved` /
  `loops`), never its name. `gname` is free text now; renaming a tab is a `Label`
  edit. That is what makes trap T2 — the Introduction → Welcome rename — go away
  rather than merely be documented.
- **No `Slot` column.** The proposed "which element gets injected" column proved
  unnecessary: the injected element IS the tab's body, and `Kind` already names
  it. So the two-section rule (dev0939) generalised from a special case for
  Introduction and Contact into the rule for EVERY tab — section 1 · body ·
  section 2 — and every behaviour tab gained optional prose above and below for
  free. T2b is handled by a fallback: a Grids tab with no section 1 still borrows
  the parked Greeting row's post-`<hr>` half as its header.
- **`data-pg` is a position, assigned at build time** (trap T4 dissolved), and
  the Tab-key order and page-hiding list are derived from the same rows (trap T3).
  Nothing persists a page number across sessions, so nothing had to be migrated.

Also in dev0940, unrelated to the bar: "My Loops" and "Add your own" merged into
one **Saved Loops** tab, each card tagged FromThisSite or FromPastedURL, and
`salLinks` stopped accepting image links — that store now backs A→B on video only.

To re-derive the current shape: `grep -n "TAB_KINDS\|_smTabs\|_pgOf" boot.js`.

---

## 1. The brief

Assign and reorder the menu tabs from **c.json**, not from a hand-edited string
in `boot.js`.

**Every tab is a c.json row**, including the behaviour-backed ones. The row exists
so the tab's ORDER and LABEL become data I can edit, rather than code I have to
ship.

### `ctype` — the classifier

The lever is the existing, currently-unused `ctype` column:

| `ctype` | Means | Filter button | Today |
|---|---|---|---|
| `t` | This row IS a menu tab | `t` | 6 rows, set by the author |
| `""` (blank) | A grid collection — the default | `g` (includes blanks) | the rest |
| `f` | A flashcard deck | `f` | 1 row (`FlashTry1`) |
| `q` | Quiz — a *future* flashcard category | `q` | not built |
| `o` | The author's own material, parked | — none yet | 1 row (`Sources`) |

Four filter buttons at the top: **g f q t**. `o` has no button — see open question 1.

### `Lock` — the no-edit flag

A column named **`Lock`**. **Any value in it means `ctxt` cannot be edited.** Not a
particular string — non-empty is the test, so anything the author types there
(`1`, `x`, `No Edit`) locks the row. Order and label stay editable.

This is a dedicated column rather than `ss`, which is a live deep-link id —
section 2.

### `active` — the tab order

`active` = 1 is the first tab, 2 the second, 3 the third. This is the *same*
meaning `active` already carries for grids ([boot.js:1060](boot.js#L1060)), so
nothing new is being invented — and because `ctype` now separates the two
populations, a tab's `active: 1` and a grid's `active: 1` no longer compete.

*(But see trap T1: today's Grids list keys off `active > 0` alone and would
happily list the tab rows alongside the grids.)*

### Why the lock removes the hard part

This is what makes the whole design cheap, and it is worth being explicit about
why. The earlier draft of this file said referents would need a new schema node in
`xe2.js` or Xe would silently delete them. **Under the lock, that work disappears
entirely** — for two separate reasons:

- **Locked tabs carry no referent markup at all.** Their body is code that already
  exists (the Grids list, the Search box). The row is a *pointer*, not a
  container. Nothing in its `ctxt` needs to survive an Xe round-trip because Xe
  never opens it.
- **The one editable tab needs no referent markup either.** Welcome's non-text
  element is positional, not tagged — see below.

So there is no new Xe schema node, and no risk of a silently-deleted placeholder.
The trap is documented in section 3 anyway, because it is real and will bite the
first person who reaches for tagged referents instead.

### The `<hr>` split IS the referent mechanism

The hybrid tabs — editable prose *plus* something that isn't in `ctxt` — need no
markup at all. The rule, already built for Welcome
([boot.js:1464-1469](boot.js#L1464)):

> `ctxt` is split at the first `<hr>`. Section 1 renders, then the injected
> element, then section 2 if present.

The position of the `<hr>` is the referent. Nothing in the text has to survive an
Xe round-trip, which is why a hybrid tab can stay editable with no schema risk.
Which element gets injected is a property of the tab, not of the text:

| Tab | Injected between the sections |
|---|---|
| Welcome | image of the day |
| Contact | the Sign-in strip |

**Contact gets the same rule** — and it is roughly three lines. Page 9 today emits
the whole `contactHtml` and then `#smAuth` ([boot.js:1608](boot.js#L1608)); it
becomes top / `#smAuth` / bottom, mirroring page 1 exactly.

### Which row is Welcome?

**The row driving tab 1 is `Introduction` (`active` = 1), not `Greeting`.** Page 1
prefers the `Introduction` config and falls back to the greeting row only if it is
missing ([boot.js:704](boot.js#L704)). The five `Greeting*` / `Introduction_d`
rows are `ctype: t` with no `active` — parked, showing nowhere. That is the
intended use of "tab with no order": a holding pen.

"Welcome" is already the tab's *label* ([boot.js:1413](boot.js#L1413)). What the
brief renames is the row's `gname`, so data and label agree once the label comes
from the row. The target is therefore the **Introduction** row. See trap T2 for
when, and T8 for how far "everywhere" should reach.

### Spanish

Only a handful of tabs, so a c.json column holding the Spanish label, with a
Housekeeping action to generate the alternatives for `ctype: t` rows. Tractable —
see open question 3 for the one wrinkle.

---

## 2. Why the lock is its own column, not `ss`

The brief first proposed marking locked rows with `ss` = `"No Edit"`. **`ss` is
already in use as a live deep-link identifier**, so it cannot carry a flag:

- `?ss=ID` finds the c.json row whose `ss` equals ID, activates that grid and
  launches the slideshow over it ([boot.js:263](boot.js#L263),
  [boot.js:2990](boot.js#L2990)). 25 rows carry a value today.
- The lookup is `rows.find(r => String(r.ss).trim().toLowerCase() === want)` — a
  **unique-id namespace**. Several tab rows all holding `"No Edit"` would collide
  there: not a crash, but `?ss=no edit` becomes a real URL that opens whichever
  row happens to sort first.

Hence the dedicated **`Lock`** column. c.json columns are free: `cBuildCols`
([collection.js:1091](collection.js#L1091)) discovers columns from the row keys,
so a new one appears in the C screen with no schema work, exactly like `ctype`.

`ctype: t` alone can't carry it either: Welcome and Contact are `ctype: t` *and*
editable. The classifier and the lock are two different facts about a row.

---

## 3. Referents and the Xe trap — kept for reference

Not needed under the lock (section 1), but true, and the reason the lock is the
better design.

A tagged referent would be an inert placeholder in `ctxt` — e.g.
`<div data-sal-mount="grids"></div>` — that `boot.js` finds and fills.

**Xe deletes tags it does not recognise.** It runs on a schema: an explicit list of
every tag AND attribute it understands. Anything off that list is dropped on the
way in *and* on the way out. It has already cost this project real content — one
row lost all ten of its embeds because someone opened it and let it autosave
([xe2.js:211](xe2.js#L211)). A tab's `ctxt` opens in Xe
([hotkeys.js:213](hotkeys.js#L213)), so a placeholder would survive only until the
first edit of that tab's wording, then vanish silently.

A plain `<div>` does not dodge it: `StyledDiv` ([xe2.js:292](xe2.js#L292)) models
`style` and nothing else, so `data-sal-mount` is stripped — and it requires block
content, so an *empty* placeholder div is not schema-valid. The fix, if ever
needed, is one atom node shaped like the `Iframe` node
([xe2.js:218](xe2.js#L218)): no children, `atom: true`, attributes verbatim.

Second constraint, also avoided: the menu builds pages with `innerHTML`, which
never executes `<script>`. A referent could not mount itself.

**Not** a constraint: the sandboxed iframe belongs to Xs, the slide view
([vp.js:1683](vp.js#L1683)). Menu tabs are plain divs in the overlay.

---

## 4. How it works today (snapshot, dev0930)

Built once as `_tabBtns` at [boot.js:1412](boot.js#L1412), rendered **twice** —
`.sm-tabs-top` and `.sm-tabs-bottom` — with `_smShow` syncing `.on` across both.

| Label | `data-pg` | Body comes from | Becomes |
|---|---|---|---|
| Welcome | 1 | c.json `Introduction` `ctxt`, split at `<hr>` + image of the day | `ctype: t`, editable |
| Starting out | 5 | c.json gname `starting out` → `ctxt` | `ctype: t`, editable |
| Grids | 2 | every c.json row with `active` > 0, ascending | `ctype: t`, locked |
| Search | 3 | code | `ctype: t`, locked |
| SavedSearches | 6 | code | `ctype: t`, locked |
| My Loops | 7 | code (`salLoops`) | `ctype: t`, locked |
| Add your own | 8 | code | `ctype: t`, locked |
| Other | 4 | c.json gname `other` → `ctxt` | `ctype: t`, editable |
| Contact | 9 | c.json gname `contact` → `ctxt`, then sign-in strip | `ctype: t`, editable — hybrid, same `<hr>` rule |

*(The brief said "the 4 tabs above" of a screenshot showing five — Grids, Search,
SavedSearches, My Loops, Add your own. All five are taken as locked.)*

**Not yet classified:** the `Other`, `contact` and `starting out` rows are still
`ctype: ""`, i.e. filed as grids, though they are tabs. They have no `active`
number so nothing shows them today, but they need `t` before the switch-over.

Feature switches `SM_FEAT_SEARCH` / `SM_FEAT_ADDOWN` are both `true`
([boot.js:563](boot.js#L563)).

### The bindings that exist today

Content tabs are **already** c.json-backed, each via its own magic-gname lookup
([boot.js:712-740](boot.js#L712)):

```js
const otherCfg = cRows.find(r => r && !r._salMeta
  && String(r.gname || '').trim().toLowerCase() === 'other');
```

…repeated for `contact`, `starting out`, and (by prefix) `Greeting`. So the
machinery is half-built; what's missing is that a row can't yet *declare* what it
is — the code has to already know its name. `ctype` + `active` replaces all of it.

### `ctype` is dead — which is the good news

72 rows carry it. Values: `""` ×71, `"f"` ×1. **No JS reads it** — `grep -rn ctype
*.js` returns only a `<!doctype html>` false hit. The flashcard gate is
`FLASH_LTYPE_RE = /^f\d*$/` ([core.js:3216](core.js#L3216)) and it tests **ml.json
`ltype`**, not this column. The column is unclaimed; defining it breaks nothing.

---

## 5. Traps

- **T1 — the two gates must not disagree.** The Grids list today lists any row
  with `active` > 0, and explicitly filters out Greeting / Introduction / Other
  *by name* ([boot.js:1071](boot.js#L1071)). Give tab rows an `active` number and
  they appear in the Grids list too. That filter must become
  `ctype != 't'`, and the name-matching must go at the same time — leaving both is
  two gates that can disagree.
- **T2 — renaming breaks two name matches, so do it LAST.** `_isGreeting =
  /^greet/` ([boot.js:633](boot.js#L633)) is a *prefix* test, and `_isIntroCfg`
  ([boot.js:704](boot.js#L704)) matches `introduction` or `intro` exactly. Between
  them they find the ml.json greeting row by `ttxt`, pick page 1's prose, and
  exclude both families from the Grids list. Rename `Introduction` → `Welcome`
  *before* ctype-driven selection is live and page 1 silently falls back to the
  greeting row. Rename after, when selection is `ctype` + `active` and the name
  matches are gone.
- **T2b — a parked row still feeds a live page.** Section 2 of the `Greeting` row
  (`greetIntro`) renders as the header of page 2, the Grids tab
  ([boot.js:1481](boot.js#L1481)) — even though that row is now parked with no
  `active`. The lookup is by name and ignores `ctype`, so it still works today.
  Under `ctype` + `active` selection it stops being reachable, and page 2 loses
  its header unless that prose moves to the Grids tab's own row.
- **T3 — a new tab needs THREE edits today, not one.** `_tabBtns`
  ([boot.js:1412](boot.js#L1412)), `_smTabOrder`
  ([boot.js:1672](boot.js#L1672), drives Tab-key cycling), and the literal
  `[1,2,3,4,5,6,7,8,9]` page-hiding list inside `_smShow`. Miss the third and the
  page never hides. Collapsing these into one c.json-derived list is most of the
  win.
- **T4 — `data-pg` is an identity, not a position.** The numbers are historical —
  5 is a recycled slot from a deleted "Navigation Training" tab. Selectors
  elsewhere match on it, so renumbering is not a rename. Each row needs a stable
  id of its own; `gname` is the obvious candidate, which is another reason T2's
  rename wants care.
- **T5 — never translate a key.** `_T()` wraps label text only. `_T()` round a
  `data-pg` or `data-sort` is the classic i18n regression
  ([boot.js:1405](boot.js#L1405)).
- **T6 — c.json: localStorage wins.** Hand-editing c.json on disk does nothing
  until ↻ Reload from disk. Author `ctype` in the C screen, not in an editor.
- **T7 — in C mode the `data` global is c.json, but `save()` writes ml.json only.**
- **T8 — "rename it everywhere" is ~90 sites, and 32 of them shouldn't move.**
  A case-insensitive sweep for `greet` across the app's JS hits ~92 places; 32 are
  the CSS class `.smGreeting`, which is no longer a greeting-specific class — it
  is the generic prose-block class used by Welcome, Starting out, Other and
  Contact alike. Renaming the *data* (`gname`) and the user-facing label is the
  change with a purpose. Renaming `.smGreeting` is churn across four unrelated
  pages for no visible gain; if it happens at all it wants to be its own
  mechanical commit, not folded into this one.

---

## 6. Still open

1. **Does `ctype: o` want a filter button?** Five values, four buttons. `o` rows
   are the author's own parked material (`Sources` today) and are invisible
   without an `active` number — but with no button there is no way to *list* them
   in C either. A fifth button, or `o` shows only when no filter is on?
2. **Where is the lock enforced?** One guard at the Xe entry point
   ([hotkeys.js:213](hotkeys.js#L213)) is the cheap version. A second guard in the
   save path is the safe version — the entry point is not the only route in.
3. **Spanish labels — where does the key live?** Today `_T('Grids')` keys on the
   hardcoded English string. Once the label is data there is no literal to key on,
   so the Spanish column has to be keyed on something stable — `gname`, per T4.
4. **Is `blank` a value or just "not set"?** 71 rows are `""` by accident, not
   decision. If `g` means "blank or `g`", that is a rule to write down rather than
   a backfill — and note backfills don't stick unless done in `save()` behind a
   loaded-guard.
5. **Does `ctype: f` mean the same as ml.json `ltype: f`?** A c.json row is a
   *deck*; an ml.json row is a *card*. Same letter, two scopes — worth naming
   apart before `q` joins them.

---

## 7. Sources

- `_tabBtns`, the bar itself — [boot.js:1412](boot.js#L1412)
- `_smTabOrder` + `_smShow` — [boot.js:1672](boot.js#L1672)
- magic-gname content-tab bindings — [boot.js:712](boot.js#L712)
- `_isGreeting` prefix match — [boot.js:633](boot.js#L633)
- Welcome's prose / picture / prose composition — [boot.js:1464](boot.js#L1464)
- Grids list + `active`-as-order — [boot.js:1060](boot.js#L1060)
- Grids list name exclusions — [boot.js:1071](boot.js#L1071)
- `?ss=` deep link — [boot.js:263](boot.js#L263), [boot.js:2990](boot.js#L2990)
- feature switches — [boot.js:563](boot.js#L563)
- C-screen column discovery — [collection.js:1091](collection.js#L1091)
- flashcard gate (ml.json, not c.json) — [core.js:3216](core.js#L3216)
- c.json ctxt opens in Xe — [hotkeys.js:213](hotkeys.js#L213)
- Xe schema: atom-node pattern — [xe2.js:218](xe2.js#L218)
- Xe schema: why a plain div won't do — [xe2.js:292](xe2.js#L292)
