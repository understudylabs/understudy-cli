import assert from "node:assert/strict";
import test from "node:test";

import { formatOutput, sanitizeTerminalText } from "../dist/output.js";

function command(json = false) {
  return { optsWithGlobals: () => ({ json }) };
}

test("human output replaces terminal control characters", () => {
  const unsafeName = "Project\n\u001b[31mred\u009b\u202espoof\u2066";
  const output = formatOutput(
    command(),
    { name: unsafeName },
    ["NAME", unsafeName],
  );

  assert.equal(output, "NAME\nProject??[31mred??spoof?");
  assert.doesNotMatch(
    output,
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/,
  );
});

test("JSON output preserves source values", () => {
  const data = { name: "Project\n\u001b[31mred\u009b\u202espoof\u2066" };
  const output = formatOutput(command(true), data, "ignored");

  assert.deepEqual(JSON.parse(output), data);
  assert.doesNotMatch(output, /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/);
  assert.match(output, /\\u009b/);
  assert.match(output, /\\u202e/);
});

test("terminal text sanitizer replaces every control character", () => {
  assert.equal(
    sanitizeTerminalText("Bad\nrequest\u001b[31m\u009b"),
    "Bad?request?[31m?",
  );
});

test("terminal text sanitizer replaces every bidirectional control", () => {
  assert.equal(
    sanitizeTerminalText(
      "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069",
    ),
    "????????????",
  );
});
