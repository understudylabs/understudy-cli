import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const inputModule = new URL("../dist/auth/input.js", import.meta.url).href;
const emailModule = new URL("../dist/auth/email.js", import.meta.url).href;
// Wholly synthetic input; this child cannot read credentials or make a request.
const readAndComplete = `
  import { readSignInCode } from ${JSON.stringify(inputModule)};
  import { completeEmailLogin } from ${JSON.stringify(emailModule)};
  let pendingReads = 0;
  try {
    const code = await readSignInCode();
    await completeEmailLogin({
      pendingStore: { read: async () => { pendingReads++; return null; } },
      fetchImplementation: async () => { throw new Error("Unexpected network call"); },
    }, code);
    throw new Error("Unexpected sign-in completion");
  } catch (error) {
    process.stdout.write(JSON.stringify({ message: error.message, pendingReads }));
  }
`;

function run(input) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", readAndComplete], {
    input, encoding: "utf8", timeout: 5000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const input of ["", " \n\t "]) {
  test("empty non-interactive input explains how to enter the code without submitting a claim", () => {
    const result = run(input);
    assert.match(result.message, /No sign-in code.*stdin/);
    assert.match(result.message, /interactive terminal/);
    assert.match(result.message, /understudy login --code <code>/);
    assert.match(result.message, /browser sign-in/);
    assert.equal(result.pendingReads, 0);
  });
}

test("a code supplied through stdin still reaches pending-claim resolution", () => {
  const result = run(" 101010\n");
  assert.equal(result.pendingReads, 1);
  assert.match(result.message, /No email sign-in is pending/);
  assert.doesNotMatch(result.message, /101010/);
});

test("malformed supplied input remains distinct from missing stdin", () => {
  const result = run("synthetic-invalid-code\n");
  assert.equal(result.pendingReads, 0);
  assert.match(result.message, /six digits/);
  assert.doesNotMatch(result.message, /synthetic-invalid-code/);
});

test("oversized stdin stays bounded before pending state is read", () => {
  const result = run("x".repeat(129));
  assert.equal(result.pendingReads, 0);
  assert.match(result.message, /input is too long/);
});
