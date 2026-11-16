// Isolated smoke test for dsh-find-bar client logic (v0.5).
// Exercises the pure matcher, focus-rule, navigation anchors and the
// keyboard routing with spies; DOM pieces are feature-detected at runtime.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "../lib/client.js"), "utf8");

globalThis.window = { addEventListener() {} };
Object.defineProperty(globalThis, "navigator", { value: { language: "zh-CN" }, configurable: true });
globalThis.__entry = null;
globalThis.window.__ModuleLoader__ = { load(entry) { globalThis.__entry = entry; } };
(0, eval)(src);
const mod = globalThis.__entry.factory();

let failed = 0;
function check(name, ok) { console.log((ok ? "PASS" : "FAIL") + " " + name); if (!ok) failed++; }

// --- findIndices: default behaviour unchanged (0.4 compatibility) ---
check("latin case-insensitive, non-overlapping", JSON.stringify(mod.findIndices("Hello hello HELLO", "hello")) === "[0,6,12]");
check("chinese matches", JSON.stringify(mod.findIndices("字体太大字体太小", "字体")) === "[0,4]");
check("overlapping query is non-overlapping", JSON.stringify(mod.findIndices("aaaa", "aa")) === "[0,2]");
check("empty query → []", mod.findIndices("abc", "").length === 0);
check("no match → []", mod.findIndices("abc", "xyz").length === 0);
check("match at end", JSON.stringify(mod.findIndices("say hi", "hi")) === "[4]");

// --- findIndices: match case ---
check("case-sensitive keeps exact case only", JSON.stringify(mod.findIndices("Hello hello HELLO", "hello", { matchCase: true })) === "[6]");
check("case-sensitive CJK unaffected", JSON.stringify(mod.findIndices("字体Font字体font", "Font", { matchCase: true })) === "[2]");

// --- findIndices: whole word ---
check("word: find skips finding/overflow, Find still counts (case-insensitive)", JSON.stringify(mod.findIndices("find finding overflow Find", "find", { wholeWord: true })) === "[0,22]");
check("word: AI skips detail", JSON.stringify(mod.findIndices("AI detail email", "ai", { wholeWord: true })) === "[0]");
check("word: CJK is a natural boundary", JSON.stringify(mod.findIndices("字体太大", "字体", { wholeWord: true })) === "[0]");
check("word+case combo", JSON.stringify(mod.findIndices("Foo foo fooBar FOO", "foo", { matchCase: true, wholeWord: true })) === "[4]");
check("word: emoji neighbour counts as boundary", JSON.stringify(mod.findIndices("😂find😂", "find", { wholeWord: true })) === "[2]");
check("word: digits/underscore are word chars", mod.findIndices("find_1 find2", "find", { wholeWord: true }).length === 0);

// --- isWordChar ---
check("isWordChar latin/digit/_", mod.isWordChar(97) && mod.isWordChar(48) && mod.isWordChar(95));
check("isWordChar CJK false", mod.isWordChar("汉".codePointAt(0)) === false);
check("isWordChar space false", mod.isWordChar(32) === false);

// --- keyboard routing (now with Alt+C / Alt+W) ---
const calls = { open: 0, close: 0, next: 0, prev: 0, case: 0, word: 0 };
let openState = false;
const prevented = [];
function fakeEvent(p) {
	return Object.assign({ preventDefault() { prevented.push(1); }, stopPropagation() {}, isComposing: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: null }, p);
}
const onKeydown = mod.createHandlers({
	open: () => { calls.open++; openState = true; },
	close: () => { calls.close++; openState = false; },
	goTo: (d) => { d < 0 ? calls.prev++ : calls.next++; },
	isOpen: () => openState,
	toggleCase: () => { calls.case++; },
	toggleWord: () => { calls.word++; },
	isBarInput: (t) => t === "the-input"
});

onKeydown(fakeEvent({ metaKey: true, key: "f" }));
check("Cmd+F opens the bar", calls.open === 1 && prevented.length === 1);
onKeydown(fakeEvent({ ctrlKey: true, key: "f" }));
check("Ctrl+F opens the bar", calls.open === 2);
onKeydown(fakeEvent({ key: "Enter" }));
check("Enter ignored while closed", calls.next === 0 && calls.prev === 0);
openState = true;
onKeydown(fakeEvent({ key: "Enter", target: "the-input" }));
check("Enter → next", calls.next === 1);
onKeydown(fakeEvent({ key: "Enter", shiftKey: true, target: "the-input" }));
check("Shift+Enter → prev", calls.prev === 1);
onKeydown(fakeEvent({ key: "Enter", target: "other" }));
check("Enter outside bar input ignored", calls.next === 1);
onKeydown(fakeEvent({ metaKey: true, key: "g", shiftKey: true }));
check("Cmd+Shift+G → prev", calls.prev === 2);
onKeydown(fakeEvent({ key: "F3" }));
check("F3 → next", calls.next === 2);
onKeydown(fakeEvent({ key: "Enter", isComposing: true, target: "the-input" }));
check("IME composition Enter ignored", calls.next === 2);
onKeydown(fakeEvent({ altKey: true, key: "c" }));
check("Alt+C toggles match case", calls.case === 1);
onKeydown(fakeEvent({ altKey: true, key: "W" }));
check("Alt+W toggles whole word", calls.word === 1);
onKeydown(fakeEvent({ altKey: true, metaKey: true, key: "c" }));
check("Cmd+Alt+C left alone (copy guard)", calls.case === 1 && calls.word === 1);
onKeydown(fakeEvent({ key: "Escape" }));
check("Esc closes", calls.close === 1);

