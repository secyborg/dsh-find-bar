# dsh-find-bar

English | [中文](README.zh.md)

A web plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
that brings back **⌘F / Ctrl+F in-page find** for the desktop Electron shell,
which ships without one. Browser-grade find bar: highlight-all, match counter,
Enter/Shift+Enter navigation — plus a **left｜centre｜right scope picker** so the
conversation, the sidebars, and the right extension panel are searched
separately instead of as one page.

## Search scope

The segmented picker inside the bar maps to the app's three columns
(the choice is remembered across opens):

| Segment | Scope | Meaning |
|---|---|---|
| L | Left sidebar | Sessions / workspaces column |
| C | Conversation | Centre chat column (**default**) |
| R | Right panel | Right extension panel |

Scope rules:

- **Collapsed columns cannot be picked**: a segment greys out while its column
  is collapsed; if the active scope collapses mid-search, the picker falls
  back to the conversation without overwriting the saved choice.
- **Folded regions are skipped**: auto-folded tool steps and hidden panes do
  not match; expanding a region re-counts its matches within ~250 ms.
- A fullscreen right panel (covering the centre) still counts as "R".

## How it works

Electron has no built-in find bar. This plugin implements one client-side:

- Listens for ⌘F/Ctrl+F (capture phase) and draws a themed find bar.
- Collects text nodes with a TreeWalker (shadow roots included), rooted at the
  selected column (the right column carries the stable `[data-rightbar-col]`
  anchor; the centre column is its previous sibling, the sidebar the one
  before that), and drops matches hidden by collapsed regions
  (`checkVisibility`).
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
