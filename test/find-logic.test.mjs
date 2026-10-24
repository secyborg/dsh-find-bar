// Isolated smoke test for dsh-find-bar client logic.
// Exercises the pure matcher and the keyboard routing with spies; the DOM
// pieces are feature-detected at runtime and validated by syntax + install.
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

// --- findIndices ---
check("latin case-insensitive, non-overlapping", JSON.stringify(mod.findIndices("Hello hello HELLO", "hello")) === "[0,6,12]");
check("chinese matches", JSON.stringify(mod.findIndices("字体太大字体太小", "字体")) === "[0,4]");
check("overlapping query is non-overlapping", JSON.stringify(mod.findIndices("aaaa", "aa")) === "[0,2]");
check("empty query → []", mod.findIndices("abc", "").length === 0);
check("no match → []", mod.findIndices("abc", "xyz").length === 0);
check("match at end", JSON.stringify(mod.findIndices("say hi", "hi")) === "[4]");

// --- keyboard routing ---
const calls = { open: 0, close: 0, next: 0, prev: 0 };
let openState = false;
const prevented = [];
function fakeEvent(p) {
	return Object.assign({ preventDefault() { prevented.push(1); }, stopPropagation() {}, isComposing: false, metaKey: false, ctrlKey: false, shiftKey: false, target: null }, p);
}
const onKeydown = mod.createHandlers({
	open: () => { calls.open++; openState = true; },
	close: () => { calls.close++; openState = false; },
	goTo: (d) => { d < 0 ? calls.prev++ : calls.next++; },
	isOpen: () => openState,
	isBarInput: (t) => t === "the-input"
});

// Cmd+F opens
onKeydown(fakeEvent({ metaKey: true, key: "f" }));
check("Cmd+F opens the bar", calls.open === 1 && prevented.length === 1);
// Ctrl+F (windows/linux) also opens
onKeydown(fakeEvent({ ctrlKey: true, key: "f" }));
check("Ctrl+F opens the bar", calls.open === 2);
// keys ignored while closed
onKeydown(fakeEvent({ key: "Enter" }));
check("Enter ignored while closed", calls.next === 0 && calls.prev === 0);
// open, then navigation
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
onKeydown(fakeEvent({ key: "Escape" }));
check("Esc closes", calls.close === 1);

// --- scope resolution (left/centre/right columns + collapse flags) ---
const sidebarCol = { name: "sidebar" };
const centerCol = { name: "center", previousElementSibling: sidebarCol };
const rightbarCol = { name: "rightbar", previousElementSibling: centerCol };
const frameEl = {
	hasAttribute: (name) => name === "data-sidebar-collapsed" // left collapsed
};
rightbarCol.parentElement = frameEl;
const frameDoc = {
	body: { name: "body" },
	querySelector: (sel) => (sel === "[data-rightbar-col]" ? rightbarCol : null)
};
const probe = mod.probeColumns(frameDoc);
check("probe resolves sidebar column", probe.roots.left === sidebarCol);
check("probe resolves centre column", probe.roots.chat === centerCol);
check("probe resolves right column", probe.roots.right === rightbarCol);
check("left marked collapsed via frame flag", probe.collapsed.left === true);
check("chat never collapsed when present", probe.collapsed.chat === false);
check("right open without collapse flag", probe.collapsed.right === false);

const fsFrame = { hasAttribute: (name) => name === "data-rightbar-collapsed" };
const fsRight = { previousElementSibling: centerCol, parentElement: fsFrame };
const fsDoc = { body: frameDoc.body, querySelector: (sel) => (sel === "[data-rightbar-col]" ? fsRight : null) };
check("plain right collapse detected", mod.probeColumns(fsDoc).collapsed.right === true);
check("pickScopeRoot right → collapsed → null", mod.pickScopeRoot("right", fsDoc) === null);
fsFrame.hasAttribute = () => true; // collapsed AND fullscreen flags both set
check("rightbar-fullscreen overrides collapse", mod.probeColumns(fsDoc).collapsed.right === false);

check("pickScopeRoot chat → centre column", mod.pickScopeRoot("chat", frameDoc) === centerCol);
check("pickScopeRoot left → collapsed → null", mod.pickScopeRoot("left", frameDoc) === null);
const openDoc = { body: frameDoc.body, querySelector: (sel) => (sel === "[data-rightbar-col]" ? rightbarCol : null) };
frameEl.hasAttribute = () => false;
check("pickScopeRoot left when open → sidebar column", mod.pickScopeRoot("left", openDoc) === sidebarCol);
check("pickScopeRoot right when open → right column", mod.pickScopeRoot("right", openDoc) === rightbarCol);
check("missing layout → null root", mod.pickScopeRoot("chat", { body: frameDoc.body, querySelector: () => null }) === null);

// --- collapsed-scope fallback ---
check("collapsed scope falls back to chat", mod.effectiveScope("right", { left: true, chat: false, right: true }) === "chat");
check("open scope stays", mod.effectiveScope("right", { left: false, chat: false, right: false }) === "right");
check("chat scope immune to fallback", mod.effectiveScope("chat", { left: true, chat: false, right: true }) === "chat");

// --- scope persistence ---
check("no localStorage → chat default", mod.readScope() === "chat");
globalThis.localStorage = { getItem: () => "right" };
check("saved scope restored", mod.readScope() === "right");
globalThis.localStorage = { getItem: () => "all" };
check("pre-0.3 saved \"all\" rejected → chat", mod.readScope() === "chat");
delete globalThis.localStorage;

// --- generational single-seat guard (duplicate-instance healing) ---
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
const keyEvent = () => ({ metaKey: true, key: "f", isComposing: false,
	preventDefault() { preventedCount.n++; }, stopPropagation() {} });

mod.apply();
check("first apply: one listener, gen 1", keydownListeners.length === 1 && globalThis.window.__dshFindBarGen === 1);
const staleHandler = keydownListeners[0];
const disposeB = mod.apply();
check("second apply destroys previous seat", keydownListeners.length === 1 && globalThis.window.__dshFindBarGen === 2 && keydownListeners[0] !== staleHandler);
staleHandler(keyEvent()); // stale listener must self-unregister, not open
check("stale listener self-unregisters on keypress", keydownListeners.length === 1 && preventedCount.n === 0);
keydownListeners[0](keyEvent());
check("current listener still opens", preventedCount.n === 1);
disposeB();
check("dispose clears seat and listener", keydownListeners.length === 0 && globalThis.window.__dshFindBar === undefined);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