// --- scope resolution (centre/right columns + collapse flags) ---
const centerCol = { name: "center" };
const rightbarCol = { name: "rightbar", previousElementSibling: centerCol };
const frameEl = { hasAttribute: () => false };
rightbarCol.parentElement = frameEl;
const frameDoc = {
	body: { name: "body" },
	querySelector: (sel) => (sel === "[data-rightbar-col]" ? rightbarCol : null)
};
const probe = mod.probeColumns(frameDoc);
check("probe resolves centre column", probe.roots.chat === centerCol);
check("probe resolves right column", probe.roots.right === rightbarCol);
check("chat never collapsed when present", probe.collapsed.chat === false);
check("right open without collapse flag", probe.collapsed.right === false);
check("reading order chat→right", JSON.stringify(probe.order) === '["chat","right"]');

const fsFrame = { hasAttribute: (name) => name === "data-rightbar-collapsed" };
const fsRight = { previousElementSibling: centerCol, parentElement: fsFrame };
const fsDoc = { body: frameDoc.body, querySelector: (sel) => (sel === "[data-rightbar-col]" ? fsRight : null) };
check("plain right collapse detected", mod.probeColumns(fsDoc).collapsed.right === true);
fsFrame.hasAttribute = () => true; // collapsed AND fullscreen flags both set
check("rightbar-fullscreen overrides collapse", mod.probeColumns(fsDoc).collapsed.right === false);
check("fullscreen flips reading order", JSON.stringify(mod.probeColumns(fsDoc).order) === '["right","chat"]');

// --- resolveRegions (multi-scope + collapsed skip) ---
const openProbe = mod.probeColumns(frameDoc);
// Fresh frame carrying ONLY the collapse flag (fsFrame now also reports
// fullscreen, which would cancel the collapse).
const plainFrame = { hasAttribute: (name) => name === "data-rightbar-collapsed" };
const plainRight = { previousElementSibling: centerCol, parentElement: plainFrame };
const collapsedProbe = mod.probeColumns({ body: frameDoc.body, querySelector: (sel) => (sel === "[data-rightbar-col]" ? plainRight : null) });
check("collapsed probe sanity", collapsedProbe.collapsed.right === true);
check("chat scope → [chat]", JSON.stringify(mod.resolveRegions("chat", openProbe)) === '["chat"]');
check("right scope → [right]", JSON.stringify(mod.resolveRegions("right", openProbe)) === '["right"]');
check("all scope → both in reading order", JSON.stringify(mod.resolveRegions("all", openProbe)) === '["chat","right"]');
check("all with right collapsed → chat only, saved untouched", JSON.stringify(mod.resolveRegions("all", collapsedProbe)) === '["chat"]');
check("right scope with right collapsed → falls back to chat", JSON.stringify(mod.resolveRegions("right", collapsedProbe)) === '["chat"]');
check("scopeList all → both", JSON.stringify(mod.scopeList("all")) === '["chat","right"]');

// --- scope persistence (0.5: "all" became valid again) ---
check("no localStorage → chat default", mod.readScope() === "chat");
globalThis.localStorage = { getItem: () => "right" };
check("saved scope restored", mod.readScope() === "right");
globalThis.localStorage = { getItem: () => "all" };
check("saved \"all\" now valid", mod.readScope() === "all");
globalThis.localStorage = { getItem: () => "left" };
check("stale \"left\" rejected → chat", mod.readScope() === "chat");
delete globalThis.localStorage;

// --- match option persistence ---
globalThis.localStorage = {
	store: {},
	getItem(k) { return this.store[k] ?? null; },
	setItem(k, v) { this.store[k] = v; }
};
check("match defaults off", JSON.stringify(mod.readMatchOptions()) === '{"matchCase":false,"wholeWord":false}');
mod.saveMatchOptions({ matchCase: true, wholeWord: false });
check("match round-trip", mod.readMatchOptions().matchCase === true && mod.readMatchOptions().wholeWord === false);
globalThis.localStorage.setItem("dsh-find-bar.match", "{broken");
check("corrupt match json → defaults", mod.readMatchOptions().matchCase === false);
check("flag default when unset", mod.readFlag("whatever", true) === true);
globalThis.localStorage.setItem("whatever", "0");
check("flag restored from storage", mod.readFlag("whatever", true) === false);

