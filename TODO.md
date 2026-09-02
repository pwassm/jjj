# TODO

Deferred work, newest first. An item leaves here when it ships (with the dev
number) or when it is decided against (with the reason).

## Xe / Xs — a `<summary>` must not end up smaller than its own `<details>` body
Raised 2026-09-02, while formatting the first flash cards.

In the flash-card layout the collapsible lead-in line renders SMALLER than the
detail lines it opens, and bumping the format size makes the gap worse rather
than better. It reads backwards: the summary is the heading of the thing, and
it is set in the smallest type on the card.

**For now: leave summary and detail the same size.** The real fix — whatever
relationship they should have when the size is bumped — can wait until the card
format has settled, because the format is what decides it.

Where to look: the Xs slide CSS and the Xe editor CSS diverge (see memory
`reference_xe_render_contexts` — the same ftext is styled by two different
context stylesheets), so this has to be fixed in both or it will look right in
one place and wrong in the other.
