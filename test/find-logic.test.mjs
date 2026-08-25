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

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
