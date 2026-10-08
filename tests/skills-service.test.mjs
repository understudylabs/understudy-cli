import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fileSystem from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CliError } from "../dist/errors.js";
import { bundledSkills } from "../dist/skills/bundle.generated.js";
import { installSkill, installSkills, listSkills } from "../dist/skills/service.js";

const setupSkill = bundledSkills.find(({ name }) => name === "setup-understudy");

async function fixture(t) {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "synthetic-skill-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("bundled skill inventory exposes hashes without embedding skill contents", () => {
  const result = listSkills();
  assert.equal(typeof result.cliVersion, "string");
  assert.deepEqual(result.skills.map(({ name }) => name).sort(), ["adapt-model-api", "build-evals", "check-workload", "compare-models", "recommend-models", "rollout-workload", "setup-understudy", "try-models"]);
  for (const skill of result.skills) {
    assert.equal(skill.entrypoint, "SKILL.md");
    assert.match(skill.version, /^[a-f0-9]{64}$/);
    for (const file of skill.files) {
      assert.deepEqual(Object.keys(file).sort(), ["path", "sha256"]);
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
    }
  }
});

test("installation creates a complete matching bundle and repeated installation is unchanged", async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, "nested", "agent-skills");
  const installed = await installSkill("setup-understudy", root);
  assert.equal(installed.status, "installed");
  assert.equal(installed.directory, path.join(root, "setup-understudy"));
  assert.equal(installed.entrypoint, path.join(installed.directory, "SKILL.md"));
  assert.equal(installed.cliVersion, listSkills().cliVersion);
  assert.equal(installed.version, setupSkill.version);
  for (const file of setupSkill.files) {
    const bytes = await readFile(path.join(installed.directory, file.path));
    assert.equal(bytes.toString("utf8"), file.content);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  const repeated = await installSkill("setup-understudy", root);
  assert.deepEqual(repeated, { ...installed, status: "unchanged" });
  assert.deepEqual(await readdir(root), ["setup-understudy"]);
});

test("installing the renamed comparison skill preserves an old customized installation", async (t) => {
  const root = await fixture(t);
  const oldDirectory = path.join(root, "migrate-workload");
  const custom = "# Wholly synthetic retired skill with a local customization\n";
  await mkdir(oldDirectory);
  await writeFile(path.join(oldDirectory, "SKILL.md"), custom);

  const installed = await installSkill("try-models", root);
  assert.equal(installed.name, "try-models");
  assert.equal(installed.status, "installed");
  assert.equal(await readFile(path.join(oldDirectory, "SKILL.md"), "utf8"), custom);
  assert.deepEqual((await readdir(root)).sort(), ["migrate-workload", "try-models"]);
  assert.equal(listSkills().skills.some(({ name }) => name === "migrate-workload"), false);
  await assert.rejects(installSkill("migrate-workload", root), CliError);
});

test("unknown skill and empty or null-containing paths fail before creating anything", async (t) => {
  const directory = await fixture(t);
  await assert.rejects(installSkill("../synthetic-other", path.join(directory, "absent")), CliError);
  for (const value of ["", "   ", "\0invalid"]) await assert.rejects(installSkill("setup-understudy", value), CliError);
  assert.deepEqual(await readdir(directory), []);
});

test("install refreshes an edited bundle without leaving staging or lock files", async (t) => {
  const root = await fixture(t);
  const installed = await installSkill("setup-understudy", root);
  const custom = "# Synthetic local skill edit\n";
  await writeFile(installed.entrypoint, custom);
  assert.deepEqual(await installSkill("setup-understudy", root), installed);
  assert.equal(await readFile(installed.entrypoint, "utf8"), setupSkill.files.find(file => file.path === "SKILL.md").content);
  assert.deepEqual(await readdir(root), ["setup-understudy"]);
});

