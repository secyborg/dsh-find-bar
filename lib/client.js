// dsh-find-bar — client half (v0.5).
//
// The desktop app is an Electron shell with no built-in find-in-page bar.
// This plugin restores one, and fixes the three friction points of v0.4:
//
//   1. SEARCH NEVER MOVES THE VIEW. Typing only marks matches and counts
//      them (index = -1, counter shows the plain total). Locating happens
//      only on an explicit command (Enter / Shift+Enter / arrows / ⌘G / F3),
//      and the FIRST locate anchors to the current viewport — the first
//      match inside it, else the nearest one below (above when going
//      backwards) — so a search never yanks you back to the document top.
//      Navigation that targets an already-fully-visible match does not
//      scroll at all; scrolling that IS needed is a minimal nudge of the
//      nearest scrollable ancestor instead of a full scrollIntoView chain.
//
//   2. SCOPE IS A MULTI-SELECT AND FOLLOWS THE FOCUS REGION. The options
//      row (collapsed by default, ⋯ to open, state remembered) carries
//      chips 对话 / 面板 / 全部 — "全部" is the both-checked shortcut, not
//      a fourth value. A collapsed column greys its chip and is skipped
//      for this search WITHOUT overwriting the saved choice. When ⌖ 跟随
//      聚焦区 is on (default), opening the bar picks the region from
//        a live text selection's anchor node → else, only when the saved
//        choice is "全部", the last CLICKED region (pointerdown, not
//        hover) → else the saved choice. A temporary override blinks the
//        chip it picked; manual chip clicks are explicit intent and
//        always persist. Left sidebar stays out of scope (the dsh
//        workspace already searches it).
//
//   3. MATCH CASE + WHOLE WORD toggles (Aa / 全字, Alt+C / Alt+W, both
//      persisted). For whole-word, Latin letters/digits/underscore are
//      word characters and CJK is a natural boundary, so "find" skips
//      "finding" while "字体" still hits "字体太大".
//
// Layout columns are located without hashed CSS-module classes: the right
// column carries [data-rightbar-col] and the centre column is its
// previous sibling; the frame publishes data-rightbar-collapsed /
// data-rightbar-fullscreen. Region order follows the visual reading
// order (centre first, right first in rightbar-fullscreen).
//
// Highlights use the CSS Custom Highlight API — paint-only, zero DOM
// mutation, React keeps ownership. Environments without it fall back to
// window.find() and the options row is disabled (scope/case/word cannot
// be honoured there).
//
// Keyboard:
//   Cmd/Ctrl+F  open (prefilled with the live selection)
//   Enter       next match      Shift+Enter  previous match
//   Cmd/Ctrl+G / F3  next       +Shift       previous
//   Alt+C / Alt+W    match case / whole word
//   Esc         close and clear highlights
//
// The apply() returns a disposer so a live-patch reload removes the old
// listeners and bar; a generation number on window heals duplicate
// instances from HMR reloads.