// --- focus rule (selection → clicked-only-for-"all" → saved) ---
const col = { chat: false, right: false };
check("no selection: saved wins", mod.initialScope("chat", true, null, "right", col) === "chat");
check("no selection, saved=all, clicked right → degrade to right", mod.initialScope("all", true, null, "right", col) === "right");
check("no selection, saved=all, no click → all", mod.initialScope("all", true, null, null, col) === "all");
check("selection beats click", mod.initialScope("all", true, "chat", "right", col) === "chat");
check("selection beats saved single too (temporary)", mod.initialScope("right", true, "chat", null, col) === "chat");
check("collapsed region ignored", mod.initialScope("all", true, "right", null, { chat: false, right: true }) === "all");
check("follow off → always saved", mod.initialScope("right", false, "chat", "chat", col) === "right");

// --- counter semantics: total until located, n/N after ---
check("empty query → blank", mod.counterText(-1, 0, "", false) === "");
check("no hits → 0", mod.counterText(-1, 0, "x", false) === "0");
check("not located yet → plain total", mod.counterText(-1, 17, "x", false) === "17");
check("located → 3/17", mod.counterText(2, 17, "x", false) === "3/17");
check("capped suffix on both", mod.counterText(-1, 5000, "x", true) === "5000+" && mod.counterText(0, 5000, "x", true) === "1/5000+");

// --- viewport-anchored first locate ---
function fakeRanges(rects) {
	return rects.map(([top, bottom]) => ({ getBoundingClientRect: () => ({ top, bottom }) }));
}
const vh = 600;
check("first visible wins", mod.firstIndexFromViewport(fakeRanges([[-900, -860], [100, 130], [700, 730]]), false, vh) === 1);
check("nothing visible → nearest below", mod.firstIndexFromViewport(fakeRanges([[-900, -860], [700, 730]]), false, vh) === 1);
check("all above → wrap to 0", mod.firstIndexFromViewport(fakeRanges([[-900, -860], [-500, -460]]), false, vh) === 0);
check("backwards: last visible", mod.firstIndexFromViewport(fakeRanges([[100, 130], [200, 230], [700, 730]]), true, vh) === 1);
check("backwards: all below → nearest above = last", mod.firstIndexFromViewport(fakeRanges([[700, 730], [800, 830]]), true, vh) === 1);
check("empty ranges → -1", mod.firstIndexFromViewport([], false, vh) === -1);

// --- rescan keeps the located match by anchor ---
const n1 = { }, n2 = {};
const mk = (node, off) => ({ startContainer: node, startOffset: off });
check("exact anchor kept", mod.relocateIndex({ index: 5, node: n1, offset: 10 }, [mk(n2, 1), mk(n1, 10)]) === 1);
check("same node later offset adopted", mod.relocateIndex({ index: 0, node: n1, offset: 10 }, [mk(n1, 14)]) === 0);
check("anchor gone → clamp", mod.relocateIndex({ index: 3, node: n1, offset: 10 }, [mk(n2, 0), mk(n2, 5)]) === 1);
check("index -1 stays -1", mod.relocateIndex({ index: -1, node: null, offset: 0 }, [mk(n2, 0)]) === -1);

// --- i18n ---
globalThis.document = { documentElement: { lang: "zh-CN" } };
check("html lang zh-CN → zh", mod.detectLanguage() === "zh");
globalThis.document = { documentElement: { lang: "en" } };
check("html lang en → en", mod.detectLanguage() === "en");
globalThis.document = { documentElement: { lang: "" } };
check("html lang empty → browser fallback zh", mod.detectLanguage() === "zh");
delete globalThis.document;
delete globalThis.localStorage;

// --- generational single-seat guard ---
const keydownListeners = [];
globalThis.window = {
	__ModuleLoader__: globalThis.window.__ModuleLoader__,
	addEventListener(type, fn) { if (type === "keydown") keydownListeners.push(fn); },
	removeEventListener(type, fn) {
		const i = keydownListeners.indexOf(fn);
		if (i >= 0) keydownListeners.splice(i, 1);
	}
};
const preventedCount = { n: 0 };
const keyEvent = () => ({ metaKey: true, key: "f", isComposing: false, altKey: false,
	preventDefault() { preventedCount.n++; }, stopPropagation() {} });

mod.apply();
check("first apply: one listener, gen 1", keydownListeners.length === 1 && globalThis.window.__dshFindBarGen === 1);
const staleHandler = keydownListeners[0];
const disposeB = mod.apply();
check("second apply destroys previous seat", keydownListeners.length === 1 && globalThis.window.__dshFindBarGen === 2 && keydownListeners[0] !== staleHandler);
staleHandler(keyEvent());
check("stale listener self-unregisters on keypress", keydownListeners.length === 1 && preventedCount.n === 0);
keydownListeners[0](keyEvent());
check("current listener still opens", preventedCount.n === 1);
disposeB();
check("dispose clears seat and listener", keydownListeners.length === 0 && globalThis.window.__dshFindBar === undefined);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