test("refresh removes obsolete files and directories inside the selected bundle", async (t) => {
  for (const kind of ["file", "directory"]) {
    const root = await fixture(t);
    const installed = await installSkill("setup-understudy", root);
    const extra = path.join(installed.directory, "synthetic-local-notes");
    if (kind === "file") await writeFile(extra, "Invented local notes\n");
    else await mkdir(extra);
    assert.equal((await installSkill("setup-understudy", root)).status, "installed");
    assert.equal((await readdir(installed.directory)).includes("synthetic-local-notes"), false);
    assert.deepEqual(await readdir(root), ["setup-understudy"]);
  }
});

test("install fills incomplete or empty bundles but refuses a regular-file destination", async (t) => {
  for (const kind of ["empty", "incomplete", "file"]) {
    const root = await fixture(t);
    const destination = path.join(root, "setup-understudy");
    if (kind === "file") await writeFile(destination, "Synthetic file, not a skill\n");
    else {
      await mkdir(destination);
      if (kind === "incomplete") await writeFile(path.join(destination, "SKILL.md"), setupSkill.files.find(({ path: name }) => name === "SKILL.md").content);
    }
    if (kind === "file") await assert.rejects(installSkill("setup-understudy", root), CliError);
    else assert.equal((await installSkill("setup-understudy", root)).status, "installed");
    assert.deepEqual(await readdir(root), ["setup-understudy"]);
    if (kind === "file") assert.equal(await readFile(destination, "utf8"), "Synthetic file, not a skill\n");
    else assert.equal((await installSkill("setup-understudy", root)).status, "unchanged");
  }
});

test("selected skill roots and existing ancestors may be intentional symbolic links", async (t) => {
  const directory = await fixture(t);
  const real = path.join(directory, "real");
  await mkdir(real);
  const alias = path.join(directory, "alias");
  await symlink(real, alias, "dir");
  const first = await installSkill("setup-understudy", alias);
  assert.equal(first.directory, path.join(real, "setup-understudy"));
  assert.equal((await installSkill("setup-understudy", alias)).status, "unchanged");
  const nested = await installSkill("setup-understudy", path.join(alias, "nested", "skills"));
  assert.equal(nested.directory, path.join(real, "nested", "skills", "setup-understudy"));
  assert.equal((await installSkill("setup-understudy", path.join(real, "nested", "skills"))).status, "unchanged");
});

test("dangling selected roots and dangling ancestors fail without creating directories", async (t) => {
  const directory = await fixture(t);
  const alias = path.join(directory, "alias");
  await symlink(path.join(directory, "absent"), alias, "dir");
  await assert.rejects(installSkill("setup-understudy", alias), /dangling symbolic link/);
  await assert.rejects(installSkill("setup-understudy", path.join(alias, "nested")), /dangling symbolic link/);
  assert.deepEqual(await readdir(directory), ["alias"]);
});

test("symlink skill destination is refused including a dangling link", async (t) => {
  for (const dangling of [false, true]) {
    const root = await fixture(t);
    const other = path.join(root, "synthetic-other");
    if (!dangling) await mkdir(other);
    await symlink(other, path.join(root, "setup-understudy"), "dir");
    await assert.rejects(installSkill("setup-understudy", root), /symbolic links/);
    assert.deepEqual((await readdir(root)).sort(), dangling ? ["setup-understudy"] : ["setup-understudy", "synthetic-other"]);
    if (!dangling) assert.deepEqual(await readdir(other), []);
  }
});

test("symlink files or subdirectories inside an installed skill are refused", async (t) => {
  for (const kind of ["file", "directory"]) {
    const root = await fixture(t);
    const installed = await installSkill("setup-understudy", root);
    const target = kind === "file" ? installed.entrypoint : path.join(installed.directory, "references");
    const displaced = path.join(root, `synthetic-${kind}`);
    if (kind === "file") await writeFile(displaced, await readFile(target));
    else await mkdir(displaced);
    await rm(target, { recursive: true });
    await symlink(displaced, target, kind === "file" ? "file" : "dir");
    await assert.rejects(installSkill("setup-understudy", root), /symbolic link/);
    assert.deepEqual((await readdir(root)).sort(), ["setup-understudy", `synthetic-${kind}`]);
  }
});

