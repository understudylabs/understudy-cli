import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readdir, realpath, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { CliError } from "../errors.js";
import { bundledCliVersion, bundledSkills } from "./bundle.generated.js";

type Skill = (typeof bundledSkills)[number];
type CreatedEntry = { path: string; stat: Stats; hash?: string };

export function listSkills() {
  return {
    cliVersion: bundledCliVersion,
    skills: bundledSkills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      version: skill.version,
      entrypoint: "SKILL.md" as const,
      files: fileMetadata(skill),
    })),
  };
}

export async function installSkills(directory: string) {
  const root = await canonicalSkillRoot(directory);
  await inspectExistingDirectories(root);
  // Refuse unsafe destinations before changing any skill in a batch.
  for (const skill of bundledSkills) {
    try {
      validateBundle(skill);
      const destination = path.join(root, skill.name);
      if (await inspect(destination)) await matchesInstalled(destination, skill);
    } catch (error) {
      throw new CliError(`Cannot install ${skill.name}: ${errorMessage(error)} No bundled skills were installed.`);
    }
  }
  const skills: Awaited<ReturnType<typeof installSkill>>[] = [];
  for (const skill of bundledSkills) {
    try {
      skills.push(await installBundledSkill(skill, root));
    } catch (error) {
      const installed = skills.filter((entry) => entry.status === "installed").map((entry) => entry.name);
      const progress = installed.length
        ? ` Already installed: ${installed.join(", ")}. These complete installations were kept; retry after resolving the problem.`
        : " No bundled skills were installed.";
      throw new CliError(`Could not install ${skill.name}: ${errorMessage(error)}${progress}`);
    }
  }
  return { cliVersion: bundledCliVersion, directory: root, skills };
}

export async function installSkill(name: string, directory: string) {
  const skill = bundledSkills.find((candidate) => candidate.name === name);
  if (!skill) throw new CliError(`Unknown bundled skill: ${name}. Use skills list to see available skills.`);
  validateBundle(skill);
  const root = await canonicalSkillRoot(directory);
  return installBundledSkill(skill, root);
}

