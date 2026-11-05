import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKeyCombo } from "./keys.ts";

test("parses combos", () => {
  assert.deepEqual(parseKeyCombo("Enter").spec.key, "Enter");
  const c = parseKeyCombo("Control+Shift+a");
  assert.equal(c.modifiers, 2 | 8);
  assert.equal(c.spec.key, "A");
  assert.equal(c.spec.text, undefined);
  assert.equal(parseKeyCombo("cmd+k").modifiers, 4);
  assert.equal(parseKeyCombo("x").spec.text, "x");
  assert.throws(() => parseKeyCombo("Hyper+x"));
});
