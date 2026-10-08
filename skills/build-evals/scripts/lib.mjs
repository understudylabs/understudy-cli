import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const fail = (message, code = 'INVALID_EVAL') => { throw Object.assign(new Error(message), { code }); };
const own = (value, key) => Object.hasOwn(value, key);
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function assertJson(value, label = 'Value', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail(`${label} contains an invalid number.`); return; }
  if (!value || typeof value !== 'object' || ancestors.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(`${label} must contain only serializable JSON values.`);
  ancestors.add(value);
  if (Array.isArray(value)) for (let i = 0; i < value.length; i++) if (!own(value, i)) fail(`${label} contains a sparse array.`);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !own(descriptor, 'value') || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))) fail(`${label} contains unsupported properties.`);
    assertJson(descriptor.value, label, ancestors);
  }
  ancestors.delete(value);
}
export function keys(value, allowed, label) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label} contains unsupported fields or is not an object.`); }
export function validateRunId(value) { if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value)) fail('Names must use lowercase letters, digits, underscores, or hyphens (1–80 characters).'); return value; }
const text = (value, label) => { if (typeof value !== 'string' || !value.trim()) fail(`${label} must be nonempty text.`); };
const list = (value, label) => { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail(`${label} must be an array of strings.`); };
const within = (parent, child) => child === parent || (!path.relative(parent, child).startsWith(`..${path.sep}`) && path.relative(parent, child) !== '..' && !path.isAbsolute(path.relative(parent, child)));
export async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export async function noSymlinks(file) {
  const absolute = path.resolve(file); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!(await exists(current))) break;
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail(`Symlinks are not accepted: ${current}`);
  }
  return absolute;
}
const git = (cwd, args) => exec('git', args, { cwd, env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' } });
function gitFailure(operation) { fail(`Git ${operation} failed. Resolve Git availability, repository ownership, and permissions before writing eval evidence.`, 'GIT_CHECK_FAILED'); }
async function repositoryRoot(cwd) {
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
    if (!path.isAbsolute(root)) gitFailure('repository discovery');
    return root;
  } catch (error) {
    const diagnostic = error.stderr?.trim();
    const notRepository = error.code === 128 && !error.stdout?.trim() && (
      diagnostic === 'fatal: not a git repository (or any of the parent directories): .git' ||
      /^fatal: not a git repository \(or any parent up to mount point [^\r\n]+\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.$/.test(diagnostic ?? '')
    );
    if (!notRepository) gitFailure('repository discovery');
    // Git can emit the same diagnostic for an unreadable .git directory.
    // Only an absent repository marker permits a non-Git application workspace.
    try {
      let current = await realpath(cwd);
      while (true) {
        if (await exists(path.join(current, '.git'))) gitFailure('repository discovery');
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } catch { gitFailure('repository discovery'); }
    return null;
  }
}
async function checkTrackedState(root) {
  let tracked;
  try { tracked = (await git(root, ['ls-files', '-z', '--', '.understudy'])).stdout; }
  catch { gitFailure('tracked-state check'); }
  if (tracked) fail('Application .understudy contains tracked files; move private state out of history before continuing.');
}
export async function appRoot(cwd = process.cwd()) {
  const root = await realpath(await repositoryRoot(cwd) ?? cwd);
  const packageFile = path.join(root, 'package.json');
  if (await exists(packageFile)) {
    const pkg = await readJson(packageFile);
    if (pkg.name === 'understudy-cli') fail('Use a separate application workspace, never the Understudy CLI source checkout.');
  }
  return root;
}
export async function privatePath(file, createParents = false) {
  const absolute = await noSymlinks(file), parts = absolute.split(path.sep), position = parts.lastIndexOf('.understudy');
  if (position < 0) fail('Runtime evidence must stay inside application .understudy state.');
  let current = parts.slice(0, position).join(path.sep) || path.sep;
  for (let i = position; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    if (!(await exists(current))) {
      if (createParents && i < parts.length - 1) await mkdir(current, { mode: 0o700 });
      else continue;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (i < parts.length - 1 && !info.isDirectory())) fail('Private paths must contain only regular directories and files.');
    if (process.platform !== 'win32' && ((info.mode & 0o777) !== (info.isDirectory() ? 0o700 : 0o600) || info.uid !== process.getuid())) fail(`Private permissions required: ${current}`);
    if (info.isFile() && info.nlink !== 1) fail('Private files must not have multiple hard links.');
  }
  return absolute;
}
export async function writePrivate(file, content, exclusive = false) {
  const target = await privatePath(file, true), handle = await open(target, exclusive ? 'wx' : 'w', 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
export async function atomicJson(file, value) {
  await privatePath(file, true);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writePrivate(temporary, `${JSON.stringify(value, null, 2)}\n`, true); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
export async function appendRow(file, value) {
  await privatePath(file); const handle = await open(file, 'a', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
}
export async function readJson(file) { await noSymlinks(file); return JSON.parse(await readFile(file, 'utf8')); }
export async function readJsonl(file) {
  await noSymlinks(file); const content = await readFile(file, 'utf8');
  if (content && !content.endsWith('\n')) fail(`Incomplete JSONL evidence: ${file}`);
  return content.split('\n').filter(line => line.trim()).map((line, index) => { try { return JSON.parse(line); } catch { fail(`Invalid JSONL at line ${index + 1}: ${file}`); } });
}
export async function gitSafety(root, directory) {
  if (await repositoryRoot(root) === null) return;
  const relative = path.relative(root, directory);
  await checkTrackedState(root);
  try { await git(root, ['check-ignore', '--quiet', '--', relative]); }
  catch (error) {
    if (error.code !== 1) gitFailure('ignore check');
    fail('The private eval directory must be Git-ignored before writing evidence.');
  }
}
async function initPrivateDirectory(name, group) {
  validateRunId(name); const root = await appRoot(), state = path.join(root, '.understudy'), directory = path.join(state, group, name);
  if (await exists(directory)) fail('The private output directory already exists. Choose a new name.');
  if (await repositoryRoot(root) !== null) await checkTrackedState(root);
  const ignore = path.join(state, '.gitignore');
  await privatePath(ignore, true);
  if (!(await exists(ignore))) await writePrivate(ignore, '*\n', true);
  await gitSafety(root, directory);
  await privatePath(path.join(directory, '.placeholder'), true);
  return directory;
}
export const initDirectory = name => initPrivateDirectory(name, 'evals');
export const initComparisonDirectory = name => initPrivateDirectory(name, 'comparisons');
export async function resolveEval(input) {
  if (typeof input !== 'string') fail('Supply --eval with a private eval directory.');
  const root = await appRoot(), directory = path.resolve(root, input), base = path.join(root, '.understudy', 'evals');
  if (path.dirname(directory) !== base) fail('Choose .understudy/evals/<name> in this application.');
  validateRunId(path.basename(directory)); await privatePath(directory); await gitSafety(root, directory);
  if (!(await lstat(directory)).isDirectory()) fail('The eval path is not a directory.');
  return directory;
}
export function validateManifest(value) {
  assertJson(value, 'Manifest');
  keys(value, ['schemaVersion','name','mode','description','workload','purpose','rubricStatus','selection','criteria','adapter','grader','fingerprintFiles','settings'], 'Manifest');
  if (value.schemaVersion !== 1 || !['low','medium'].includes(value.mode) || value.purpose !== 'selected-regression' || !['provisional','confirmed'].includes(value.rubricStatus)) fail('Unsupported manifest version, mode, purpose, or rubric status.');
  validateRunId(value.name); text(value.description, 'Description');
  keys(value.workload, ['source','organizationId','projectId','workloadId','name'], 'Workload');
  if (!['understudy','synthetic'].includes(value.workload.source)) fail('Workload source must be understudy or synthetic.');
  for (const field of ['organizationId','projectId','workloadId','name']) text(value.workload[field], `Workload ${field}`);
  keys(value.selection, ['method','limitations'], 'Selection'); text(value.selection.method, 'Selection method'); list(value.selection.limitations, 'Selection limitations');
  if (!Array.isArray(value.criteria) || !value.criteria.length) fail('Declare at least one criterion.');
  const ids = new Set();
  for (const criterion of value.criteria) {
    keys(criterion, ['id','description','required','grading'], 'Criterion'); validateRunId(criterion.id); text(criterion.description, 'Criterion description');
    if (typeof criterion.required !== 'boolean' || ids.has(criterion.id) || !['code','model','human'].includes(criterion.grading ?? 'code')) fail('Criteria need unique IDs, an explicit required boolean, and supported grading mode.'); ids.add(criterion.id);
  }
  if (!value.criteria.some(criterion => criterion.required)) fail('Declare at least one required criterion.');
  for (const field of ['adapter','grader']) if (typeof value[field] !== 'string' || !value[field].endsWith('.mjs') || path.isAbsolute(value[field]) || value[field].split(/[\\/]/).includes('..')) fail(`${field} must reference an .mjs file within the eval directory.`);
  list(value.fingerprintFiles, 'fingerprintFiles');
  keys(value.settings, ['repetitions','timeoutMs'], 'Settings');
  if (!Number.isInteger(value.settings.repetitions) || value.settings.repetitions < 1 || value.settings.repetitions > 100 || !Number.isInteger(value.settings.timeoutMs) || value.settings.timeoutMs < 1 || value.settings.timeoutMs > 3600000) fail('Use 1–100 repetitions and a timeoutMs from 1 to 3600000.');
  return value;
}
export function validateExecution(value) {
  assertJson(value, 'Execution');
  keys(value, ['output','trace','metrics','receipt'], 'Execution');
  if (!own(value, 'output')) fail('The execution has no output.', 'MISSING_OUTPUT');
  if (value.trace !== undefined && (!Array.isArray(value.trace) || value.trace.some(row => { keys(row, ['role','content','name'], 'Trace row'); return typeof row.role !== 'string' || !own(row, 'content') || (row.name !== undefined && typeof row.name !== 'string'); }))) fail('Invalid trace.');
  if (value.metrics !== undefined) {
    keys(value.metrics, ['costUsd','judgeCostUsd','latencyMs','modelLatencyMs','inputTokens','outputTokens'], 'Metrics');
    for (const [key, metric] of Object.entries(value.metrics)) if (metric !== null && (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0 || (key.endsWith('Tokens') && !Number.isSafeInteger(metric)))) fail(`Invalid metric: ${key}`);
  }
  if (value.receipt !== undefined) {
    keys(value.receipt, ['model','requestIds','scope','calls','callsComplete'], 'Receipt');
    if (value.receipt.model !== undefined) text(value.receipt.model, 'Receipt model');
    if (value.receipt.requestIds !== undefined) list(value.receipt.requestIds, 'Receipt requestIds');
    if (value.receipt.scope !== undefined && (!object(value.receipt.scope) || Object.values(value.receipt.scope).some(item => item !== null && typeof item !== 'string'))) fail('Receipt scope must contain string or null values.');
    if (value.receipt.callsComplete !== undefined && (typeof value.receipt.callsComplete !== 'boolean' || !Array.isArray(value.receipt.calls))) fail('Call coverage requires a calls array and a boolean callsComplete.');
    if (value.receipt.calls !== undefined) {
      if (!Array.isArray(value.receipt.calls)) fail('Receipt calls must be an array.');
      const seen = new Set();
      for (const call of value.receipt.calls) {
        keys(call, ['requestId','requestedModel','servedModel','fallbackUsed','costUsd','costBasis'], 'Call receipt');
        for (const field of ['requestId','requestedModel','servedModel']) {
          if (!own(call, field)) fail(`Call receipt requires ${field}; use null for unknown.`);
          if (call[field] !== null) text(call[field], `Call ${field}`);
        }
        if (call.requestId !== null) { if (seen.has(call.requestId)) fail('Duplicate request ID in call receipts.'); seen.add(call.requestId); }
        if (call.fallbackUsed !== null && typeof call.fallbackUsed !== 'boolean') fail('Call fallbackUsed must be a boolean or null.');
        if (call.costUsd !== undefined && call.costUsd !== null && (typeof call.costUsd !== 'number' || !Number.isFinite(call.costUsd) || call.costUsd < 0)) fail('Call cost must be nonnegative or unknown.');
        if (call.costBasis !== undefined && !['calculated','reference-estimate','observed-provider','synthetic'].includes(call.costBasis)) fail('Unknown call cost basis.');
        if (call.costUsd !== undefined && call.costUsd !== null && !call.costBasis) fail('A known call cost requires its cost basis.');
      }
      if (value.receipt.callsComplete === true && value.receipt.requestIds !== undefined && (value.receipt.calls.some(call => call.requestId === null) || value.receipt.requestIds.length !== seen.size || value.receipt.requestIds.some(id => !seen.has(id)))) fail('Complete call receipts must match requestIds when supplied.');
      if (value.receipt.callsComplete === true && value.receipt.model !== undefined && value.receipt.calls.some(call => call.servedModel !== value.receipt.model)) fail('A single receipt model cannot describe mixed or unknown complete call receipts.');
    }
  }
  return value;
}
export function executionFromControl(control) {
  if (own(control, 'output') === own(control, 'execution')) fail('A control must supply exactly one of output or execution.');
  return validateExecution(own(control, 'execution') ? control.execution : { output: control.output });
}
export function validateCases(cases, workload) {
  const ids = new Set(), groups = new Map();
  for (const item of cases) {
    assertJson(item, 'Case');
    keys(item, ['id','title','input','expected','origin','sourceRefs','tags','split','groupId','observed'], 'Case');
    validateRunId(item.id); text(item.title, 'Case title');
    if (ids.has(item.id) || !own(item, 'input') || !own(item, 'expected') || !['synthetic','trace'].includes(item.origin) || !['regression','train','dev','test'].includes(item.split)) fail('Cases need unique IDs, input, expected outcome, origin, and split.');
    ids.add(item.id); list(item.sourceRefs, 'sourceRefs'); list(item.tags, 'tags');
    if (workload?.source === 'synthetic' && (item.origin !== 'synthetic' || item.sourceRefs.length)) fail('Synthetic workloads require invented cases with synthetic origin and no source references.');
    if (item.groupId !== undefined) {
      text(item.groupId, 'groupId');
      if (groups.has(item.groupId) && groups.get(item.groupId) !== item.split) fail('Related cases must remain in the same split.');
      groups.set(item.groupId, item.split);
    }
    if (item.observed !== undefined) validateExecution(item.observed);
  }
  return cases;
}
export function validateVerdicts(value, manifest) {
  assertJson(value, 'Grade');
  keys(value, ['verdicts','judge'], 'Grade'); keys(value.verdicts, manifest.criteria.map(item => item.id), 'Verdicts');
  if (value.judge !== undefined) validateJudge(value.judge);
  for (const criterion of manifest.criteria) {
    const verdict = value.verdicts[criterion.id]; keys(verdict, ['status','reason'], `Verdict ${criterion.id}`);
    if (!['pass','fail','unscored'].includes(verdict.status)) fail(`Invalid verdict for ${criterion.id}.`);
    if (criterion.grading === 'human' && verdict.status !== 'unscored') fail(`Human criterion ${criterion.id} must remain unscored until separately reviewed.`);
    text(verdict.reason, `Reason for ${criterion.id}`);
  }
  return value.verdicts;
}
export function validateJudge(value) {
  keys(value, ['costUsd','model','requestIds'], 'Judge receipt');
  if (value.costUsd !== undefined && value.costUsd !== null && (typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd) || value.costUsd < 0)) fail('Judge cost must be nonnegative or unknown.');
  if (value.model !== undefined) text(value.model, 'Judge model');
  if (value.requestIds !== undefined) list(value.requestIds, 'Judge request IDs');
}
export async function loadEval(directory) {
  const files = ['manifest.json','cases.jsonl','controls.jsonl'];
  for (const file of files) await privatePath(path.join(directory, file));
  const manifest = validateManifest(await readJson(path.join(directory, files[0]))), cases = validateCases(await readJsonl(path.join(directory, files[1])), manifest.workload), controls = await readJsonl(path.join(directory, files[2]));
  if (manifest.name !== path.basename(directory)) fail('Manifest name does not match the eval directory.');
  const ids = new Set(), criterionIds = manifest.criteria.map(item => item.id);
  for (const control of controls) {
    assertJson(control, 'Control');
    keys(control, ['id','caseId','output','execution','expectedVerdicts','note'], 'Control'); validateRunId(control.id); text(control.note, 'Control note');
    if (ids.has(control.id) || !cases.some(item => item.id === control.caseId)) fail('Controls need unique IDs and known case IDs.'); ids.add(control.id);
    executionFromControl(control);
    keys(control.expectedVerdicts, criterionIds, 'Expected control verdicts');
    for (const criterion of manifest.criteria) {
      if (!['pass','fail','unscored'].includes(control.expectedVerdicts[criterion.id])) fail('Each control must declare every expected criterion verdict.');
      if (criterion.grading === 'human' && control.expectedVerdicts[criterion.id] !== 'unscored') fail('Human-review controls must expect unscored machine verdicts.');
    }
  }
  const root = await appRoot(), fingerprint = createHash('sha256');
  fingerprint.update(JSON.stringify({ toolkit: 1, node: process.versions.node }));
  for (const name of ['eval.mjs','worker.mjs','lib.mjs']) {
    fingerprint.update(name); fingerprint.update(await readFile(fileURLToPath(new URL(name, import.meta.url))));
  }
  for (const reference of [...files, manifest.adapter, manifest.grader, ...manifest.fingerprintFiles]) {
    const file = path.resolve(directory, reference);
    if (!within(root, file)) fail('Fingerprint files must remain inside the application root.');
    await noSymlinks(file); if (within(directory, file)) await privatePath(file);
    const bytes = await readFile(file); fingerprint.update(JSON.stringify([reference, bytes.length])); fingerprint.update(bytes);
  }
  return { directory, manifest, cases, controls, fingerprint: fingerprint.digest('hex') };
}
export async function loadRun(evalDir, runId) {
  validateRunId(runId); const directory = path.join(evalDir, 'results', runId);
  for (const file of ['run.json','cases.jsonl','results.jsonl']) await privatePath(path.join(directory, file));
  const run = await readJson(path.join(directory, 'run.json')), cases = await readJsonl(path.join(directory, 'cases.jsonl')), rows = await readJsonl(path.join(directory, 'results.jsonl'));
  assertJson(run, 'Run');
  keys(run, ['schemaVersion','id','kind','manifest','startedAt','completedAt','fingerprint','plannedCases','plannedAttempts','repetitions','sourceRun','sourceEvidenceDigest','requestedModel'], 'Run');
  if (run.requestedModel !== undefined) text(run.requestedModel, 'Requested model');
  validateManifest(run.manifest);
  validateCases(cases, run.manifest.workload);
  if (run.schemaVersion !== 1 || run.id !== runId || !['fresh','historical','regrade'].includes(run.kind) || run.plannedCases !== cases.length || !Number.isInteger(run.repetitions) || run.repetitions < 1 || run.repetitions > 100 || run.plannedAttempts !== cases.length * run.repetitions || typeof run.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(run.fingerprint) || !Number.isFinite(Date.parse(run.startedAt)) || (run.completedAt !== undefined && (!Number.isFinite(Date.parse(run.completedAt)) || Date.parse(run.completedAt) < Date.parse(run.startedAt)))) fail('Invalid frozen run metadata.');
  if ((run.kind === 'fresh' && run.repetitions !== run.manifest.settings.repetitions) || (run.kind === 'historical' && run.repetitions !== 1)) fail('Run repetitions differ from the frozen execution contract.');
  if (run.kind === 'regrade') { validateRunId(run.sourceRun); if (typeof run.sourceEvidenceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(run.sourceEvidenceDigest)) fail('Regrade needs its source evidence digest.'); }
  else if (run.sourceRun !== undefined || run.sourceEvidenceDigest !== undefined) fail('Only regrade runs may declare source-run identity.');
  const executionFile = path.join(directory, 'executions.jsonl');
  const executions = await exists(executionFile) ? (await privatePath(executionFile), await readJsonl(executionFile)) : [];
  for (const collection of [rows, executions]) {
  const seen = new Set();
  for (const row of collection) {
    assertJson(row, 'Result row');
    keys(row, ['schemaVersion','caseId','repetition','status','output','trace','metrics','receipt','verdicts','judge','error'], 'Result row');
    const key = `${row.caseId}:${row.repetition}`;
    if (row.schemaVersion !== 1 || !cases.some(item => item.id === row.caseId) || !Number.isInteger(row.repetition) || row.repetition < 1 || row.repetition > run.repetitions || seen.has(key) || !['ok','execution_error','environment_gap','timeout','grader_error','missing_output'].includes(row.status)) fail('Invalid, duplicate, or unknown result attempt.');
    seen.add(key);
    validateExecution({ output: null, ...Object.fromEntries(['output','trace','metrics','receipt'].filter(field => own(row, field)).map(field => [field, row[field]])) });
    if (row.verdicts !== undefined) validateVerdicts({ verdicts: row.verdicts }, run.manifest);
    if (row.status === 'ok') { if (!own(row, 'output') || row.error !== undefined) fail('A successful row requires output and no execution error.'); if (collection === rows && row.verdicts === undefined) fail('A successful result needs every criterion verdict.'); }
    else if (!row.error) fail('An unsuccessful attempt requires its error evidence.');
    if (row.judge !== undefined) validateJudge(row.judge);
    if (row.error !== undefined) { keys(row.error, ['message','code'], 'Result error'); text(row.error.message, 'Error message'); text(row.error.code, 'Error code'); }
  }}
  const evidence = row => ({
    ...Object.fromEntries(['output','trace','receipt'].filter(field => own(row, field)).map(field => [field, row[field]])),
    metrics: Object.fromEntries(Object.entries(row.metrics ?? {}).filter(([field]) => field !== 'judgeCostUsd')),
  });
  const checkpoints = new Map(executions.map(row => [`${row.caseId}:${row.repetition}`, row]));
  for (const row of rows) {
    const checkpoint = checkpoints.get(`${row.caseId}:${row.repetition}`);
    if (checkpoint && !isDeepStrictEqual(evidence(checkpoint), evidence(row))) fail(`Conflicting execution evidence for ${row.caseId}, repetition ${row.repetition}.`);
  }
  return { directory, run, rows, cases, executions };
}
