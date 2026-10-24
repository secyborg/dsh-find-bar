// dsh-find-bar — client half (v0.4).
//
// The desktop app is an Electron shell, and Electron has no built-in
// find-in-page bar (the browser's Cmd+F does not exist there). This plugin
// restores it: a small find bar with highlight-all, a match counter, and
// Enter / Shift+Enter navigation. The search scope is a centre/right
// segmented picker over the AppFrame columns: the frame marks the right
// column with [data-rightbar-col] and renders the centre column right
// before it, so both roots resolve without relying on hashed CSS-module
// class names. (No sidebar scope: the dsh workspace already searches it.)
//
// Scope rules:
//   * Default scope is the centre column (the conversation).
//   * With the right column collapsed there is nothing to choose between:
//     the picker hides entirely and search stays on the conversation; the
//     picker reappears as soon as the column is opened. If the selected
//     scope collapses while searching, it falls back to the conversation
//     without overwriting the saved choice.
//   * Collapsed UI regions (auto-folded tool steps, hidden panes) are
//     skipped: matches inside elements hidden by CSS are dropped, and
//     expanding a region re-adds its matches on the next (debounced) rescan.
//
// The picker segments are text-free pills sharing one hover hint styled
// after the dsh ui-primitives Tooltip (500 ms delay, 150 ms fade-in,
// --dsw-alias-tooltip-bg, side: bottom) — native title tooltips are
// avoided so the look matches the app's own controls, not the OS. The
// bubble mounts on document.body: inside the bar, a transformed column
// ancestor would break position:fixed and drop it into the input row.
//
// UI strings follow the dsh locale: the locale service mirrors the active
// language onto <html lang> ("zh-CN" / "en"), so every open and every hint
// re-reads it (falling back to the browser language) instead of freezing
// one at module load.
//
// The apply() returns a disposer so a live-patch reload of this bundle
// removes the old keydown listener and bar; open() also removes any stray
// bar a previous instance may have left in the DOM.
//
// How it works without fighting React:
//   * Matches are collected as DOM Range objects (start/end offsets inside
//     text nodes) via a TreeWalker that also descends into shadow roots.
//   * Highlights use the CSS Custom Highlight API (CSS.highlights + Highlight)
//     which paints ranges WITHOUT mutating the DOM — React keeps full
//     ownership of the tree. Chromium/Electron support this since 105.
//   * When the API is unavailable, the bar degrades to the legacy
//     window.find() calls (no count, still functional).
//
// Keyboard:
//   Cmd/Ctrl+F  open (prefilled with the current selection)
//   Enter       next match      Shift+Enter  previous match
//   Cmd/Ctrl+G / F3  next       +Shift       previous
//   Esc         close and clear highlights

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

		// UI strings per language; zh mirrors the dsh locale dictionaries.
		function buildStrings(lang) {
			if (lang === "zh") return {
				placeholder: "查找…",
				prev: "上一个匹配",
				next: "下一个匹配",
				close: "关闭查找",
				cap: "已达匹配上限，仅显示前 {n} 条",
				scopeLabel: "搜索范围",
				scopeChatTitle: "搜索对话区域",
				scopeRightTitle: "搜索右侧面板",
				scopeHint: "搜索范围：左段 对话区域 ｜ 右段 右侧面板"
			};
			return {
				placeholder: "Find…",
				prev: "Previous match",
				next: "Next match",
				close: "Close find",
				cap: "Match limit reached, showing first {n}",
				scopeLabel: "Search scope",
				scopeChatTitle: "Search conversation",
				scopeRightTitle: "Search right panel",
				scopeHint: "Search scope: left = conversation · right = right panel"
			};
		}

		// Active dsh language: the locale service mirrors it onto
		// <html lang> ("zh-CN" / "en"), which also covers the "follow
		// system" mode; the browser language is only a fallback for the
		// moment before the locale service has synced.
		function detectLanguage() {
			try {
				var lang = String(document.documentElement.lang || "").toLowerCase();
				if (lang.indexOf("zh") === 0) return "zh";
				if (lang.indexOf("en") === 0) return "en";
			} catch (error) {}
			return /^zh/i.test(typeof navigator !== "undefined" && navigator.language || "") ? "zh" : "en";
		}

		var L = buildStrings(detectLanguage());

		// Segmented picker scopes over the centre/right AppFrame columns;
		// the conversation (centre) is the default and never collapses.
		// Segments carry no visible text; the description doubles as the
		// button's accessible name.
		var SCOPES = ["chat", "right"];
		var DEFAULT_SCOPE = "chat";
		var SCOPE_KEY = "dsh-find-bar.scope";
		var TIP_DELAY = 500;
		// Cross-instance single-seat on window: the newest apply() registers
		// its destroy() here, and a monotonically increasing generation
		// number lets every stale keydown listener unregister itself on the
		// next keypress. This heals duplicate instances no matter how many
		// times a live patch / HMR reload re-executes this module.
		var NS = "__dshFindBar";
		var GEN_KEY = "__dshFindBarGen";

		function scopeTitle(scope) {
			return scope === "right" ? L.scopeRightTitle : L.scopeChatTitle;
		}

		//#region pure helpers (exported for tests)

		// All non-overlapping case-insensitive start indices of `query` in
		// `text`; empty array for an empty query or no hits.
		function findIndices(text, query) {
			if (!query) return [];
			var haystack = String(text).toLowerCase();
			var needle = String(query).toLowerCase();
			var out = [];
			var i = haystack.indexOf(needle);
			while (i !== -1) {
				out.push(i);
				if (out.length >= MAX_MATCHES) break;
				i = haystack.indexOf(needle, i + needle.length);
			}
			return out;
		}

		// Locate the centre/right layout columns and their collapse state
		// from live markup: the right column carries the stable
		// [data-rightbar-col] attribute and the centre column renders right
		// before it. The frame parent publishes data-rightbar-collapsed when
		// the column is hidden; rightbar-fullscreen still shows the panel, so
		// it overrides the collapsed flag. Returns roots:null + collapsed:false
		// when the layout cannot be located (callers degrade to "no matches").
		function probeColumns(doc) {
			var right = doc.querySelector("[data-rightbar-col]") || null;
			var chat = right ? right.previousElementSibling : null;
			var frame = right ? right.parentElement : null;
			return {
				roots: { chat: chat, right: right },
				collapsed: {
					chat: !chat,
					right: !right || (!!frame && frame.hasAttribute("data-rightbar-collapsed") && !frame.hasAttribute("data-rightbar-fullscreen"))
				}
			};
		}

		// Resolve the DOM subtree a scope searches; null when the scope's
		// column is missing or collapsed (caller treats it as "no matches").
		function pickScopeRoot(scope, doc) {
			var probe = probeColumns(doc);
			if (probe.collapsed[scope]) return null;
			return probe.roots[scope] || null;
		}

		// The scope actually in force: a collapsed right column falls back
		// to the conversation without overwriting the saved preference.
		function effectiveScope(scope, collapsed) {
			return collapsed[scope] ? DEFAULT_SCOPE : scope;
		}

		// The picker is only meaningful with a second searchable region:
		// while the right column is collapsed, search is pinned to the
		// conversation and the picker hides entirely.
		function pickerVisible(collapsed) {
			return !collapsed.right;
		}

		// Last selected scope, persisted in localStorage; the default when
		// missing, rejected (stale/unknown — e.g. a pre-0.3 "all" or a
		// pre-0.4 "left"), or unreadable.
		function readScope() {
			try {
				var saved = localStorage.getItem(SCOPE_KEY);
				for (var i = 0; i < SCOPES.length; i++) {
					if (SCOPES[i] === saved) return saved;
				}
			} catch (error) {}
			return DEFAULT_SCOPE;
		}

		function saveScope(scope) {
			try { localStorage.setItem(SCOPE_KEY, scope); } catch (error) {}
		}

		// Whether the element containing a matched text node is actually
		// rendered (collapsed tool steps and hidden panes are skipped).
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
				"#" + BAR_ID + "{position:fixed;top:46px;right:16px;z-index:2147483000;align-items:center;gap:6px;padding:6px 8px;display:flex;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:var(--dsw-shadow-lv2)}" +
				"#" + BAR_ID + " .iwrap{position:relative;display:inline-flex}" +
				"#" + BAR_ID + " input{width:210px;height:28px;color:var(--dsw-alias-label-primary);font:13px/1 var(--dsw-font-family);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;outline:none;padding:0 44px 0 8px}" +
				"#" + BAR_ID + " input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}" +
			"#" + BAR_ID + " span{min-width:52px;color:var(--dsw-alias-label-tertiary);font:12px/1 var(--dsw-font-family);font-variant-numeric:tabular-nums;text-align:center}" +
			"#" + BAR_ID + " button{width:26px;height:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;align-items:center;justify-content:center;display:inline-flex}" +
			"#" + BAR_ID + " button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
			"#" + BAR_ID + " .seg{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:inline-flex;gap:1px;padding:1px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:7px}" +
			"#" + BAR_ID + " .seg button{width:16px;height:16px;min-width:0;padding:0;border-radius:4px}" +
			"#" + BAR_ID + " .seg button:hover:not([aria-checked=true]){background:var(--dsw-alias-interactive-bg-hover)}" +
			"#" + BAR_ID + " .seg button[aria-checked=true]{background:var(--dsw-alias-interactive-bg-hover)}" +
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
			// Always refresh the text: an HMR reload re-executes this module
			// while the previously injected <style> lives on — skipping would
			// freeze the rules at the first-loaded version and silently break
			// elements whose selectors changed between versions.
			tag.textContent = cssText();
		}

		function highlightsSupported() {
			return typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";
		}

		// Collect text nodes under `root`, descending into shadow roots and
		// skipping the find bar itself plus invisible metadata tags.
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
			while ((node = walker.nextNode()) !== null) {
				into.push(node);
				// descend shadow roots hosted by element siblings of this text
			}
			// shadow roots are not reached by TreeWalker — walk elements separately
			var elems = root.querySelectorAll ? root.querySelectorAll("*") : [];
			for (var i = 0; i < elems.length; i++) {
				if (elems[i].shadowRoot) collectTextNodes(elems[i].shadowRoot, into);
			}
			return into;
		}

		function collectRanges(query, scope) {
			var ranges = [];
			if (!query || typeof document === "undefined" || document.body === null) return ranges;
			var root = pickScopeRoot(scope, document);
			if (!root) return ranges;
			var nodes = collectTextNodes(root, []);
			for (var i = 0; i < nodes.length && ranges.length < MAX_MATCHES; i++) {
				var node = nodes[i];
				var indices = findIndices(node.data, query);
				if (indices.length === 0) continue;
				// Skip text hidden by a collapsed region (folded tool steps,
				// hidden panes): only check nodes that actually match, so the
				// visibility cost stays proportional to the hit count.
				if (!textHostVisible(node.parentElement)) continue;
				for (var j = 0; j < indices.length && ranges.length < MAX_MATCHES; j++) {
					var range = document.createRange();
					range.setStart(node, indices[j]);
					range.setEnd(node, indices[j] + query.length);
					ranges.push(range);
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

		function scrollToRange(range) {
			var el = range.startContainer.parentElement;
			if (el && el.scrollIntoView) {
				try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (error) {}
			}
		}

		//#region bar UI + state

		var state = { bar: null, input: null, seg: null, count: null, tip: null, query: "", scope: DEFAULT_SCOPE, ranges: [], index: -1, capped: false, observer: null, debounce: 0 };

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
			var n = state.ranges.length;
			if (!state.query) state.count.textContent = "";
			else if (n === 0) state.count.textContent = "0/0";
			else state.count.textContent = (state.index + 1) + "/" + n + (state.capped ? "+" : "");
		}

		function runSearch(keepIndex) {
			syncScopeAvailability();
			state.ranges = collectRanges(state.query, state.scope);
			state.capped = state.ranges.length >= MAX_MATCHES;
			if (!keepIndex || state.index >= state.ranges.length) state.index = state.ranges.length > 0 ? 0 : -1;
			paint();
			updateCount();
			if (state.index >= 0 && !highlightsSupported()) legacyFind(state.query, false);
		}

		function goTo(delta) {
			var n = state.ranges.length;
			if (n === 0) return;
			if (highlightsSupported()) {
				state.index = ((state.index + delta) % n + n) % n;
				paint();
				updateCount();
				scrollToRange(state.ranges[state.index]);
			} else {
				legacyFind(state.query, delta < 0);
			}
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
			// attributes:true keeps the picker in sync when the right column
			// collapses or opens and when folded regions expand again
			// (class/style/hidden flips).
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

		function button(label, d, onClick) {
			var btn = document.createElement("button");
			btn.type = "button";
			btn.setAttribute("aria-label", label);
			btn.title = label;
			btn.appendChild(icon(d, 14));
			btn.addEventListener("click", onClick);
			return btn;
		}

		// Set the active scope: picker UI only; `persist` saves the user's
		// explicit choice (automatic fallbacks do not overwrite it).
		function applyScope(scope, persist) {
			state.scope = scope;
			if (persist) saveScope(scope);
			if (!state.seg) return;
			var buttons = state.seg.querySelectorAll("button[data-scope]");
			for (var i = 0; i < buttons.length; i++) {
				buttons[i].setAttribute("aria-checked", buttons[i].getAttribute("data-scope") === scope ? "true" : "false");
			}
		}

		// Refresh picker visibility from the live layout: with the right
		// column collapsed there is nothing to choose between, so the picker
		// hides entirely and the search falls back to the conversation
		// (without overwriting the saved choice); it reappears when the
		// column opens again.
		function syncScopeAvailability() {
			if (!state.seg) return;
			var probe = probeColumns(document);
			state.seg.style.display = pickerVisible(probe.collapsed) ? "" : "none";
			if (probe.collapsed[state.scope]) applyScope(effectiveScope(state.scope, probe.collapsed), false);
		}

		// One shared hint bubble for the whole picker (not per segment),
		// mirroring the dsh ui-primitives Tooltip used by the app's own
		// expand/collapse controls: 500 ms hover delay, 150 ms fade-in,
		// --dsw-alias-tooltip-bg surface, centred below the picker. Mounts
		// on document.body — a transformed column ancestor would break
		// position:fixed inside the bar and drop the bubble into the row.
		function attachScopeTip(host) {
			var timer = 0;
			function hide() {
				clearTimeout(timer);
				if (state.tip) { state.tip.remove(); state.tip = null; }
			}
			function show() {
				if (state.tip || !state.bar || !state.bar.isConnected || state.bar.style.display === "none") return;
				L = buildStrings(detectLanguage());
				var tip = document.createElement("div");
				tip.id = TIP_ID;
				tip.setAttribute("role", "tooltip");
				tip.textContent = L.scopeHint;
				document.body.appendChild(tip);
				var box = host.getBoundingClientRect();
				tip.style.top = box.bottom + 6 + "px";
				tip.style.left = Math.min(Math.max(box.left + box.width / 2, 8), window.innerWidth - 8) + "px";
				state.tip = tip;
			}
			host.addEventListener("mouseenter", function () {
				clearTimeout(timer);
				timer = setTimeout(show, TIP_DELAY);
			});
			host.addEventListener("mouseleave", hide);
		}

		function buildSeg() {
			var seg = document.createElement("div");
			seg.className = "seg";
			seg.setAttribute("role", "radiogroup");
			seg.setAttribute("aria-label", L.scopeLabel);
			for (var i = 0; i < SCOPES.length; i++) {
				var btn = document.createElement("button");
				btn.type = "button";
				btn.setAttribute("role", "radio");
				btn.setAttribute("data-scope", SCOPES[i]);
				btn.setAttribute("aria-checked", SCOPES[i] === state.scope ? "true" : "false");
				btn.setAttribute("aria-label", scopeTitle(SCOPES[i]));
				btn.addEventListener("click", function (event) {
					applyScope(event.currentTarget.getAttribute("data-scope"), true);
					runSearch(false);
				});
				seg.appendChild(btn);
			}
			attachScopeTip(seg);
			return seg;
		}

		function buildBar() {
			var bar = document.createElement("div");
			bar.id = BAR_ID;
			bar.setAttribute("role", "search");

			var input = document.createElement("input");
			input.type = "text";
			input.placeholder = L.placeholder;
			input.setAttribute("aria-label", L.placeholder);
			input.addEventListener("input", function () {
				state.query = input.value;
				runSearch(false);
				if (state.ranges.length > 0 && highlightsSupported()) scrollToRange(state.ranges[state.index]);
			});

			var count = document.createElement("span");
			count.setAttribute("aria-live", "polite");

			var seg = buildSeg();

			// The picker overlays the input's right side (absolute inside a
			// wrapper), so hiding it when the right column collapses never
			// resizes the bar.
			var wrap = document.createElement("div");
			wrap.className = "iwrap";
			wrap.appendChild(input);
			wrap.appendChild(seg);

			bar.appendChild(wrap);
			bar.appendChild(count);
			bar.appendChild(button(L.prev, "m18 15-6-6-6 6", function () { goTo(-1); }));
			bar.appendChild(button(L.next, "m6 9 6 6 6-6", function () { goTo(1); }));
			bar.appendChild(button(L.close, "M18 6 6 18M6 6l12 12", close));

			state.bar = bar;
			state.input = input;
			state.seg = seg;
			state.count = count;
			document.body.appendChild(bar);
			syncScopeAvailability();
		}

		// Remove every find bar in the document except this instance's own —
		// duplicated bars from reloaded instances share the same id and stack
		// invisibly on top of each other.
		function removeStrayBars() {
			if (typeof document === "undefined") return;
			var strays = document.querySelectorAll("#" + BAR_ID);
			for (var i = 0; i < strays.length; i++) {
				if (strays[i] !== state.bar) strays[i].remove();
			}
		}

		// Re-read the dsh locale and refresh the already-built chrome so a
		// language switch inside Settings lands on the next open.
		function refreshStrings() {
			L = buildStrings(detectLanguage());
			if (!state.input) return;
			state.input.placeholder = L.placeholder;
			state.seg.setAttribute("aria-label", L.scopeLabel);
			var buttons = state.seg.querySelectorAll("button[data-scope]");
			for (var i = 0; i < buttons.length; i++) {
				buttons[i].setAttribute("aria-label", scopeTitle(buttons[i].getAttribute("data-scope")));
			}
		}

		function open() {
			if (typeof document === "undefined" || document.body === null) return;
			refreshStrings();
			if (!state.bar) {
				state.scope = readScope();
				buildBar();
			}
			removeStrayBars();
			state.bar.style.display = "flex";
			var selection = "";
			try { selection = String(window.getSelection()).trim(); } catch (error) {}
			// Every open starts a fresh search: prefill only the live page
			// selection (native find-bar behaviour), never the previous query.
			if (selection && selection.length <= 200) {
				state.input.value = selection;
				state.query = selection;
			} else {
				state.input.value = "";
				state.query = "";
			}
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
			paint(); // clears registered highlights
			updateCount();
			stopObserver();
		}

		function isOpen() {
			return !!state.bar && state.bar.style.display !== "none";
		}
		//#endregion

		const inject = [];

		function apply() {
			injectCss();
			// Take over the single seat: destroy the previous instance (its
			// listener, bar, observer), then bump the generation so any older
			// listener that outlived its module (pre-0.4 instances, or reloads
			// whose disposer was not invoked) unregisters itself on the next
			// keypress instead of stacking more bars.
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

			var seat = {
				destroy: function destroy() {
					window.removeEventListener("keydown", onKeydown, true);
					close();
					if (state.bar) state.bar.remove();
					removeStrayBars();
					if (state.tip) { state.tip.remove(); state.tip = null; }
					state.bar = null;
					state.input = null;
					state.seg = null;
					state.count = null;
					if (window[NS] === seat) window[NS] = undefined;
				}
			};
			window[NS] = seat;
			// Also handed back to the loader in case it honours a disposer.
			return seat.destroy;
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.findIndices = findIndices;           // for tests
		exports.createHandlers = createHandlers;     // for tests
		exports.detectLanguage = detectLanguage;     // for tests
		exports.probeColumns = probeColumns;         // for tests
		exports.pickScopeRoot = pickScopeRoot;       // for tests
		exports.effectiveScope = effectiveScope;     // for tests
		exports.pickerVisible = pickerVisible;       // for tests
		exports.readScope = readScope;               // for tests
		return module.exports;
	}
});