async function installBundledSkill(skill: Skill, root: string) {
  const name = skill.name;
  const destination = path.join(root, name);
  const result = (status: "installed" | "unchanged") => ({
    cliVersion: bundledCliVersion,
    name,
    version: skill.version,
    status,
    directory: destination,
    entrypoint: path.join(destination, "SKILL.md"),
    files: fileMetadata(skill),
  });

  await ensureDirectory(root);
  const lockPath = path.join(root, `.understudy-install-${name}.lock`);
  const lock = await acquireLock(lockPath);
  const stagingRoot = path.join(lockPath, "bundle");
  const staged: CreatedEntry[] = [];
  const installed: CreatedEntry[] = [];
  try {
    await inspectDirectory(root);
    if (await inspect(destination) && await matchesInstalled(destination, skill)) {
      return result("unchanged");
    }

    // Stage every byte before refreshing the selected skill. Publication uses
    // exclusive links or copies: rename could silently replace a concurrently
    // created empty directory. The lock serializes CLI installers for this root.
    // Publish the entrypoint last so hosts cannot discover the skill before its
    // reference files have been installed.
    const publicationOrder = [...skill.files].sort((left, right) =>
      Number(left.path === "SKILL.md") - Number(right.path === "SKILL.md"),
    );
    await mkdir(stagingRoot);
    staged.push({ path: stagingRoot, stat: await lstat(stagingRoot) });
    for (const file of publicationOrder) {
      await createDirectories(path.dirname(path.join(stagingRoot, file.path)), stagingRoot, staged);
      const filePath = path.join(stagingRoot, file.path);
      const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
      try {
        staged.push({ path: filePath, stat: await handle.stat() });
        await handle.writeFile(file.content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }

    await inspectDirectory(root);
    if (await inspect(destination)) {
      // Bundled skill directories are managed output. Remove stale resources and
      // local edits only after staging succeeds and checking the tree for links.
      await matchesInstalled(destination, skill);
      await rm(destination, { recursive: true });
    }
    await mkdir(destination);
    installed.push({ path: destination, stat: await lstat(destination) });
    for (const file of publicationOrder) {
      const filePath = path.join(destination, file.path);
      await createDirectories(path.dirname(filePath), destination, installed);
      await inspectDirectory(path.dirname(filePath));
      await publishFile(path.join(stagingRoot, file.path), filePath);
      installed.push({ path: filePath, stat: await lstat(filePath), hash: file.sha256 });
    }
    if (!(await matchesInstalled(destination, skill))) throw new CliError("Installed skill changed during publication. Run skills install again.");
    return result("installed");
  } catch (error) {
    await cleanCreated(installed);
    if (error instanceof CliError) throw error;
    throw new CliError("Could not finish installing the bundled skill. Check the destination and run skills install again.");
  } finally {
    await cleanCreated(staged);
    const current = await inspect(lockPath);
    if (current && sameEntry(current, lock)) await rmdir(lockPath).catch(() => undefined);
  }
}

async function canonicalSkillRoot(directory: string) {
  if (typeof directory !== "string" || !directory.trim() || directory.includes("\0")) {
    throw new CliError("Provide a non-empty skill root directory.");
  }
  let ancestor = path.resolve(directory);
  const missing: string[] = [];
  try {
    while (!(await inspect(ancestor))) {
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new CliError("The skill root has no readable parent directory.");
      ancestor = parent;
    }
    // The chosen root may intentionally share another agent's skill directory.
    // Resolve only that root; named skills and their contents still reject links.
    const canonicalAncestor = await realpath(ancestor);
    await inspectDirectory(canonicalAncestor);
    return path.join(canonicalAncestor, ...missing);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("The selected skill root or its parent is unreadable or contains a dangling symbolic link.");
  }
}

async function inspectExistingDirectories(directory: string): Promise<void> {
  const parent = path.dirname(directory);
  if (parent !== directory) await inspectExistingDirectories(parent);
  const entry = await inspect(directory);
  if (entry) assertDirectory(entry);
}

function errorMessage(error: unknown) {
  return error instanceof CliError ? error.message : "The destination could not be checked or written safely.";
}

async function publishFile(source: string, destination: string) {
  try {
    await link(source, destination);
  } catch (error) {
    // Some writable filesystems do not support hard links. Copying must retain
    // the same no-overwrite guarantee, including a destination created meanwhile.
    if (!["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS", "EXDEV"].some((code) => hasCode(error, code))) throw error;
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  }
}

function fileMetadata(skill: Skill) {
  return skill.files.map(({ path: filePath, sha256 }) => ({ path: filePath, sha256 }));
}

function validateBundle(skill: Skill) {
  const seen = new Set<string>();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) throw new CliError("Bundled skill has an unsafe name.");
  for (const file of skill.files) {
    if (!file.path || file.path.includes("\\") || file.path.includes("\0") || file.path.includes(":")) {
      throw new CliError("Bundled skill has an unsafe file path.");
    }
    const segments = file.path.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..") || seen.has(file.path)) {
      throw new CliError("Bundled skill has an unsafe or duplicate file path.");
    }
    seen.add(file.path);
    if (hash(Buffer.from(file.content)) !== file.sha256) throw new CliError("Bundled skill content failed its integrity check.");
  }
  if (!seen.has("SKILL.md")) throw new CliError("Bundled skill is missing SKILL.md.");
}

async function acquireLock(lockPath: string): Promise<Stats> {
  for (let attempt = 0; attempt < 40; attempt++) {
    await inspectDirectory(path.dirname(lockPath));
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return await lstat(lockPath);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw new CliError("Could not create the skill installation lock.");
      const current = await inspect(lockPath);
      if (current && (!current.isDirectory() || current.isSymbolicLink())) {
        throw new CliError("Skill installation lock is not a regular directory.");
      }
      await setTimeout(50);
    }
  }
  throw new CliError("Another skill installation holds the destination lock. If it was interrupted, remove the stale installation lock after confirming no installer is running.");
}

