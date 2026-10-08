import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createSkillBundle, writeSkillBundle } from "../scripts/bundle-skills.mjs";

const references = {
  "setup-understudy": ["anthropic-messages", "mastra", "openai-compatible", "request-correlation", "vercel-ai-sdk"],
  "try-models": ["spot-check-view", "upgrade"],
  "recommend-models": ["model-facts", "task-cost"],
  "rollout-workload": [],
  "check-workload": [],
  "build-evals": ["captures", "case-review", "check-eval", "formats", "measurements", "medium", "worked-example"],
  "compare-models": ["bundled-comparison", "comparison-view", "demo"],
  "adapt-model-api": [],
};

const extraResources = {
  "compare-models": ["scripts/compare.mjs", "scripts/present.mjs", "templates/demo-adapter.mjs"],
  "build-evals": [
    "scripts/eval.mjs",
    "scripts/lib.mjs",
    "scripts/measure.mjs",
    "scripts/report.mjs",
    "scripts/worker.mjs",
    "templates/adapter.mjs",
    "templates/cases.jsonl",
    "templates/controls.jsonl",
    "templates/demo-adapter.mjs",
    "templates/demo-cases.jsonl",
    "templates/demo-controls.jsonl",
    "templates/demo-eval.json",
    "templates/demo-eval.md",
    "templates/demo-grader.mjs",
    "templates/eval.json",
    "templates/eval.md",
    "templates/grader.mjs",
  ],
};

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "synthetic-skill-bundle-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs/replay-harness.md"), "# Synthetic harness reference\n");
  await writeFile(path.join(root, "docs/replay-tool-environment.md"), "# Synthetic tool-environment reference\n");
  for (const [name, referenceNames] of Object.entries(references)) {
    const skillRoot = path.join(root, "skills", name);
    await mkdir(path.join(skillRoot, "references"), { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), [
      "---", `name: ${name}`, "description: Wholly synthetic skill fixture.", "---", "",
      ...referenceNames.map(reference => `[Example](references/${reference}.md)`), "",
    ].join("\n"));
    for (const resource of extraResources[name] ?? []) {
      await mkdir(path.dirname(path.join(skillRoot, resource)), { recursive: true });
      await writeFile(path.join(skillRoot, resource), "// Wholly synthetic bundle fixture.\n");
    }
    for (const reference of referenceNames) {
      await writeFile(path.join(skillRoot, "references", `${reference}.md`), "# Synthetic reference\n\n[Entrypoint](../SKILL.md#example)\n");
    }
  }
  const skillRoot = path.join(root, "skills", "setup-understudy");
  return { root, skillRoot };
}

test("bundle preserves exact source bytes and deterministic versions; only reviewed files enter", async t => {
  const { root, skillRoot } = await fixture(t);
  for (const name of Object.keys(references)) await writeFile(path.join(root, "skills", name, "unreviewed.md"), "Not part of the delivery scope.");
  const first = await createSkillBundle(root);
  assert.deepEqual(await createSkillBundle(root), first);
  assert.deepEqual(first.skills.map(skill => skill.name), Object.keys(references));
  for (const skill of first.skills) {
    assert.deepEqual(skill.files.map(file => file.path), ["SKILL.md", ...references[skill.name].map(name => `references/${name}.md`), ...(extraResources[skill.name] ?? [])]);
    for (const file of skill.files) {
      const bytes = await readFile(path.join(root, "skills", skill.name, file.path));
      assert.deepEqual(Buffer.from(file.content), bytes);
      assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
    }
  }
  await writeFile(path.join(skillRoot, "references", "mastra.md"), "# Changed synthetic reference\r\n");
  const next = await createSkillBundle(root);
  assert.notEqual(next.skills[0].version, first.skills[0].version);
  assert.deepEqual(next.skills.slice(1), first.skills.slice(1), "editing setup does not change other skill bundles");
  await writeSkillBundle(root);
  const generated = await readFile(path.join(root, "src", "skills", "bundle.generated.ts"), "utf8");
  for (const skill of next.skills) assert.ok(generated.includes(skill.version));
  assert.equal(generated.includes(root), false);
});

test("build fails for a local reference omitted from the bundle", async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "skills", "try-models", "references", "spot-check-view.md"), "[Missing](missing.md)\n");
  await assert.rejects(createSkillBundle(root), /Skill reference is not bundled/);
});

test("build refuses symlinked source files", async t => {
  const { root, skillRoot } = await fixture(t);
  const reference = path.join(skillRoot, "references", "mastra.md");
  await rm(reference);
  await symlink(path.join(skillRoot, "SKILL.md"), reference);
  await assert.rejects(createSkillBundle(root), /no symlink components/);
});

test("build refuses metadata drift and non-text source", async t => {
  const { root, skillRoot } = await fixture(t);
  await writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: unexpected\ndescription: Synthetic\n---\n");
  await assert.rejects(createSkillBundle(root), /Invalid skill metadata/);
  await writeFile(path.join(skillRoot, "SKILL.md"), Buffer.from([0xff, 0xfe]));
  await assert.rejects(createSkillBundle(root), /encoded data/);
});