test("symbolic link lock is refused without deleting or using it", async (t) => {
  const root = await fixture(t);
  const other = path.join(root, "synthetic-other");
  await mkdir(other);
  const lock = ".understudy-install-setup-understudy.lock";
  await symlink(other, path.join(root, lock), "dir");
  await assert.rejects(installSkill("setup-understudy", root), /lock is not a regular directory/);
  assert.deepEqual((await readdir(root)).sort(), [lock, "synthetic-other"]);
  assert.deepEqual(await readdir(other), []);
});

test("concurrent installers serialize to one installed result and one unchanged result", async (t) => {
  const root = await fixture(t);
  const results = await Promise.all([installSkill("setup-understudy", root), installSkill("setup-understudy", root)]);
  assert.deepEqual(results.map(({ status }) => status).sort(), ["installed", "unchanged"]);
  assert.deepEqual(await readdir(root), ["setup-understudy"]);
  assert.equal((await installSkill("setup-understudy", root)).status, "unchanged");
});

function fileSystemError(code) {
  return Object.assign(new Error(`Synthetic filesystem error: ${code}`), { code });
}

function mockFileSystem(t, overrides) {
  for (const [name, implementation] of Object.entries(overrides)) t.mock.method(fileSystem, name, implementation);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("filesystems without hard links use exclusive copies and retain byte-perfect idempotence", async (t) => {
  for (const code of ["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS", "EXDEV"]) {
    await t.test(code, async (t) => {
      const root = await fixture(t);
      const nativeCopy = fileSystem.copyFile;
      const published = [];
      mockFileSystem(t, {
        link: async () => { throw fileSystemError(code); },
        copyFile: async (source, destination, flags) => {
          assert.equal(flags, constants.COPYFILE_EXCL);
          await nativeCopy(source, destination, flags);
          published.push(destination);
        },
      });
      const installed = await installSkill("setup-understudy", root);
      assert.equal(installed.status, "installed");
      assert.equal(published.length, setupSkill.files.length);
      assert.equal(published.at(-1), installed.entrypoint);
      for (const file of setupSkill.files) {
        assert.equal(await readFile(path.join(installed.directory, file.path), "utf8"), file.content);
      }
      assert.equal((await installSkill("setup-understudy", root)).status, "unchanged");
      assert.deepEqual(await readdir(root), ["setup-understudy"]);
    });
  }
});

test("a native link collision is preserved without attempting the copy fallback", async (t) => {
  const root = await fixture(t);
  let collision;
  let copyAttempts = 0;
  mockFileSystem(t, {
    link: async (_source, destination) => {
      collision = destination;
      await writeFile(destination, "Synthetic concurrent content\n", { flag: "wx" });
      throw fileSystemError("EEXIST");
    },
    copyFile: async () => { copyAttempts++; },
  });
  await assert.rejects(installSkill("setup-understudy", root), CliError);
  assert.equal(copyAttempts, 0);
  assert.equal(await readFile(collision, "utf8"), "Synthetic concurrent content\n");
  assert.deepEqual(await readdir(root), ["setup-understudy"]);
});

test("a concurrent destination survives the exclusive-copy fallback and prior files roll back", async (t) => {
  const root = await fixture(t);
  let linkAttempts = 0;
  let firstPublished;
  let collision;
  mockFileSystem(t, {
    link: async (_source, destination) => {
      linkAttempts++;
      if (linkAttempts === 1) firstPublished = destination;
      if (linkAttempts === 2) {
        collision = destination;
        await writeFile(destination, "Synthetic concurrent content\n", { flag: "wx" });
      }
      throw fileSystemError("ENOTSUP");
    },
  });
  await assert.rejects(installSkill("setup-understudy", root), CliError);
  assert.equal(linkAttempts, 2);
  assert.equal(await readFile(collision, "utf8"), "Synthetic concurrent content\n");
  await assert.rejects(readFile(firstPublished), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), ["setup-understudy"]);
});