async function ensureDirectory(directory: string) {
  const parent = path.dirname(directory);
  if (parent !== directory) await ensureDirectory(parent);
  let entry = await inspect(directory);
  if (!entry) {
    try { await mkdir(directory); } catch (error) { if (!hasCode(error, "EEXIST")) throw new CliError("Could not create the skill root directory."); }
    entry = await lstat(directory);
  }
  assertDirectory(entry);
}

async function inspectDirectory(directory: string) {
  const parent = path.dirname(directory);
  if (parent !== directory) await inspectDirectory(parent);
  const entry = await inspect(directory);
  if (!entry) throw new CliError("A skill destination directory disappeared during installation.");
  assertDirectory(entry);
}

function assertDirectory(entry: Stats) {
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new CliError("Skill destination paths must be directories without symbolic links.");
}

async function createDirectories(directory: string, root: string, created: CreatedEntry[]) {
  if (directory === root) return;
  await createDirectories(path.dirname(directory), root, created);
  const existing = await inspect(directory);
  if (existing) { assertDirectory(existing); return; }
  await inspectDirectory(path.dirname(directory));
  await mkdir(directory);
  created.push({ path: directory, stat: await lstat(directory) });
}

async function matchesInstalled(destination: string, skill: Skill) {
  await inspectDirectory(destination);
  const expected = new Map(skill.files.map((file) => [file.path, file]));
  const directories = new Set<string>();
  for (const file of skill.files) {
    let directory = path.posix.dirname(file.path);
    while (directory !== ".") { directories.add(directory); directory = path.posix.dirname(directory); }
  }
  const found = new Set<string>();
  let matches = true;
  const visit = async (directory: string, relative: string) => {
    await inspectDirectory(directory);
    for (const name of await readdir(directory)) {
      const relativePath = relative ? `${relative}/${name}` : name;
      const filePath = path.join(directory, name);
      const entry = await lstat(filePath);
      if (entry.isSymbolicLink()) throw new CliError("Existing skill contains a symbolic link; no files were replaced.");
      if (entry.isDirectory()) {
        if (!directories.has(relativePath)) matches = false;
        await visit(filePath, relativePath);
      } else {
        if (!entry.isFile()) throw new CliError("Existing skill contains a special file; no files were replaced.");
        const expectedFile = expected.get(relativePath);
        if (!expectedFile || entry.size !== Buffer.byteLength(expectedFile.content)) matches = false;
        else if (!(await readRegular(filePath)).equals(Buffer.from(expectedFile.content))) matches = false;
        found.add(relativePath);
      }
    }
  };
  await visit(destination, "");
  return matches && found.size === skill.files.length;
}

async function readRegular(filePath: string) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new CliError("Skill contents must be regular files.");
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function cleanCreated(entries: CreatedEntry[]) {
  for (const entry of [...entries].reverse()) {
    try {
      const current = await inspect(entry.path);
      if (!current || !sameEntry(current, entry.stat) || current.isSymbolicLink()) continue;
      if (current.isDirectory()) await rmdir(entry.path);
      else if (!entry.hash || hash(await readRegular(entry.path)) === entry.hash) await unlink(entry.path);
    } catch { /* Preserve paths modified by another writer and incomplete directories. */ }
  }
}

function sameEntry(left: Stats, right: Stats) { return left.dev === right.dev && left.ino === right.ino; }
function hash(content: Buffer) { return createHash("sha256").update(content).digest("hex"); }
function hasCode(error: unknown, code: string) { return error instanceof Error && "code" in error && error.code === code; }
async function inspect(filePath: string) {
  try { return await lstat(filePath); } catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
}
