# dsh-find-bar

English | [中文](README.zh.md)

A web plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
that brings back **⌘F / Ctrl+F in-page find** for the desktop Electron shell,
which ships without one. Browser-grade find bar: highlight-all, match counter,
Enter/Shift+Enter navigation — plus a **centre｜right scope picker** so the
conversation and the right extension panel are searched separately instead
of as one page.

## Search scope

The segmented picker overlays the input's right side and maps to the app's
two searchable columns (the choice is remembered across opens). It never
resizes the bar: with the right column collapsed the pills simply vanish.
The segments are text-free pills — left pill = conversation (**default**),
right pill = right extension panel — and hovering the picker shows one
shared hint bubble styled after the app's own control tooltips (500 ms
delay, theme-matched surface).

Scope rules:

- **The picker only appears when there is a choice**: with the right column
  collapsed, search runs on the conversation alone and the picker hides
  entirely — it reappears as soon as the column is opened. If the active
  scope collapses mid-search, it falls back to the conversation without
  overwriting the saved choice.
- **Folded regions are skipped**: auto-folded tool steps and hidden panes do
  not match; expanding a region re-counts its matches within ~250 ms.
- A fullscreen right panel (covering the centre) still counts as "R".
- The left sidebar is not a scope: the dsh workspace already searches it.

## How it works

Electron has no built-in find bar. This plugin implements one client-side:

- Listens for ⌘F/Ctrl+F (capture phase) and draws a themed find bar.
- Collects text nodes with a TreeWalker (shadow roots included), rooted at the
  selected column (the right column carries the stable `[data-rightbar-col]`
  anchor; the centre column is its previous sibling), and drops matches
  hidden by collapsed regions (`checkVisibility`).
- Highlights via the **CSS Custom Highlight API** (`CSS.highlights` +
  `::highlight()`) — paint-only, zero DOM mutation, zero React conflicts.
- A MutationObserver (including attribute changes) re-scans on a debounce as
  content streams in and regions fold or expand.
- Environments without the Highlight API fall back to `window.find()`
  (no scope or counting in that mode).

## Keyboard

| Key | Action |
|---|---|
| ⌘F / Ctrl+F | Open the bar (prefilled with the page selection) |
| Enter / Shift+Enter | Next / previous match |
| ⌘G / F3 (+Shift) | Next / previous |
| Esc | Close and clear highlights |

Search-as-you-type (debounced, follows streaming updates); the counter shows
`current/total`.

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
- Web content inside panel iframes is out of scope.
- Match cap of 5000 (shown with a `+` suffix).
- Case-insensitive; no "match case" toggle yet.
- The `window.find()` fallback mode has no scope picker.

## Uninstall

```sh
dsh plugin --profile <profile> remove dsh-find-bar
```

## License

MIT