test("a failed copy rolls back prior copies and staging without changing unrelated content", async (t) => {
  const root = await fixture(t);
  const unrelated = path.join(root, "synthetic-local-notes.md");
  await writeFile(unrelated, "Synthetic local notes\n");
  const nativeCopy = fileSystem.copyFile;
  let copyAttempts = 0;
  mockFileSystem(t, {
    link: async () => { throw fileSystemError("ENOSYS"); },
    copyFile: async (source, destination, flags) => {
      copyAttempts++;
      if (copyAttempts === 2) throw fileSystemError("ENOSPC");
      return nativeCopy(source, destination, flags);
    },
  });
  await assert.rejects(installSkill("setup-understudy", root), CliError);
  assert.equal(copyAttempts, 2);
  assert.equal(await readFile(unrelated, "utf8"), "Synthetic local notes\n");
  assert.deepEqual(await readdir(root), ["synthetic-local-notes.md"]);
});

test("installing the bundle returns all skills and repeats without changes", async (t) => {
  const root = await fixture(t);
  const result = await installSkills(root);
  assert.equal(result.cliVersion, listSkills().cliVersion);
  assert.deepEqual(result.skills.map(({ name }) => name), bundledSkills.map(({ name }) => name));
  assert.ok(result.skills.every(({ status }) => status === "installed"));
  for (const skill of bundledSkills) {
    for (const file of skill.files) assert.equal(await readFile(path.join(root, skill.name, file.path), "utf8"), file.content);
  }
  const repeated = await installSkills(root);
  assert.ok(repeated.skills.every(({ status }) => status === "unchanged"));
  assert.deepEqual((await readdir(root)).sort(), bundledSkills.map(({ name }) => name).sort());
});

test("refreshing an old bundle replaces all bundled skills while preserving unrelated skills and saved data", async t => {
  const directory = await fixture(t);
  const root = path.join(directory, "skills");
  for (const skill of bundledSkills) {
    const destination = path.join(root, skill.name);
    await mkdir(path.join(destination, "obsolete"), { recursive: true });
    await writeFile(path.join(destination, "SKILL.md"), `# Synthetic older ${skill.name}\n`);
    await writeFile(path.join(destination, "obsolete", "old.md"), "Synthetic obsolete resource\n");
  }
  const kept = [
    [path.join(root, "synthetic-unrelated", "SKILL.md"), "Synthetic unrelated skill\n"],
    [path.join(root, "migrate-workload", "SKILL.md"), "Synthetic retired skill\n"],
    [path.join(directory, "application", ".understudy", "captures.json"), "Synthetic downloaded data\n"],
    [path.join(directory, ".understudy", "synthetic-state.json"), "Synthetic saved state\n"],
  ];
  for (const [file, content] of kept) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const result = await installSkills(root);
  assert.equal(result.skills.length, 8);
  assert.ok(result.skills.every(skill => skill.status === "installed"));
  for (const skill of bundledSkills) {
    for (const file of skill.files) assert.equal(await readFile(path.join(root, skill.name, file.path), "utf8"), file.content);
    await assert.rejects(fileSystem.lstat(path.join(root, skill.name, "obsolete")), { code: "ENOENT" });
  }
  for (const [file, content] of kept) assert.equal(await readFile(file, "utf8"), content);
  assert.ok((await installSkills(root)).skills.every(skill => skill.status === "unchanged"));
  assert.deepEqual((await readdir(root)).sort(), [...bundledSkills.map(skill => skill.name), "migrate-workload", "synthetic-unrelated"].sort());
});

