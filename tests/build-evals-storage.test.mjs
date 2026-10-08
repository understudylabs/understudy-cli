import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const library = new URL('../skills/build-evals/scripts/lib.mjs', import.meta.url).href;
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'synthetic-eval-storage-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, GIT_CONFIG_NOSYSTEM: '1', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const call = async (expression, overrides = {}) => {
    const script = `import * as lib from ${JSON.stringify(library)};
      try { console.log(JSON.stringify({ ok: true, value: await (${expression}) })); }
      catch (error) { console.log(JSON.stringify({ ok: false, code: error.code, message: error.message })); }`;
    const result = await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: { ...env, ...overrides }, timeout: 10000 });
    return JSON.parse(result.stdout);
  };
  const git = args => exec('git', args, { cwd: root, env });
  const fakeGit = async body => {
    const bin = path.join(root, 'synthetic-bin'); await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'git'), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return { PATH: bin, SYNTHETIC_GIT_ROOT: root, SYNTHETIC_GIT_MARKER: path.join(bin, 'called') };
  };
  return { root, call, git, fakeGit };
}
const absent = file => assert.rejects(lstat(file), { code: 'ENOENT' });
function rejected(result, code = 'GIT_CHECK_FAILED') { assert.equal(result.ok, false); assert.equal(result.code, code, result.message); }

test('an actual non-Git app and an ignored Git app can initialize private eval state', async t => {
  const f = await fixture(t);
  assert.equal((await f.call("lib.initDirectory('standalone')")).ok, true);
  await f.git(['init', '--quiet']);
  assert.equal((await f.call("lib.initDirectory('repository')")).ok, true);
  await f.git(['check-ignore', '--quiet', '--', '.understudy/evals/repository']);
  assert.equal(await readFile(path.join(f.root, '.understudy/.gitignore'), 'utf8'), '*\n');
});

test('unavailable Git fails before creating private state', async t => {
  const f = await fixture(t), bin = path.join(f.root, 'empty-bin'); await mkdir(bin);
  rejected(await f.call("lib.initDirectory('blocked')", { PATH: bin }));
  await absent(path.join(f.root, '.understudy'));
});

test('Git ownership and discovery errors do not become non-Git workspaces', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  for (const diagnostic of [
    'fatal: detected dubious ownership in repository',
    'fatal: cannot read repository: Permission denied',
    'fatal: not a git repository (or any of the parent directories): .git\nAn additional discovery failure',
  ]) {
    const env = await f.fakeGit(`printf '%s\\n' "$SYNTHETIC_GIT_ERROR" >&2\nexit 128`);
    rejected(await f.call("lib.initDirectory('blocked')", { ...env, SYNTHETIC_GIT_ERROR: diagnostic }));
    await absent(path.join(f.root, '.understudy'));
  }
});

test('an unreadable .git marker cannot use the genuine non-repository fallback', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const f = await fixture(t); await f.git(['init', '--quiet']);
  const marker = path.join(f.root, '.git'); await chmod(marker, 0);
  try {
    rejected(await f.call("lib.initDirectory('blocked')"));
    await absent(path.join(f.root, '.understudy'));
  } finally { await chmod(marker, 0o700); }
});

test('a tracked-state query failure blocks initialization before private writes', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const env = await f.fakeGit(`case "$1" in
    rev-parse) printf '%s\\n' "$SYNTHETIC_GIT_ROOT" ;;
    ls-files) printf '%s\\n' 'fatal: could not read index: Permission denied' >&2; exit 128 ;;
    *) exit 0 ;;
  esac`);
  rejected(await f.call("lib.initDirectory('blocked')", env));
  await absent(path.join(f.root, '.understudy'));
});

test('existing eval resolution fails if a later repository check fails', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  assert.equal((await f.call("lib.initDirectory('existing')")).ok, true);
  const env = await f.fakeGit(`case "$1" in
    rev-parse)
      if [ -f "$SYNTHETIC_GIT_MARKER" ]; then
        printf '%s\\n' 'fatal: detected dubious ownership in repository' >&2; exit 128
      fi
      printf 'called\\n' > "$SYNTHETIC_GIT_MARKER"
      printf '%s\\n' "$SYNTHETIC_GIT_ROOT" ;;
    *) exit 0 ;;
  esac`);
  rejected(await f.call("lib.resolveEval('.understudy/evals/existing')", env));
});

test('ignore-command errors fail closed and tracked state is still refused', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const env = await f.fakeGit(`case "$1" in
    rev-parse) printf '%s\\n' "$SYNTHETIC_GIT_ROOT" ;;
    check-ignore) printf '%s\\n' 'fatal: cannot read ignore rules: Permission denied' >&2; exit 128 ;;
    *) exit 0 ;;
  esac`);
  rejected(await f.call("lib.initDirectory('blocked')", env));
  await absent(path.join(f.root, '.understudy/evals/blocked'));
  await f.git(['init', '--quiet']);
  await writeFile(path.join(f.root, '.understudy/synthetic.json'), '{}\n', { mode: 0o600 });
  await f.git(['add', '--force', '--', '.understudy/synthetic.json']);
  const result = await f.call("lib.initDirectory('tracked')");
  rejected(result, 'INVALID_EVAL'); assert.match(result.message, /tracked files/);
  await absent(path.join(f.root, '.understudy/evals/tracked'));
});
