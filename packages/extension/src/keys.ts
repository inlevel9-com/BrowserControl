// Key combo → CDP Input.dispatchKeyEvent parameters.
export interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED: Record<string, KeySpec> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  capslock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const MODS: Record<string, number> = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, shift: 8 };

export interface ParsedCombo {
  modifiers: number;
  spec: KeySpec;
}

/** Parse `Control+Shift+a`, `Enter`, `cmd+k`, `a`. */
export function parseKeyCombo(combo: string): ParsedCombo {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("empty key combo");
  let modifiers = 0;
  let last = parts[parts.length - 1]!;
  for (const p of parts.slice(0, -1)) {
    const m = MODS[p.toLowerCase()];
    if (m === undefined) throw new Error(`unknown modifier "${p}"`);
    modifiers |= m;
  }
  if (combo.endsWith("++")) last = "+";
  const named = NAMED[last.toLowerCase()];
  if (named) return { modifiers, spec: named };
  if (last.length === 1) {
    const ch = last;
    const upper = ch.toUpperCase();
    const isLetter = /[a-z]/i.test(ch);
    const isDigit = /[0-9]/.test(ch);
    const code = isLetter ? `Key${upper}` : isDigit ? `Digit${ch}` : "";
    const keyCode = isLetter || isDigit ? upper.charCodeAt(0) : ch.charCodeAt(0);
    const text = modifiers & (2 | 4) ? undefined : ch; // ctrl/meta combos produce no text
    return { modifiers, spec: { key: modifiers & 8 && isLetter ? upper : ch, code, keyCode, text } };
  }
  throw new Error(`unknown key "${last}"`);
}