test("failed staging leaves the existing skill intact before refresh begins", async t => {
  const root = await fixture(t);
  const installed = await installSkill("setup-understudy", root);
  const old = "# Synthetic older skill\n";
  await writeFile(installed.entrypoint, old);
  const nativeOpen = fileSystem.open;
  mockFileSystem(t, { open: async (file, ...args) => {
    if (file.includes(`${path.sep}bundle${path.sep}`)) throw fileSystemError("ENOSPC");
    return nativeOpen(file, ...args);
  } });
  await assert.rejects(installSkill(installed.name, root), /run skills install again/);
  assert.equal(await readFile(installed.entrypoint, "utf8"), old);
  assert.deepEqual(await readdir(root), [installed.name]);
});

test("interrupted refresh cleans incomplete new files and can be completed by rerunning install", async t => {
  const root = await fixture(t);
  const installed = await installSkill("setup-understudy", root);
  await writeFile(installed.entrypoint, "# Synthetic older skill\n");
  const nativeLink = fileSystem.link;
  let failing = true;
  mockFileSystem(t, { link: async (...args) => {
    if (failing) throw fileSystemError("ENOSPC");
    return nativeLink(...args);
  } });
  await assert.rejects(installSkill(installed.name, root), /run skills install again/);
  assert.deepEqual(await readdir(root), []);
  failing = false;
  assert.equal((await installSkill(installed.name, root)).status, "installed");
  assert.equal((await installSkill(installed.name, root)).status, "unchanged");
});

test("bundle preflight detects a later unsafe tree before installing earlier missing skills", async (t) => {
  const root = await fixture(t);
  const conflicting = bundledSkills.at(-1);
  const destination = path.join(root, conflicting.name);
  await mkdir(destination);
  await symlink(path.join(root, "synthetic-missing"), path.join(destination, "SKILL.md"));
  await assert.rejects(installSkills(root), (error) => {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes(conflicting.name));
    assert.match(error.message, /No bundled skills were installed/);
    return true;
  });
  assert.deepEqual(await readdir(root), [conflicting.name]);
  assert.equal((await fileSystem.lstat(path.join(destination, "SKILL.md"))).isSymbolicLink(), true);
});

test("bundle preflight refuses a linked skill while accepting an intentionally linked root", async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, "skills");
  const shared = path.join(directory, "shared");
  const alias = path.join(directory, "alias");
  await mkdir(root);
  await mkdir(shared);
  await symlink(root, alias, "dir");
  const linked = bundledSkills.at(-1);
  await symlink(shared, path.join(root, linked.name), "dir");
  await assert.rejects(installSkills(alias), /symbolic links/);
  assert.deepEqual(await readdir(root), [linked.name]);
  assert.deepEqual(await readdir(shared), []);
});

test("bundle installation keeps identical installed skills while filling missing ones", async (t) => {
  const root = await fixture(t);
  await installSkill(bundledSkills[0].name, root);
  const result = await installSkills(root);
  assert.equal(result.skills[0].status, "unchanged");
  assert.ok(result.skills.slice(1).every(({ status }) => status === "installed"));
  assert.deepEqual((await readdir(root)).sort(), bundledSkills.map(({ name }) => name).sort());
});

test("a late bundle failure reports retained complete skills and rolls back the failed skill", async (t) => {
  const root = await fixture(t);
  const nativeLink = fileSystem.link;
  const failedSkill = bundledSkills[1];
  mockFileSystem(t, {
    link: async (source, destination) => {
      if (destination.startsWith(path.join(root, failedSkill.name) + path.sep)) throw fileSystemError("EACCES");
      return nativeLink(source, destination);
    },
  });
  await assert.rejects(installSkills(root), (error) => {
    assert.ok(error instanceof CliError);
    assert.ok(error.message.includes(`Could not install ${failedSkill.name}`));
    assert.ok(error.message.includes(`Already installed: ${bundledSkills[0].name}`));
    return true;
  });
  assert.deepEqual(await readdir(root), [bundledSkills[0].name]);
  assert.equal((await installSkill(bundledSkills[0].name, root)).status, "unchanged");
});
