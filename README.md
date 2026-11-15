# dsh-find-bar

English | [中文](README.zh.md)

A web plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
that brings back **⌘F / Ctrl+F in-page find** for the desktop Electron shell,
which ships without one. v0.5 is built around one idea: **a search must never
steal your view.** Typing only marks and counts; the multi-select scope follows
the region you are actually working in; and match case / whole word are here.

## Find & jump

- **Typing only marks**: highlights and the counter update live, the page does
  not move. Before you locate anything the counter shows the plain total
  (`17`); after, it becomes `3/17`.
- **Only commands move the view**: Enter / Shift+Enter / the arrow buttons /
  ⌘G / F3. The **first** jump anchors to the current viewport — the first match
  inside it, else the nearest one below (mirrored when going backwards) — so a
  search never yanks you back to the document top.
- An already fully-visible match is not scrolled to; when scrolling is needed
  it is a minimal nudge of the nearest scrollable ancestor, not a whole-page
  scroll chain.
- Streaming output and fold/expand trigger a silent rescan; the located match
  is re-anchored by (text node, offset), so the current highlight does not
  teleport.

## Search scope (multi-select + focus region)

⋯ on the main row opens the **options row** (collapsed by default, remembered):
`[Chat] [Panel] [All]` chips + `Aa` + `Word` + `⌖ Follow focus`.

- **Multi-select**: checking both columns *is* "All"; clicking "All" checks
  both; the last checked column cannot be unchecked. Results follow the visual
  reading order (chat → panel; reversed when the panel is fullscreen).
- **A collapse never overwrites your choice**: while a column is collapsed its
  chip greys out and the search skips it — the saved scope stays as it was and
  resumes the moment the column reopens.
- **Follow focus** (on by default, ⌖ to turn off) decides the scope at the
  moment you press ⌘F:

  | State at that moment | Scope for this search | Persisted? |
  |---|---|---|
  | Live selection (anchor in a column) | that column only | ❌ temporary |
  | No selection, saved = All, a column was last clicked | degraded to the clicked column | ❌ temporary |
  | Anything else | the saved scope | ❌ |
  | Manual chip click | applies at once | ✅ the only write path |

  Regions are decided by **pointerdown click position** (not hover); a
  temporary override blinks the chip it picked. The left sidebar is not a
  scope: the dsh workspace already searches it.
- **Folded content is skipped**: text hidden by collapsed regions does not
  match; expanding re-counts within ~250 ms.

## Match options

- **`Aa` match case** (Alt+C): `ID` no longer hits `id`.
- **`Word` whole word** (Alt+W): `find` skips `finding` / `overflow`. CJK has
  no spaces, so CJK counts as a natural boundary — `字体` still hits `字体太大`.
- Both persist; toggling re-marks only and still never jumps.

## How it works

- Listens for ⌘F/Ctrl+F (capture phase) and draws a themed find bar.
- A TreeWalker collects text nodes (shadow roots included), rooted at the
  selected columns (`[data-rightbar-col]` and its centre sibling), dropping
  matches hidden by collapsed regions (`checkVisibility`); options feed
  `findIndices(text, query, {matchCase, wholeWord})`.
- Highlights via the **CSS Custom Highlight API** — paint-only, zero DOM
  mutation, zero React conflicts. Environments without it fall back to
  `window.find()` and the whole options row greys out, because scope and case
  cannot be honoured there.
- A debounced MutationObserver re-scans on content changes, folds and expands.

## Keyboard

| Key | Action |
|---|---|
| ⌘F / Ctrl+F | Open the bar (prefilled with the live selection) |
| Enter / Shift+Enter | Next / previous match (first jump anchors to the viewport) |
| ⌘G / F3 (+Shift) | Next / previous |
| Alt+C / Alt+W | Match case / whole word |
| Esc | Close and clear highlights |

## Install

```sh
dsh plugin --profile <profile> add dsh-find-bar
```

Installs from npm (recommended); or from source:

```sh
git clone https://github.com/secyborg/dsh-find-bar
dsh plugin --profile <profile> add ./dsh-find-bar
```

Restart the app once after installing (plugin manifests load at startup).

## Known limitations

- Only searches text **rendered and visible** in the DOM; collapsed sessions
  or long lists must be expanded first.
- Web content inside panel iframes is out of scope, as is deep shadow-DOM
  content for the focus-region rule.
- Match cap of 5000, shared across both columns (shown with a `+` suffix).
- The `window.find()` fallback has no scope or match options.

## Uninstall

```sh
dsh plugin --profile <profile> remove dsh-find-bar
```

## License

MIT