window.__ModuleLoader__.load({
	id: "dsh-find-bar",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;

		var BAR_ID = "dsh-find-bar-root";
		var TIP_ID = "dsh-find-bar-tip";
		var HL_ALL = "dsh-find-bar-all";
		var HL_CUR = "dsh-find-bar-cur";
		var MAX_MATCHES = 5000;
		var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1 };
		var TIP_DELAY = 500;

		// Storage (all values are validated on read; unknown/stale → default).
		var SCOPE_KEY = "dsh-find-bar.scope";   // "chat" | "right" | "all"
		var MATCH_KEY = "dsh-find-bar.match";   // {"c":bool,"w":bool}
		var FOLLOW_KEY = "dsh-find-bar.follow"; // "0" | "1"
		var OPTS_KEY = "dsh-find-bar.opts";     // "0" | "1" (options row open)
		var DEFAULT_SCOPE = "chat";
		var SAVED_SCOPES = { chat: 1, right: 1, all: 1 };

		// UI strings per language; zh mirrors the dsh locale dictionaries.
		function buildStrings(lang) {
			if (lang === "zh") return {
				placeholder: "查找…",
				prev: "上一个匹配",
				next: "下一个匹配",
				close: "关闭查找",
				options: "查找选项",
				scopeChat: "对话",
				scopeRight: "面板",
				scopeAll: "全部",
				chatTip: "在对话区域查找",
				rightTip: "在右侧面板查找",
				allTip: "两栏一起查找（对话+面板）",
				caseTip: "区分大小写 (Alt+C)",
				wordTip: "全字匹配 (Alt+W)",
				followTip: "跟随聚焦区：打开时按选区/点击所在栏临时选择范围",
				legacyTip: "当前环境不支持高亮 API，选项不可用",
				scopeLabel: "搜索范围"
			};
			return {
				placeholder: "Find…",
				prev: "Previous match",
				next: "Next match",
				close: "Close find",
				options: "Find options",
				scopeChat: "Chat",
				scopeRight: "Panel",
				scopeAll: "All",
				chatTip: "Search the conversation",
				rightTip: "Search the right panel",
				allTip: "Search both columns",
				caseTip: "Match case (Alt+C)",
				wordTip: "Whole word (Alt+W)",
				followTip: "Follow focus: pick the region of the selection / last click when opening",
				legacyTip: "Highlight API unavailable — options disabled",
				scopeLabel: "Search scope"
			};
		}

		// Active dsh language: the locale service mirrors it onto
		// <html lang> ("zh-CN" / "en"); browser language is only a fallback.
		function detectLanguage() {
			try {
				var lang = String(document.documentElement.lang || "").toLowerCase();
				if (lang.indexOf("zh") === 0) return "zh";
				if (lang.indexOf("en") === 0) return "en";
			} catch (error) {}
			return /^zh/i.test(typeof navigator !== "undefined" && navigator.language || "") ? "zh" : "en";
		}

		var L = buildStrings(detectLanguage());

		// Cross-instance single-seat on window (generation healing), as in 0.4.
		var NS = "__dshFindBar";
		var GEN_KEY = "__dshFindBarGen";

		//#region pure helpers (exported for tests)

		// Whole-word boundary model: Latin letter/digit/underscore are word
		// characters; CJK (Han/kana/Hangul) counts as a boundary, so Chinese
		// queries still match inside unspaced runs. Handles surrogate pairs
		// by reading code points, not code units.
		function isWordChar(cp) {
			if (!cp) return false;
			var ch = String.fromCodePoint(cp);
			if (!/[\p{L}\p{N}_]/u.test(ch)) return false;
			return !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch);
		}

		// Code point immediately before index i (or 0 at start).
		function codePointBefore(text, i) {
			if (i <= 0) return 0;
			var c = text.charCodeAt(i - 1);
			if (c >= 0xdc00 && c <= 0xdfff) return text.codePointAt(Math.max(0, i - 2)) || 0;
			return c;
		}

		// Code point at index i (or 0 past the end).
		function codePointAt(text, i) {
			if (i >= text.length) return 0;
			return text.codePointAt(i) || 0;
		}

		// Start indices of `query` in `text`. Options:
		//   matchCase  — byte-exact case (default: folded)
		//   wholeWord  — both edges must be non-word characters
		function findIndices(text, query, options) {
			if (!query) return [];
			var opts = options || {};
			var haystack = opts.matchCase ? String(text) : String(text).toLowerCase();
			var needle = opts.matchCase ? String(query) : String(query).toLowerCase();
			var out = [];
			var i = haystack.indexOf(needle);
			while (i !== -1) {
				if (!opts.wholeWord || (
					!isWordChar(codePointBefore(haystack, i)) &&
					!isWordChar(codePointAt(haystack, i + needle.length))
				)) out.push(i);
				if (out.length >= MAX_MATCHES) break;
				i = haystack.indexOf(needle, i + needle.length);
			}
			return out;
		}

		// Locate the centre/right layout columns and their collapse state
		// from live markup (same stable anchors as 0.4).
		function probeColumns(doc) {
			var right = doc.querySelector("[data-rightbar-col]") || null;
			var chat = right ? right.previousElementSibling : null;
			var frame = right ? right.parentElement : null;
			var fullscreen = !!frame && frame.hasAttribute("data-rightbar-fullscreen");
			return {
				roots: { chat: chat, right: right },
				collapsed: {
					chat: !chat,
					right: !right || (!!frame && frame.hasAttribute("data-rightbar-collapsed") && !fullscreen)
				},
				order: fullscreen ? ["right", "chat"] : ["chat", "right"]
			};
		}

		// The saved scope as a list of regions: "all" is the both-checked
		// shortcut; migration of pre-0.3 "all" therefore lands on both.
		function scopeList(scope) {
			if (scope === "all") return ["chat", "right"];
			return [scope === "right" ? "right" : "chat"];
		}

		// Regions actually searched for a saved scope: in visual reading
		// order, collapsed columns dropped (saved choice untouched).
		function resolveRegions(scope, probe) {
			var wanted = {};
			var list = scopeList(scope);
			for (var i = 0; i < list.length; i++) wanted[list[i]] = true;
			var out = [];
			var order = probe.order || ["chat", "right"];
			for (var k = 0; k < order.length; k++) {
				var r = order[k];
				if (wanted[r] && !probe.collapsed[r]) out.push(r);
			}
			return out.length > 0 ? out : (probe.collapsed.chat ? out : ["chat"]);
		}

		// Last saved scope, migrated/validated; unknown values → default.
		function readScope() {
			try {
				var saved = localStorage.getItem(SCOPE_KEY);
				if (SAVED_SCOPES[saved]) return saved;
			} catch (error) {}
			return DEFAULT_SCOPE;
		}

		function saveScope(scope) {
			try { localStorage.setItem(SCOPE_KEY, SAVED_SCOPES[scope] ? scope : DEFAULT_SCOPE); } catch (error) {}
		}

		function readMatchOptions() {
			try {
				var raw = JSON.parse(localStorage.getItem(MATCH_KEY) || "{}");
				return { matchCase: !!raw.c, wholeWord: !!raw.w };
			} catch (error) {}
			return { matchCase: false, wholeWord: false };
		}

		function saveMatchOptions(opts) {
			try { localStorage.setItem(MATCH_KEY, JSON.stringify({ c: !!opts.matchCase, w: !!opts.wholeWord })); } catch (error) {}
		}

		function readFlag(key, dflt) {
			try {
				var v = localStorage.getItem(key);
				if (v === "0") return false;
				if (v === "1") return true;
			} catch (error) {}
			return dflt;
		}

		function saveFlag(key, on) {
			try { localStorage.setItem(key, on ? "1" : "0"); } catch (error) {}
		}

		// Which region a DOM node belongs to (null outside both columns,
		// e.g. sidebar, titlebar, overlays).
		function regionOfNode(node, doc) {
			if (!node) return null;
			var el = node.nodeType === 1 ? node : node.parentElement;
			if (!el || !el.closest) return null;
			var root = el.getRootNode ? el.getRootNode() : null;
			var docRoot = root === doc || root === document ? el : null;
			if (!docRoot) return null; // inside a shadow tree: out of scope for focus rules
			if (docRoot.closest("[data-rightbar-col]")) return "right";
			var right = doc.querySelector("[data-rightbar-col]");
			var chat = right ? right.previousElementSibling : null;
			if (chat && (docRoot === chat || chat.contains(docRoot))) return "chat";
			return null;
		}

		// Focus rule at open() time. Priority:
		//   selection region → (saved "all" only) clicked region → saved.
		// follow=false short-circuits everything to the saved choice.
		// A picked region is honoured only while its column is visible.
		function initialScope(saved, follow, selRegion, clickRegion, collapsed) {
			if (!follow) return saved;
			if (selRegion && !collapsed[selRegion]) return selRegion;
			if (saved === "all" && clickRegion && !collapsed[clickRegion]) return clickRegion;
			return saved;
		}

		// Counter text: "" while empty, "0" with no hits, the plain TOTAL
		// while nothing is located yet (index < 0), "n/N+" once navigating.
		function counterText(index, total, query, capped) {
			if (!query) return "";
			if (total === 0) return "0";
			var suffix = capped ? "+" : "";
			if (index < 0) return total + suffix;
			return (index + 1) + "/" + total + suffix;
		}

		// First locate anchors to the viewport: forwards = first match
		// intersecting the viewport, else the nearest one below, else wrap
		// to 0; backwards mirrors that. Pure over getBoundingClientRect().
		function firstIndexFromViewport(ranges, backwards, viewportHeight) {
			var vh = viewportHeight || 9;
			var n = ranges.length;
			if (n === 0) return -1;
			var i, rect;
			for (i = 0; i < n; i++) {
				rect = ranges[i].getBoundingClientRect();
				if (rect.bottom > 0 && rect.top < vh) return backwards ? lastVisible(ranges, i, vh) : i;
			}
			if (!backwards) {
				for (i = 0; i < n; i++) {
					rect = ranges[i].getBoundingClientRect();
					if (rect.top >= vh) return i;
				}
				return 0;
			}
			for (i = n - 1; i >= 0; i--) {
				rect = ranges[i].getBoundingClientRect();
				if (rect.bottom <= 0) return i;
			}
			return n - 1;
		}

		// Backwards first-locate: the LAST match still inside the viewport.
		function lastVisible(ranges, fromIndex, vh) {
			for (var j = ranges.length - 1; j >= fromIndex; j--) {
				var rect = ranges[j].getBoundingClientRect();
				if (rect.bottom > 0 && rect.top < vh) return j;
			}
			return fromIndex;
		}

		// Index for the current match after a silent rescan: exact anchor
		// (same text node + offset), else the next match in the same node,
		// else clamp the old index; -1 when there is nothing to keep.
		function relocateIndex(prev, ranges) {
			if (!prev || prev.index < 0) return -1;
			var i;
			for (i = 0; i < ranges.length; i++) {
				if (ranges[i].startContainer === prev.node && ranges[i].startOffset === prev.offset) return i;
			}
			for (i = 0; i < ranges.length; i++) {
				if (ranges[i].startContainer === prev.node && ranges[i].startOffset >= prev.offset) return i;
			}
			return ranges.length > 0 ? Math.min(prev.index, ranges.length - 1) : -1;
		}

		// Element is actually rendered (folded tool steps / hidden panes
		// are skipped from matching).
		function textHostVisible(parent) {
			if (!parent) return false;
			if (typeof parent.checkVisibility === "function") return parent.checkVisibility();
			if (parent.closest && parent.closest("[hidden]")) return false;
			try {
				var owner = parent.ownerDocument || document;
				return owner.defaultView.getComputedStyle(parent).display !== "none";
			} catch (error) {
				return true;
			}
		}

		// Keyboard routing, isolated so tests can drive it with spies.
		function createHandlers(ops) {
			return function onKeydown(event) {
				var meta = event.metaKey || event.ctrlKey;
				var key = event.key;
				if (meta && (key === "f" || key === "F")) {
					event.preventDefault();
					event.stopPropagation();
					ops.open();
					return;
				}
				if (!ops.isOpen()) return;
				if (key === "Escape") {
					event.preventDefault();
					ops.close();
					return;
				}
				if (event.altKey && !meta) {
					if (key === "c" || key === "C") { event.preventDefault(); ops.toggleCase(); return; }
					if (key === "w" || key === "W") { event.preventDefault(); ops.toggleWord(); return; }
				}
				var jumpKey = (meta && (key === "g" || key === "G")) || key === "F3";
				if (jumpKey) {
					event.preventDefault();
					ops.goTo(event.shiftKey ? -1 : 1);
					return;
				}
				if (key === "Enter" && !event.isComposing && ops.isBarInput(event.target)) {
					event.preventDefault();
					ops.goTo(event.shiftKey ? -1 : 1);
				}
			};
		}
		//#endregion

		function cssText() {
			return "" +
				"#" + BAR_ID + "{position:fixed;top:46px;right:16px;z-index:2147483000;flex-direction:column;align-items:stretch;gap:0;padding:6px 8px;display:flex;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:var(--dsw-shadow-lv2)}" +
				"#" + BAR_ID + " .row{align-items:center;gap:6px;display:flex}" +
				"#" + BAR_ID + " .opts{align-items:center;gap:4px;margin-top:6px;padding-top:6px;display:flex;border-top:1px solid var(--dsw-alias-border-l2)}" +
				"#" + BAR_ID + " input{width:210px;height:28px;color:var(--dsw-alias-label-primary);font:13px/1 var(--dsw-font-family);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;outline:none;padding:0 8px}" +
				"#" + BAR_ID + " input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}" +
				"#" + BAR_ID + " .count{min-width:44px;color:var(--dsw-alias-label-tertiary);font:12px/1 var(--dsw-font-family);font-variant-numeric:tabular-nums;text-align:center}" +
				"#" + BAR_ID + " button{height:26px;min-width:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;align-items:center;justify-content:center;display:inline-flex;padding:0 4px}" +
				"#" + BAR_ID + " button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
				"#" + BAR_ID + " button:disabled{opacity:.35;cursor:default}" +
				"#" + BAR_ID + " .chip{font:11px/1 var(--dsw-font-family);padding:0 7px;border-radius:5px}" +
				"#" + BAR_ID + " .chip[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
				"#" + BAR_ID + " .chip.blink{animation:dsh-find-bar-blink .9s ease}" +
				"#" + BAR_ID + " .mini{font:11px/1 var(--dsw-font-family);padding:0 6px;border-radius:5px}" +
				"#" + BAR_ID + " .mini[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
				"#" + BAR_ID + " .sep{width:1px;height:16px;background:var(--dsw-alias-border-l2);margin:0 2px}" +
				"@keyframes dsh-find-bar-blink{0%,60%{background:var(--dsw-alias-state-business-primary,rgba(245,166,35,.55));color:var(--dsw-static-neutral-bluish-00,#fff)}100%{background:var(--dsw-alias-interactive-bg-hover)}}" +
				"#" + TIP_ID + "{position:fixed;z-index:2147483001;width:max-content;max-width:min(50vw,calc(100vw - 24px));box-sizing:border-box;padding:3px 7px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00,#fff);font:13px/20px var(--dsw-font-family);white-space:pre-line;overflow-wrap:break-word;pointer-events:none;transform:translateX(-50%);animation:dsh-find-bar-tip-in .15s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}" +
				"@keyframes dsh-find-bar-tip-in{0%{opacity:0}}" +
				"#" + BAR_ID + " svg{pointer-events:none}" +
				"::highlight(" + HL_ALL + "){background-color:rgba(245,197,24,.42)}" +
				"::highlight(" + HL_CUR + "){background-color:#f5a623;color:#141414}";
		}

		function injectCss() {
			if (typeof document === "undefined") return;
			var tagId = "dsh-find-bar/bar.css";
			var tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]");
			if (tag === null) {
				tag = document.createElement("style");
				tag.setAttribute("data-plugin-css", tagId);
				document.head.appendChild(tag);
			}
			tag.textContent = cssText();
		}

		function highlightsSupported() {
			return typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";
		}

		function collectTextNodes(root, into) {
			if (!root) return into;
			var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
				acceptNode: function (node) {
					var parent = node.parentElement;
					if (parent === null) return NodeFilter.FILTER_REJECT;
					if (SKIP_TAGS[parent.tagName]) return NodeFilter.FILTER_REJECT;
					if (parent.closest && parent.closest("#" + BAR_ID)) return NodeFilter.FILTER_REJECT;
					return node.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
				}
			});
			var node;
			while ((node = walker.nextNode()) !== null) into.push(node);
			var elems = root.querySelectorAll ? root.querySelectorAll("*") : [];
			for (var i = 0; i < elems.length; i++) {
				if (elems[i].shadowRoot) collectTextNodes(elems[i].shadowRoot, into);
			}
			return into;
		}

		// Collect matches across every active region, in reading order.
		function collectRanges(query, regions, options) {
			var ranges = [];
			if (!query || typeof document === "undefined" || document.body === null) return ranges;
			var probe = probeColumns(document);
			for (var r = 0; r < regions.length && ranges.length < MAX_MATCHES; r++) {
				var root = probe.roots[regions[r]];
				if (!root) continue;
				var nodes = collectTextNodes(root, []);
				for (var i = 0; i < nodes.length && ranges.length < MAX_MATCHES; i++) {
					var node = nodes[i];
					var indices = findIndices(node.data, query, options);
					if (indices.length === 0) continue;
					if (!textHostVisible(node.parentElement)) continue;
					for (var j = 0; j < indices.length && ranges.length < MAX_MATCHES; j++) {
						var range = document.createRange();
						range.setStart(node, indices[j]);
						range.setEnd(node, indices[j] + query.length);
						ranges.push(range);
					}
				}
			}
			return ranges;
		}

		function makeHighlight(ranges) {
			if (ranges.length === 0) return new Highlight();
			var highlight = new Highlight(ranges[0]);
			for (var i = 1; i < ranges.length; i++) highlight.add(ranges[i]);
			return highlight;
		}

		// Nearest ancestor that can actually scroll vertically.
		function scrollableAncestor(el) {
			var owner = el && el.ownerDocument || document;
			var view = owner.defaultView || window;
			for (var node = el; node && node !== owner.body; node = node.parentElement) {
				if (node.scrollHeight > node.clientHeight + 1) {
					try {
						var oy = view.getComputedStyle(node).overflowY;
						if (oy === "auto" || oy === "scroll") return node;
					} catch (error) {}
				}
			}
			return null;
		}

		// Minimal-displacement reveal: do nothing when the match is already
		// fully visible; nudge only the nearest scrollable ancestor (or the
		// page) by the exact missing amount.
		function revealRange(range) {
			var rect;
			try { rect = range.getBoundingClientRect(); } catch (error) { return; }
			if (!rect) return;
			var vh = window.innerHeight || document.documentElement.clientHeight;
			if (rect.top >= 0 && rect.bottom <= vh) return;
			var el = range.startContainer.parentElement;
			var cont = el ? scrollableAncestor(el) : null;
			var MARGIN = 40;
			if (cont) {
				var cr = cont.getBoundingClientRect();
				var delta = 0;
				if (rect.top < cr.top) delta = rect.top - cr.top - MARGIN;
				else if (rect.bottom > cr.bottom) delta = rect.bottom - cr.bottom + MARGIN;
				try { cont.scrollBy({ top: delta, behavior: "smooth" }); } catch (error) { cont.scrollTop += delta; }
			} else if (el && el.scrollIntoView) {
				try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (error) {}
			}
		}

		//#region bar UI + state

		var state = {
			bar: null, input: null, count: null, optsRow: null, tip: null,
			chips: {}, btnCase: null, btnWord: null, btnFollow: null, btnGear: null,
			query: "", savedScope: DEFAULT_SCOPE, scope: DEFAULT_SCOPE,
			match: { matchCase: false, wholeWord: false },
			follow: true, optsOpen: false,
			clickRegion: null,
			ranges: [], index: -1, capped: false,
			observer: null, debounce: 0
		};

		function paint() {
			if (!highlightsSupported()) return;
			CSS.highlights.delete(HL_ALL);
			CSS.highlights.delete(HL_CUR);
			if (state.ranges.length > 0) {
				CSS.highlights.set(HL_ALL, makeHighlight(state.ranges));
				if (state.index >= 0 && state.index < state.ranges.length) {
					CSS.highlights.set(HL_CUR, makeHighlight([state.ranges[state.index]]));
				}
			}
		}

		function updateCount() {
			if (!state.count) return;
			state.count.textContent = counterText(state.index, state.ranges.length, state.query, state.capped);
		}

		// COLLECT ONLY: never scrolls, never activates a current match.
		// keepIndex re-anchors the already-located match across rescan.
		function runSearch(keepIndex) {
			var prev = keepIndex && state.index >= 0 && state.ranges[state.index] ? {
				index: state.index,
				node: state.ranges[state.index].startContainer,
				offset: state.ranges[state.index].startOffset
			} : null;
			state.scope = effectiveScopeNow();
			state.ranges = collectRanges(state.query, resolveRegions(state.scope, probeColumns(document)), state.match);
			state.capped = state.ranges.length >= MAX_MATCHES;
			state.index = prev ? relocateIndex(prev, state.ranges) : -1;
			paint();
			updateCount();
			syncOptionUi();
		}

		// What this search actually uses right now (collapsed columns drop
		// out of "all" automatically; "right" alone falls back to chat).
		function effectiveScopeNow() {
			var probe = probeColumns(document);
			var regions = resolveRegions(state.scope, probe);
			if (regions.length === 0) return DEFAULT_SCOPE;
			if (regions.length === 2) return "all";
			return regions[0];
		}

		// EXPLICIT navigation — the only path that moves the view.
		function goTo(delta) {
			var n = state.ranges.length;
			if (n === 0) return;
			if (!highlightsSupported()) { legacyFind(state.query, delta < 0); return; }
			if (state.index < 0) {
				state.index = firstIndexFromViewport(state.ranges, delta < 0, window.innerHeight);
			} else {
				state.index = ((state.index + delta) % n + n) % n;
			}
			paint();
			updateCount();
			if (state.index >= 0) revealRange(state.ranges[state.index]);
		}

		function legacyFind(query, backwards) {
			if (typeof window.find === "function") {
				try { window.find(query, false, backwards, true); } catch (error) {}
			}
		}

		function scheduleRescan() {
			clearTimeout(state.debounce);
			state.debounce = setTimeout(function () {
				if (state.bar) runSearch(true);
			}, 250);
		}

		function startObserver() {
			if (state.observer || typeof MutationObserver === "undefined") return;
			state.observer = new MutationObserver(scheduleRescan);
			state.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
		}

		function stopObserver() {
			if (state.observer) { state.observer.disconnect(); state.observer = null; }
			clearTimeout(state.debounce);
		}

		function icon(d, size) {
			var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", size); svg.setAttribute("height", size);
			svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2");
			svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
			var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			path.setAttribute("d", d);
			svg.appendChild(path);
			return svg;
		}

		function button(label, d, onClick, tipText) {
			var btn = document.createElement("button");
			btn.type = "button";
			btn.setAttribute("aria-label", label);
			btn.appendChild(icon(d, 14));
			if (tipText) btn.setAttribute("data-tip", tipText); else btn.setAttribute("data-tip", label);
			btn.addEventListener("click", onClick);
			return btn;
		}

		function chip(label, tipText, onClick) {
			var btn = document.createElement("button");
			btn.type = "button";
			btn.className = "chip";
			btn.textContent = label;
			btn.setAttribute("data-scope-label", label);
			btn.setAttribute("aria-pressed", "false");
			btn.setAttribute("data-tip", tipText);
			btn.addEventListener("click", onClick);
			return btn;
		}

		// Explicit chip intent: always persisted. "全部" toggles both;
		// single chips toggle their region, last-checked cannot uncheck.
		function toggleScope(target) {
			var list = scopeList(state.scope);
			var set = {};
			for (var i = 0; i < list.length; i++) set[list[i]] = true;
			if (target === "all") {
				set = { chat: true, right: true };
			} else {
				if (set[target]) {
					delete set[target];
					if (!set.chat && !set.right) return; // never empty
				} else {
					set[target] = true;
					if (set.chat && set.right) set = { chat: true, right: true };
				}
			}
			var next = set.chat && set.right ? "all" : (set.right ? "right" : "chat");
			state.scope = next;
			saveScope(next);
			state.savedScope = next;
			runSearch(false);
		}

		function toggleMatch(key) {
			state.match[key] = !state.match[key];
			saveMatchOptions(state.match);
			runSearch(false);
		}

		function syncOptionUi() {
			if (!state.chips.chat) return;
			var probe = probeColumns(document);
			var list = scopeList(state.scope);
			var wanted = {};
			for (var i = 0; i < list.length; i++) wanted[list[i]] = true;
			["chat", "right"].forEach(function (name) {
				var el = state.chips[name];
				if (!el) return;
				el.setAttribute("aria-pressed", wanted[name] ? "true" : "false");
				el.disabled = !!probe.collapsed[name];
			});
			state.chips.all.setAttribute("aria-pressed", wanted.chat && wanted.right ? "true" : "false");
			state.chips.all.disabled = !!probe.collapsed.chat || !!probe.collapsed.right;
			state.btnCase.setAttribute("aria-pressed", state.match.matchCase ? "true" : "false");
			state.btnWord.setAttribute("aria-pressed", state.match.wholeWord ? "true" : "false");
			state.btnFollow.setAttribute("aria-pressed", state.follow ? "true" : "false");
		}

		function blinkChips() {
			var list = scopeList(state.scope);
			for (var i = 0; i < list.length; i++) {
				var el = state.chips[list[i]];
				if (!el) continue;
				el.classList.remove("blink");
				void el.offsetWidth; // restart the animation
				el.classList.add("blink");
			}
		}

		// One shared dsh-style tooltip bubble for every data-tip control.
		function attachTips(root) {
			var timer = 0;
			var shown = null;
			function hide() {
				clearTimeout(timer);
				shown = null;
				if (state.tip) { state.tip.remove(); state.tip = null; }
			}
			root.addEventListener("pointerover", function (event) {
				var host = event.target && event.target.closest ? event.target.closest("[data-tip]") : null;
				if (!host || host === shown) return;
				hide();
				shown = host;
				timer = setTimeout(function () {
					if (!shown || !state.bar || !state.bar.isConnected) return;
					L = buildStrings(detectLanguage());
					var tip = document.createElement("div");
					tip.id = TIP_ID;
					tip.setAttribute("role", "tooltip");
					tip.textContent = shown.getAttribute("data-tip") || "";
					document.body.appendChild(tip);
					var box = shown.getBoundingClientRect();
					tip.style.top = box.bottom + 6 + "px";
					tip.style.left = Math.min(Math.max(box.left + box.width / 2, 8), window.innerWidth - 8) + "px";
					state.tip = tip;
				}, TIP_DELAY);
			});
			root.addEventListener("pointerout", function (event) {
				var host = event.target && event.target.closest ? event.target.closest("[data-tip]") : null;
				if (host && (!event.relatedTarget || !host.contains(event.relatedTarget))) hide();
			});
			root.addEventListener("click", hide);
		}

		function buildOptionsRow() {
			var row = document.createElement("div");
			row.className = "opts";

			var group = document.createElement("div");
			group.setAttribute("role", "group");
			group.setAttribute("aria-label", L.scopeLabel);
			state.chips = {
				chat: chip(L.scopeChat, L.chatTip, function () { toggleScope("chat"); }),
				right: chip(L.scopeRight, L.rightTip, function () { toggleScope("right"); }),
				all: chip(L.scopeAll, L.allTip, function () { toggleScope("all"); })
			};
			group.appendChild(state.chips.chat);
			group.appendChild(state.chips.right);
			group.appendChild(state.chips.all);
			row.appendChild(group);

			var sep1 = document.createElement("span");
			sep1.className = "sep";
			row.appendChild(sep1);

			state.btnCase = document.createElement("button");
			state.btnCase.type = "button";
			state.btnCase.className = "mini";
			state.btnCase.textContent = "Aa";
			state.btnCase.setAttribute("aria-label", L.caseTip);
			state.btnCase.setAttribute("data-tip", L.caseTip);
			state.btnCase.addEventListener("click", function () { toggleMatch("matchCase"); });
			row.appendChild(state.btnCase);

			state.btnWord = chip(detectLanguage() === "zh" ? "全字" : "Word", L.wordTip, function () { toggleMatch("wholeWord"); });
			state.btnWord.setAttribute("aria-label", state.btnWord.textContent);
			row.appendChild(state.btnWord);

			var sep2 = document.createElement("span");
			sep2.className = "sep";
			row.appendChild(sep2);

			state.btnFollow = button("⌖", "M12 2v3m0 14v3M2 12h3m14 0h3m-9-4.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z", function () {
				state.follow = !state.follow;
				saveFlag(FOLLOW_KEY, state.follow);
				syncOptionUi();
			}, L.followTip);
			state.btnFollow.className = "mini";
			row.appendChild(state.btnFollow);

			return row;
		}

		function buildBar() {
			var bar = document.createElement("div");
			bar.id = BAR_ID;
			bar.setAttribute("role", "search");

			var row = document.createElement("div");
			row.className = "row";

			var input = document.createElement("input");
			input.type = "text";
			input.placeholder = L.placeholder;
			input.setAttribute("aria-label", L.placeholder);
			// Typing only marks + counts. The view never moves.
			input.addEventListener("input", function () {
				state.query = input.value;
				runSearch(false);
			});

			var count = document.createElement("span");
			count.className = "count";
			count.setAttribute("aria-live", "polite");

			row.appendChild(input);
			row.appendChild(count);
			row.appendChild(button(L.prev, "m18 15-6-6-6 6", function () { goTo(-1); }));
			row.appendChild(button(L.next, "m6 9 6 6 6-6", function () { goTo(1); }));
			state.btnGear = button(L.options, "M5 12h.01M12 12h.01M19 12h.01", function () {
				state.optsOpen = !state.optsOpen;
				saveFlag(OPTS_KEY, state.optsOpen);
				state.optsRow.style.display = state.optsOpen ? "flex" : "none";
			}, L.options);
			row.appendChild(state.btnGear);
			row.appendChild(button(L.close, "M18 6 6 18M6 6l12 12", close));

			state.optsRow = buildOptionsRow();
			state.optsRow.style.display = state.optsOpen ? "flex" : "none";
			// window.find() fallback cannot honour scope/case/word: grey the
			// whole options row out instead of pretending it works.
			if (!highlightsSupported()) {
				var controls = state.optsRow.querySelectorAll("button");
				for (var i = 0; i < controls.length; i++) {
					controls[i].disabled = true;
					controls[i].setAttribute("data-tip", L.legacyTip);
				}
			}

			bar.appendChild(row);
			bar.appendChild(state.optsRow);

			state.bar = bar;
			state.input = input;
			state.count = count;
			attachTips(bar);
			document.body.appendChild(bar);
			syncOptionUi();
		}

		function removeStrayBars() {
			if (typeof document === "undefined") return;
			var strays = document.querySelectorAll("#" + BAR_ID);
			for (var i = 0; i < strays.length; i++) {
				if (strays[i] !== state.bar) strays[i].remove();
			}
		}

		function refreshStrings() {
			L = buildStrings(detectLanguage());
			if (!state.input) return;
			state.input.placeholder = L.placeholder;
			var labels = { chat: L.scopeChat, right: L.scopeRight, all: L.scopeAll };
			var tips = { chat: L.chatTip, right: L.rightTip, all: L.allTip };
			["chat", "right", "all"].forEach(function (name) {
				var el = state.chips[name];
				if (!el) return;
				el.textContent = labels[name];
				el.setAttribute("data-tip", tips[name]);
			});
			state.btnWord.textContent = detectLanguage() === "zh" ? "全字" : "Word";
			state.btnWord.setAttribute("data-tip", L.wordTip);
			state.btnCase.setAttribute("data-tip", L.caseTip);
			state.btnFollow.setAttribute("data-tip", state.follow ? L.followTip : L.followTip);
		}

		function currentSelection() {
			try { return window.getSelection(); } catch (error) { return null; }
		}

		function selectionRegion(sel, doc) {
			if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
			var node = sel.anchorNode;
			return regionOfNode(node, doc);
		}

		function open() {
			if (typeof document === "undefined" || document.body === null) return;
			refreshStrings();
			state.follow = readFlag(FOLLOW_KEY, true);
			state.optsOpen = readFlag(OPTS_KEY, false);
			if (!state.bar) {
				state.savedScope = readScope();
				state.scope = state.savedScope;
				state.match = readMatchOptions();
				buildBar();
			} else {
				state.savedScope = readScope();
			}
			removeStrayBars();
			if (state.optsRow) state.optsRow.style.display = state.optsOpen ? "flex" : "none";
			state.bar.style.display = "flex";

			var sel = currentSelection();
			var selText = "";
			try { selText = String(sel).trim(); } catch (error) {}
			var selRegion = selectionRegion(sel, document);
			var picked = initialScope(state.savedScope, state.follow, selRegion, state.clickRegion, probeColumns(document).collapsed);
			state.scope = picked;
			if (picked !== state.savedScope) blinkChips();

			// Fresh search each open: prefill the live selection only.
			if (selText && selText.length <= 200) {
				state.input.value = selText;
				state.query = selText;
			} else {
				state.input.value = "";
				state.query = "";
			}
			state.index = -1;
			state.input.focus();
			state.input.select();
			runSearch(false);
			startObserver();
		}

		function close() {
			if (state.bar) state.bar.style.display = "none";
			if (state.tip) { state.tip.remove(); state.tip = null; }
			state.query = "";
			state.ranges = [];
			state.index = -1;
			paint();
			updateCount();
			stopObserver();
		}

		function isOpen() {
			return !!state.bar && state.bar.style.display !== "none";
		}

		// Track the last clicked region (pointerdown, NOT hover) for the
		// focus rule. Clicks inside the bar never touch it. One handler per
		// module instance; re-apply()s reuse it instead of stacking.
		var clickTracker = null;
		function installClickTracker() {
			if (typeof document === "undefined") return null;
			if (clickTracker) return clickTracker;
			clickTracker = function (event) {
				var t = event.target;
				if (t && t.closest && t.closest("#" + BAR_ID)) return;
				var region = regionOfNode(t, document);
				if (region) state.clickRegion = region;
			};
			document.addEventListener("pointerdown", clickTracker, true);
			return clickTracker;
		}
		//#endregion

		function apply() {
			injectCss();
			var previous = window[NS];
			if (previous && typeof previous.destroy === "function") {
				try { previous.destroy(); } catch (error) {}
			}
			window[GEN_KEY] = (typeof window[GEN_KEY] === "number" ? window[GEN_KEY] : 0) + 1;
			var generation = window[GEN_KEY];

			var ops = {
				open: open,
				close: close,
				goTo: goTo,
				isOpen: isOpen,
				toggleCase: function () { toggleMatch("matchCase"); },
				toggleWord: function () { toggleMatch("wholeWord"); },
				isBarInput: function (target) { return target === state.input; }
			};
			var handleKeydown = createHandlers(ops);
			var onKeydown = function (event) {
				if (window[GEN_KEY] !== generation) {
					window.removeEventListener("keydown", onKeydown, true);
					return;
				}
				handleKeydown(event);
			};
			window.addEventListener("keydown", onKeydown, true);

			var clickHandler = installClickTracker();

			var seat = {
				destroy: function destroy() {
					window.removeEventListener("keydown", onKeydown, true);
					if (clickHandler && typeof document !== "undefined") {
						document.removeEventListener("pointerdown", clickHandler, true);
						clickTracker = null;
					}
					close();
					if (state.bar) state.bar.remove();
					removeStrayBars();
					if (state.tip) { state.tip.remove(); state.tip = null; }
					state.bar = null;
					state.input = null;
					state.count = null;
					state.optsRow = null;
					state.chips = {};
					state.btnCase = null;
					state.btnWord = null;
					state.btnFollow = null;
					state.btnGear = null;
					if (window[NS] === seat) window[NS] = undefined;
				}
			};
			window[NS] = seat;
			return seat.destroy;
		}

		exports.apply = apply;
		exports.inject = [];
		exports.findIndices = findIndices;               // for tests
		exports.isWordChar = isWordChar;                 // for tests
		exports.createHandlers = createHandlers;         // for tests
		exports.detectLanguage = detectLanguage;         // for tests
		exports.probeColumns = probeColumns;             // for tests
		exports.scopeList = scopeList;                   // for tests
		exports.resolveRegions = resolveRegions;         // for tests
		exports.readScope = readScope;                   // for tests
		exports.readMatchOptions = readMatchOptions;     // for tests
		exports.saveMatchOptions = saveMatchOptions;   // for tests
		exports.readFlag = readFlag;                     // for tests
		exports.initialScope = initialScope;             // for tests
		exports.counterText = counterText;               // for tests
		exports.firstIndexFromViewport = firstIndexFromViewport; // for tests
		exports.relocateIndex = relocateIndex;           // for tests
		exports.textHostVisible = textHostVisible;       // for tests
		return module.exports;
	}
});
