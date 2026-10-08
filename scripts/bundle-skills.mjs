import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

// Explicit delivery scope. Adding skill instructions or executable resources requires source review.
const skillSources = [{
  name: "setup-understudy",
  files: [
    "SKILL.md",
    "references/anthropic-messages.md",
    "references/mastra.md",
    "references/openai-compatible.md",
    "references/request-correlation.md",
    "references/vercel-ai-sdk.md",
  ],
}, {
  name: "try-models",
  files: [
    "SKILL.md",
    "references/spot-check-view.md",
    "references/upgrade.md",
  ],
}, {
  name: "recommend-models",
  files: ["SKILL.md", "references/model-facts.md", "references/task-cost.md"],
}, {
  name: "rollout-workload",
  files: ["SKILL.md"],
}, {
  name: "check-workload",
  files: ["SKILL.md"],
}, {
  name: "build-evals",
  files: [
    "SKILL.md",
    "references/captures.md",
    "references/case-review.md",
    "references/check-eval.md",
    "references/formats.md",
    "references/measurements.md",
    "references/medium.md",
    "references/worked-example.md",
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
}, {
  name: "compare-models",
  files: [
    "SKILL.md",
    "references/bundled-comparison.md",
    "references/comparison-view.md",
    "references/demo.md",
    "scripts/compare.mjs",
    "scripts/present.mjs",
    "templates/demo-adapter.mjs",
  ],
}, {
  name: "adapt-model-api",
  files: ["SKILL.md"],
}];

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function readSource(root, relativePath) {
  let current = root;
  const parts = relativePath.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || (index < parts.length - 1 ? !entry.isDirectory() : !entry.isFile())) {
      throw new Error(`Skill source must be a regular file with no symlink components: ${relativePath}`);
    }
  }
  const bytes = await readFile(current);
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (content.includes("\0")) throw new Error(`Skill source contains a null byte: ${relativePath}`);
  return content;
}

function assertBundledLinks(files) {
  const names = new Set(files.map(file => file.path));
  for (const file of files) {
    if (!file.path.endsWith(".md")) continue;
    for (const match of file.content.matchAll(/\]\(([^\s)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), target));
      if (!names.has(resolved)) {
        throw new Error(`Skill reference is not bundled: ${file.path} -> ${target}`);
      }
    }
  }
}

export async function createSkillBundle(root = repositoryRoot) {
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Skill bundle requires a semantic CLI version.");
  }
  const skills = [];
  for (const source of skillSources) {
    const files = [];
    for (const relativePath of source.files) {
      const content = await readSource(root, `skills/${source.name}/${relativePath}`);
      files.push({ path: relativePath, content, sha256: digest(content) });
    }
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(files[0].content)?.[1];
    const name = /^name: ([a-z0-9-]+)\r?$/m.exec(frontmatter ?? "")?.[1];
    const description = /^description: (.+)\r?$/m.exec(frontmatter ?? "")?.[1]?.trim();
    if (name !== source.name || !description) throw new Error(`Invalid skill metadata: ${source.name}`);
    assertBundledLinks(files);
    skills.push({
      name,
      description,
      version: digest(JSON.stringify(files.map(({ path: filePath, sha256 }) => [filePath, sha256]))),
      files,
    });
  }
  return { cliVersion: version, skills };
}

export async function writeSkillBundle(root = repositoryRoot) {
  const bundle = await createSkillBundle(root);
  // Command reference belongs to replay help, never to an automatically loaded skill.
  const replayGuides = await Promise.all([
    readSource(root, "docs/replay-harness.md"),
    readSource(root, "docs/replay-tool-environment.md"),
  ]);
  const replayHelp = replayGuides.join("\n").replace(/\[([^\]]+)\]\((?![a-z][a-z0-9+.-]*:)[^)]+\)/gi, "$1");
  const destination = path.join(root, "src", "skills", "bundle.generated.ts");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, [
    "// Generated by scripts/bundle-skills.mjs from reviewed skill resources; do not edit.",
    `export const bundledCliVersion = ${JSON.stringify(bundle.cliVersion)};`,
    `export const bundledSkills = ${JSON.stringify(bundle.skills, null, 2)};`,
    `export const bundledReplayHelp = ${JSON.stringify(replayHelp)};`,
    "",
  ].join("\n"), "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeSkillBundle();
}
