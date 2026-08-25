// dsh-find-bar — client half (v0.1).
//
// The desktop app is an Electron shell, and Electron has no built-in
// find-in-page bar (the browser's Cmd+F does not exist there). This plugin
// restores it: a small find bar with highlight-all, a match counter, and
// Enter / Shift+Enter navigation — covering everything rendered on the page,
// conversation content and sidebar alike.
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
		var HL_ALL = "dsh-find-bar-all";
		var HL_CUR = "dsh-find-bar-cur";
		var MAX_MATCHES = 5000;
		var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1 };

		var ZH = typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "");
		var L = ZH ? {
			placeholder: "查找…",
			prev: "上一个匹配",
			next: "下一个匹配",
			close: "关闭查找",
			cap: "已达匹配上限，仅显示前 {n} 条"
		} : {
			placeholder: "Find…",
			prev: "Previous match",
			next: "Next match",
			close: "Close find",
			cap: "Match limit reached, showing first {n}"
		};

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
				"#" + BAR_ID + " input{width:210px;height:28px;color:var(--dsw-alias-label-primary);font:13px/1 var(--dsw-font-family);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;outline:none;padding:0 8px}" +
				"#" + BAR_ID + " input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}" +
				"#" + BAR_ID + " span{min-width:52px;color:var(--dsw-alias-label-tertiary);font:12px/1 var(--dsw-font-family);font-variant-numeric:tabular-nums;text-align:center}" +
				"#" + BAR_ID + " button{width:26px;height:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;align-items:center;justify-content:center;display:inline-flex}" +
				"#" + BAR_ID + " button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
				"#" + BAR_ID + " svg{pointer-events:none}" +
				"::highlight(" + HL_ALL + "){background-color:rgba(245,197,24,.42)}" +
				"::highlight(" + HL_CUR + "){background-color:#f5a623;color:#141414}";
		}

		function injectCss() {
			if (typeof document === "undefined") return;
			var tagId = "dsh-find-bar/bar.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				var tag = document.createElement("style");
				tag.setAttribute("data-plugin-css", tagId);
				tag.textContent = cssText();
				document.head.appendChild(tag);
			}
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

		function collectRanges(query) {
			var ranges = [];
			if (!query || typeof document === "undefined" || document.body === null) return ranges;
			var nodes = collectTextNodes(document.body, []);
			for (var i = 0; i < nodes.length && ranges.length < MAX_MATCHES; i++) {
				var node = nodes[i];
				var indices = findIndices(node.data, query);
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

		var state = { bar: null, input: null, count: null, query: "", ranges: [], index: -1, capped: false, observer: null, debounce: 0 };

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
			state.ranges = collectRanges(state.query);
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
			state.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
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

			bar.appendChild(input);
			bar.appendChild(count);
			bar.appendChild(button(L.prev, "m18 15-6-6-6 6", function () { goTo(-1); }));
			bar.appendChild(button(L.next, "m6 9 6 6 6-6", function () { goTo(1); }));
			bar.appendChild(button(L.close, "M18 6 6 18M6 6l12 12", close));

			state.bar = bar;
			state.input = input;
			state.count = count;
			document.body.appendChild(bar);
		}

		function open() {
			if (typeof document === "undefined" || document.body === null) return;
			if (!state.bar) buildBar();
			state.bar.style.display = "flex";
			var selection = "";
			try { selection = String(window.getSelection()).trim(); } catch (error) {}
			if (selection && selection.length <= 200 && selection !== state.query) {
				state.input.value = selection;
				state.query = selection;
			}
			state.input.focus();
			state.input.select();
			runSearch(false);
			startObserver();
		}

		function close() {
			if (state.bar) state.bar.style.display = "none";
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
			var ops = {
				open: open,
				close: close,
				goTo: goTo,
				isOpen: isOpen,
				isBarInput: function (target) { return target === state.input; }
			};
			window.addEventListener("keydown", createHandlers(ops), true);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.findIndices = findIndices;         // for tests
		exports.createHandlers = createHandlers;   // for tests
		return module.exports;
	}
});
