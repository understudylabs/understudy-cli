import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicJson, loadEval, loadRun, resolveEval, validateExecution, validateRunId, writePrivate } from './lib.mjs';

const statuses = ['ok', 'execution_error', 'environment_gap', 'timeout', 'grader_error', 'missing_output'];
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const json = (value) => JSON.stringify(value ?? null, null, 2);
const digest = (value) => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item)).digest('hex');
const number = (value) => value === null ? 'Unknown' : Number(value.toFixed(4)).toLocaleString('en-US');
const dollars = (value) => value === null ? 'Unknown' : `$${Number(value.toFixed(8)).toLocaleString('en-US', { maximumFractionDigits: 8 })}`;
const ratio = (numerator, denominator) => denominator ? `${numerator}/${denominator} (${number(100 * numerator / denominator)}%)` : 'Not measured (0 cases)';
const kindLabel = (kind) => ({ fresh: 'Fresh application execution', historical: 'Historical output grading', regrade: 'Saved-output regrading — no fresh execution', review: 'Input and observed-output review — no execution or automated grading' })[kind] ?? 'Unknown run kind';
const markdown = (value) => String(value ?? '').replace(/\s+/g, ' ').replace(/[\\`*_[\]<>#|]/g, '\\$&');
const fenced = (value) => { const text = json(value); const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1))); return `${fence}json\n${text}\n${fence}`; };
const workloadFields = (workload) => [['Name', workload.name], ['Source', workload.source], ['Organization ID', workload.organizationId], ['Project ID', workload.projectId], ['Workload ID', workload.workloadId]];
const workloadScope = 'This identity describes the eval’s source workload. Execution authorization is separate from this source identity.';

function quality(row, required) {
  if (!row) return 'pending';
  // A supported failure stays visible even when another check or the grader fails.
  if (required.some((criterion) => row.verdicts?.[criterion.id]?.status === 'fail')) return 'fail';
  if (row.status === 'ok' && required.length && required.every((criterion) => row.verdicts?.[criterion.id]?.status === 'pass')) return 'pass';
  return 'unscored';
}

function measure(rows, field, planned) {
  const values = rows.map((row) => row.metrics?.[field]).filter(finite);
  return { observed: values.length, planned, sum: values.length ? values.reduce((sum, value) => sum + value, 0) : null, complete: planned > 0 && values.length === planned };
}

function distribution(rows, field) {
  const values = rows.map((row) => row.metrics?.[field]).filter(finite).sort((a, b) => a - b);
  if (!values.length) return { observed: 0, min: null, median: null, p90: null, max: null, mean: null };
  const middle = Math.floor(values.length / 2);
  return { observed: values.length, min: values[0], median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2, p90: values[Math.ceil(values.length * .9) - 1], max: values.at(-1), mean: values.reduce((sum, value) => sum + value, 0) / values.length };
}

function modelCounts(rows, field, planned) {
  const counts = new Map();
  for (const row of rows) if (typeof row[field]?.model === 'string' && row[field].model.trim()) counts.set(row[field].model, (counts.get(row[field].model) ?? 0) + 1);
  const observed = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return { models: [...counts].map(([model, attempts]) => ({ model, attempts })), observed, missing: planned - observed, planned };
}

function applicationModels(rows, planned) {
  const models = new Map();
  let observed = 0, recordedCalls = 0, knownServedModels = 0, attemptsWithCallLists = 0, attemptsDeclaredComplete = 0, attemptsWithCompleteServedIdentity = 0;
  for (const row of rows) {
    const receipt = row.receipt;
    const seen = new Set();
    if (Array.isArray(receipt?.calls)) {
      attemptsWithCallLists++;
      recordedCalls += receipt.calls.length;
      for (const call of receipt.calls) {
        if (typeof call.servedModel !== 'string' || !call.servedModel.trim()) continue;
        knownServedModels++;
        seen.add(call.servedModel);
        const count = models.get(call.servedModel) ?? { attempts: 0, calls: 0 };
        count.calls++;
        models.set(call.servedModel, count);
      }
      if (receipt.callsComplete === true) {
        attemptsDeclaredComplete++;
        if (receipt.calls.length && receipt.calls.every(call => typeof call.servedModel === 'string' && call.servedModel.trim())) attemptsWithCompleteServedIdentity++;
      }
    } else if (typeof receipt?.model === 'string' && receipt.model.trim()) {
      // Retain the older attempt-level label, but never turn it into a call
      // receipt or use it to fill unknown served identities in a newer call list.
      seen.add(receipt.model);
    }
    if (seen.size) observed++;
    for (const model of seen) {
      const count = models.get(model) ?? { attempts: 0, calls: 0 };
      count.attempts++;
      models.set(model, count);
    }
  }
  return {
    models: [...models].map(([model, counts]) => ({ model, ...counts })), observed, missing: planned - observed, planned,
    basis: 'Observed counts attempts with at least one reported model identity. Each model counts an attempt once; mixed-model attempts can appear under several models. Calls count recorded per-call served identities only. Legacy labels are used only when a call list is absent.',
    legacy: modelCounts(rows, 'receipt', planned),
    callCoverage: { recordedCalls, knownServedModels, unknownServedModels: recordedCalls - knownServedModels, attemptsWithCallLists, attemptsDeclaredComplete, attemptsWithCompleteServedIdentity, attemptsWithoutCompleteServedIdentity: planned - attemptsWithCompleteServedIdentity, plannedAttempts: planned, complete: planned > 0 && attemptsWithCompleteServedIdentity === planned },
    coverageBasis: 'Complete served identity requires a nonempty call list, every recorded served model known, and callsComplete=true for every planned attempt. Call-list completeness is adapter-declared; an absent or partial list can hide additional calls. Legacy labels do not establish per-call coverage.',
  };
}

/** Derive descriptive measurements only from the frozen plan and recorded rows. */
export function summarizeRun(run, cases, rows) {
  const repetitions = run.repetitions;
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('Report requires a positive frozen repetition count.');
  const planned = cases.length * repetitions;
  if (run.plannedCases !== cases.length || run.plannedAttempts !== planned) throw new Error('Frozen case/attempt counts do not match the run plan.');
  const required = (run.manifest.criteria ?? []).filter((criterion) => criterion.required !== false);
  const byId = new Map(cases.map((item) => [item.id, item]));
  if (byId.size !== cases.length) throw new Error('Duplicate frozen case IDs.');
  const records = new Map();
  for (const row of rows) {
    if (!byId.has(row.caseId) || !Number.isInteger(row.repetition) || row.repetition < 1 || row.repetition > repetitions || !statuses.includes(row.status)) throw new Error('Recorded row is outside the frozen plan.');
    // Validate metrics even on errors; invalid evidence must not disappear as missing.
    validateExecution({ output: Object.hasOwn(row, 'output') ? row.output : null, ...Object.fromEntries(['trace', 'metrics', 'receipt'].filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]])) });
    if (row.verdicts !== undefined) {
      if (!row.verdicts || typeof row.verdicts !== 'object' || Array.isArray(row.verdicts)) throw new Error('Invalid recorded verdicts.');
      for (const [id, verdict] of Object.entries(row.verdicts)) if (!(run.manifest.criteria ?? []).some((criterion) => criterion.id === id) || !verdict || !['pass', 'fail', 'unscored'].includes(verdict.status) || typeof verdict.reason !== 'string') throw new Error('Invalid recorded criterion verdict.');
    }
    if (row.judge !== undefined) {
      if (!row.judge || typeof row.judge !== 'object' || Array.isArray(row.judge) || Object.keys(row.judge).some((key) => !['costUsd', 'model', 'requestIds'].includes(key))) throw new Error('Invalid judge receipt.');
      if (row.judge.costUsd !== undefined && row.judge.costUsd !== null && !finite(row.judge.costUsd)) throw new Error('Invalid judge cost.');
      if (row.judge.model !== undefined && (typeof row.judge.model !== 'string' || !row.judge.model.trim())) throw new Error('Invalid judge model.');
      if (row.judge.requestIds !== undefined && (!Array.isArray(row.judge.requestIds) || row.judge.requestIds.some((id) => typeof id !== 'string'))) throw new Error('Invalid judge request IDs.');
    }
    const key = json([row.caseId, row.repetition]);
    if (records.has(key)) throw new Error('Duplicate case/repetition result; cannot report an implicit best retry.');
    records.set(key, row);
  }
  const execution = Object.fromEntries(statuses.map((status) => [status, rows.filter((row) => row.status === status).length]));
  execution.pending = planned - rows.length;
  const applicationCompletedAttempts = rows.filter((row) => ['ok', 'grader_error'].includes(row.status) && Object.hasOwn(row, 'output')).length;
  const counts = { pass: 0, fail: 0, unscored: 0, pending: 0 };
  const perCase = cases.map((item) => {
    const outcomes = Array.from({ length: repetitions }, (_, index) => quality(records.get(json([item.id, index + 1])), required));
    const local = Object.fromEntries(Object.keys(counts).map((status) => [status, outcomes.filter((outcome) => outcome === status).length]));
    for (const key of Object.keys(counts)) counts[key] += local[key];
    const outcome = local.fail ? 'fail' : local.pass === repetitions ? 'pass' : local.pending === repetitions ? 'pending' : 'unscored';
    return { caseId: item.id, planned: repetitions, recorded: repetitions - local.pending, counts: local, outcome, observedPassFraction: local.pass / repetitions };
  });
  const cost = measure(rows, 'costUsd', planned);
  // Judge receipts are authoritative when their cost is known. Metrics remain a
  // fallback for imported rows with absent/unknown receipts; never add both.
  const judgeRows = rows.map((row) => ({ metrics: { judgeCostUsd: row.judge?.costUsd ?? row.metrics?.judgeCostUsd } }));
  const judgeCost = measure(judgeRows, 'judgeCostUsd', planned);
  const actualModels = applicationModels(rows, planned);
  const judgeModels = modelCounts(rows, 'judge', planned);
  // One frozen configuration, complete costs/quality, and no execution gaps are
  // required before describing the ratio as application cost per passing attempt.
  const comparable = run.manifest.rubricStatus === 'confirmed' && cost.complete && execution.ok === planned && counts.unscored === 0 && counts.pass > 0;
  return { schemaVersion: 1, runId: run.id, kind: run.kind, sourceRun: run.sourceRun ?? null, workload: run.manifest.workload, measurementStatus: run.manifest.rubricStatus === 'confirmed' ? 'requirements-confirmed' : 'provisional', measurementAuthority: 'Counts reflect recorded checks. A confirmed rubric means accepted requirements, not proof of independent grader validity or a verified business outcome.', plannedCases: cases.length, plannedAttempts: planned, recordedAttempts: rows.length, repetitions, requiredCriteria: required.map((criterion) => criterion.id), execution, applicationCompletedAttempts, quality: counts, decidedAttempts: counts.pass + counts.fail, observedPassFraction: planned ? counts.pass / planned : null, caseMeanObservedPassFraction: cases.length ? perCase.reduce((sum, item) => sum + item.observedPassFraction, 0) / cases.length : null, costUsd: cost, judgeCostUsd: judgeCost, actualModels, judgeModels, executionCostBasis: run.kind === 'regrade' ? 'Recorded source execution cost; not new spending by this regrade.' : 'Recorded application execution cost.', judgeCostBasis: 'Cost for the recorded grading pass; absent receipt/cost stays unknown.', costPerPassingAttemptUsd: comparable ? cost.sum / counts.pass : null, costPerPassingAttemptBasis: comparable ? 'Application cost for all planned attempts divided by passing attempts under the recorded checks; excludes judge cost.' : 'Unavailable: requires a confirmed rubric, complete application cost and decided quality for all planned attempts, successful execution, and at least one passing attempt.', latencyMs: distribution(rows, 'latencyMs'), modelLatencyMs: distribution(rows, 'modelLatencyMs'), perCase, interpretation: 'Descriptive results for the selected suite. Repetitions stay grouped by case; they are not additional independent tasks. No confidence interval or population estimate is inferred.' };
}

function summaryText(run, summary) {
  if (run.kind === 'review') return [`${summary.plannedCases} selected cases for human discovery review. Inputs, expected outcomes, and any supplied observed values are shown without executing the application or grader.`, 'Record observations before assigning criterion labels. This page reports no application success rate; absent observed outputs remain unrun.'];
  const qualityCounts = summary.quality;
  return [
    `${kindLabel(run.kind)}. ${summary.plannedCases} selected cases × ${summary.repetitions} planned repetitions = ${summary.plannedAttempts} planned attempts.`,
    `${summary.measurementStatus === 'provisional' ? 'Provisional passes' : 'Passes under recorded checks'}: ${ratio(qualityCounts.pass, summary.plannedAttempts)} planned attempts. Decided quality: ${ratio(qualityCounts.pass, summary.decidedAttempts)}. ${run.kind === 'fresh' ? 'Application completion' : 'Recorded outputs available'}: ${ratio(summary.applicationCompletedAttempts, summary.plannedAttempts)}; grading errors: ${summary.execution.grader_error}.`,
    summary.measurementAuthority,
    `Quality: ${qualityCounts.pass} pass; ${qualityCounts.fail} fail; ${qualityCounts.unscored} unscored; ${qualityCounts.pending} pending. Execution errors and environment gaps do not automatically become quality failures.`,
    `${summary.executionCostBasis} ${dollars(summary.costUsd.sum)} observed, coverage ${summary.costUsd.observed}/${summary.plannedAttempts}. Grading-pass judge cost: ${dollars(summary.judgeCostUsd.sum)} observed, coverage ${summary.judgeCostUsd.observed}/${summary.plannedAttempts}. Missing costs remain unknown.`,
    `Application attempts with a reported model identity: ${summary.actualModels.observed}/${summary.plannedAttempts}; no identity ${summary.actualModels.missing}. This is not complete per-call coverage. Legacy attempt labels: ${summary.actualModels.legacy.observed}/${summary.plannedAttempts}. Judge model receipts: ${summary.judgeModels.observed}/${summary.plannedAttempts}; missing ${summary.judgeModels.missing}.`,
    `Application call receipts: ${summary.actualModels.callCoverage.knownServedModels}/${summary.actualModels.callCoverage.recordedCalls} recorded calls have a known served model; unknown ${summary.actualModels.callCoverage.unknownServedModels}. Complete served identities within adapter-declared complete call lists: ${summary.actualModels.callCoverage.attemptsWithCompleteServedIdentity}/${summary.plannedAttempts} attempts. Missing or partial lists may hide additional calls. Every reported identity is listed below; calls and attempts are counted separately.`,
    `Application cost per passing attempt: ${dollars(summary.costPerPassingAttemptUsd)}. ${summary.costPerPassingAttemptBasis}`,
    `Mean recorded-check pass fraction across cases: ${summary.caseMeanObservedPassFraction === null ? 'Unknown' : `${number(summary.caseMeanObservedPassFraction * 100)}%`}. ${summary.interpretation}`,
  ];
}

function rowData(item, row, repetition, review = false) {
  return { caseId: item.id, repetition, status: review ? (row ? 'observed_ungraded' : 'unrun') : row?.status ?? 'pending', origin: item.origin, sourceRefs: item.sourceRefs ?? [], split: item.split, groupId: item.groupId ?? null, input: item.input, expected: item.expected, output: row && Object.hasOwn(row, 'output') ? row.output : null, outputRecorded: Boolean(row && Object.hasOwn(row, 'output')), verdicts: row?.verdicts ?? {}, trace: row?.trace ?? [], metrics: row?.metrics ?? null, receipt: row?.receipt ?? null, judge: row?.judge ?? null, error: row?.error ?? null };
}

function contentFence(value) {
  if (typeof value !== 'string') return fenced(value);
  const fence = '`'.repeat(Math.max(3, ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return `${fence}text\n${value}\n${fence}`;
}

function interactionHtml(item, row, criteria) {
  const render = (value) => `<pre>${escape(typeof value === 'string' ? value : json(value))}</pre>`;
  const output = row && Object.hasOwn(row, 'output') ? render(row.output) : '<p class="warning">No output was recorded. This is missing evidence, not an empty successful answer.</p>';
  const checks = criteria.map((criterion) => {
    const verdict = row?.verdicts?.[criterion.id];
    return `<tr><td><strong>${escape(criterion.id)}</strong> · ${escape(criterion.grading ?? 'code')}<br><small>${escape(criterion.description)}</small></td><td>${escape(verdict?.status ?? 'unscored')}</td><td>${escape(verdict?.reason ?? (criterion.grading === 'human' ? 'Human review is required. Browser annotations stay separate from automated totals.' : 'No automated verdict recorded.'))}</td></tr>`;
  }).join('');
  const trace = row?.trace?.length ? `<ol class="trace">${row.trace.map((step) => `<li><p><strong>${escape(step.role)}</strong>${step.name ? ` · ${escape(step.name)}` : ''}</p>${render(step.content)}</li>`).join('')}</ol>` : '<p class="muted">No interaction trace was recorded.</p>';
  return `<div class="evidence-grid"><section><h4>Input</h4>${render(item.input)}</section><section><h4>Expected outcome</h4>${render(item.expected)}</section></div><section><h4>Actual output</h4>${output}</section><section><h4>Checks and reasons</h4><table><thead><tr><th>Criterion</th><th>Result</th><th>Reason</th></tr></thead><tbody>${checks}</tbody></table></section><section><h4>Ordered interaction</h4>${trace}</section>${row?.error ? `<section><h4>Recorded error</h4><p class="warning">${escape(row.error.code)}: ${escape(row.error.message)}</p></section>` : ''}<details><summary>Performance, model receipts, and source references</summary><pre>${escape(json({ metrics: row?.metrics ?? null, applicationReceipt: row?.receipt ?? null, judgeReceipt: row?.judge ?? null, sourceRefs: item.sourceRefs ?? [] }))}</pre></details>`;
}

function markdownReport(run, cases, rows, summary) {
  const review = run.kind === 'review';
  const lines = [`# ${markdown(run.manifest.name)} — ${review ? 'discovery review' : 'eval report'}`, '', '## Source workload', '', '| Identity | Value |', '| --- | --- |', ...workloadFields(run.manifest.workload).map(([label, value]) => `| ${label} | ${markdown(value)} |`), '', workloadScope, '', ...summaryText(run, summary).flatMap((line) => [line, '']), '## Frozen scope', '', fenced({ runId: run.id, kind: run.kind, sourceRun: run.sourceRun, startedAt: run.startedAt, completedAt: run.completedAt, fingerprint: run.fingerprint, manifest: run.manifest }), ''];
  if (!review) lines.push('## Execution accounting', '', '| Status | Attempts |', '| --- | ---: |', ...Object.entries(summary.execution).map(([status, count]) => `| ${status} | ${count} |`), '', '## Actual model identities', '', fenced({ application: summary.actualModels, judge: summary.judgeModels }), '', '## Observed latency (milliseconds)', '', ...(run.kind === 'regrade' ? ['These timings and application costs belong to the recorded source execution, not this regrading pass.', ''] : []), fenced({ totalTask: summary.latencyMs, modelCalls: summary.modelLatencyMs }), '', 'These distributions use only recorded nonnegative finite values. Missing latency is unknown.', '', '## Case overview', '', '| Case | Origin / split | Pass | Fail | Unscored | Pending |', '| --- | --- | ---: | ---: | ---: | ---: |', ...cases.map((item, index) => { const count = summary.perCase[index].counts; return `| ${markdown(item.title ?? item.id)} | ${markdown(item.origin)} / ${markdown(item.split)} | ${count.pass} | ${count.fail} | ${count.unscored} | ${count.pending} |`; }), '');
  lines.push('## Complete recorded evidence', '');
  for (const item of cases) {
    lines.push(`### ${markdown(item.title ?? item.id)}`, '', item.split === 'test' ? 'Held-out test evidence: using these outcomes to revise the application or evaluator consumes their independent test status.' : 'Selected regression/development evidence.', '');
    for (let repetition = 1; repetition <= run.repetitions; repetition++) {
      const row = rows.find((candidate) => candidate.caseId === item.id && candidate.repetition === repetition);
      lines.push(review ? (row ? 'Supplied observed value, ungraded.' : 'Unrun; no observed output supplied.') : `Attempt ${repetition}: ${quality(row, run.manifest.criteria.filter((criterion) => criterion.required !== false))}; execution ${row?.status ?? 'pending'}.`, '', '#### Input', '', contentFence(item.input), '', '#### Expected outcome', '', contentFence(item.expected), '', '#### Actual output', '', row && Object.hasOwn(row, 'output') ? contentFence(row.output) : 'No output was recorded. Missing evidence is not an empty successful answer.', '', '#### Checks and reasons', '', '| Criterion | Result | Reason |', '| --- | --- | --- |');
      for (const criterion of run.manifest.criteria) { const verdict = row?.verdicts?.[criterion.id]; lines.push(`| ${markdown(criterion.id)} | ${markdown(verdict?.status ?? 'unscored')} | ${markdown(verdict?.reason ?? (criterion.grading === 'human' ? 'Human review is required. Browser annotations stay separate from automated totals.' : 'No automated verdict recorded.'))} |`); }
      lines.push('', '#### Ordered interaction', '');
      if (!row?.trace?.length) lines.push('No interaction trace was recorded.', '');
      for (const [index, step] of (row?.trace ?? []).entries()) lines.push(`${index + 1}. **${markdown(step.role)}**${step.name ? ` · ${markdown(step.name)}` : ''}`, '', contentFence(step.content), '');
      if (row?.error) lines.push('#### Recorded error', '', contentFence(row.error), '');
      lines.push('<details><summary>Full raw evidence, performance, and provenance</summary>', '', fenced(rowData(item, row, repetition, review)), '', '</details>', '');
    }
  }
  lines.push('## Human discovery review', '', 'The HTML report provides discovery notes and per-criterion Pass/Fail/Defer labels. Notes begin in memory; Save in this browser explicitly persists annotations under the frozen review scope. Each annotation also identifies the exact attempt evidence it reviewed. Finishing unrelated attempts preserves existing notes. Browser restore skips changed evidence and reports the skipped count without altering the saved copy; JSONL import rejects the entire import if any row is stale. Forget saved copy removes that browser copy. Version 2 exports include evidence identities and reviewer attribution; older rows without evidence identities cannot be trusted automatically. Browser storage and downloads may be outside the application private directory; manage them according to the evidence retention policy. Human labels remain separate from automated verdicts.', '');
  return lines.join('\n');
}

const style = `
:root{color-scheme:light;--ink:#182b36;--muted:#586873;--line:#dce5e7;--accent:#086d75;--surface:#f3f7f7}*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--ink);font:15px/1.55 system-ui,sans-serif}main{max-width:1160px;margin:auto;padding:36px 24px 70px}h1{font-size:32px;line-height:1.2;letter-spacing:-.025em;margin:8px 0}h2{font-size:20px;margin:0 0 14px}h3{font-size:17px;margin:0}h4{font-size:14px;margin:18px 0 5px}.evidence-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.trace{padding-left:24px}.interaction{margin:10px 0}.interaction>section{margin-top:12px}p{margin:8px 0}small,.muted{color:var(--muted)}.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);font-weight:750}.panel,.case{background:white;border:1px solid var(--line);border-radius:12px;padding:22px;margin-top:20px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:24px}.metric{background:white;border:1px solid var(--line);border-radius:12px;padding:18px}.metric strong{display:block;font-size:29px;line-height:1.25;margin:8px 0}.metric span{font-size:13px;color:var(--muted)}.toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:end}.toolbar label{display:grid;gap:5px;flex:1;min-width:150px}input,select,textarea,button{font:inherit;border:1px solid #a5b8bd;border-radius:6px;padding:8px 10px;background:white;color:var(--ink)}button{cursor:pointer;font-weight:600}button.primary{background:var(--accent);border-color:var(--accent);color:white}textarea{width:100%;min-height:85px}.case-head{display:flex;justify-content:space-between;gap:18px}.badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:12px;font-weight:700;background:#eef2f4;color:#425662}.pass{background:#e3f4e8;color:#236638}.fail{background:#ffebe7;color:#9c3526}.unscored,.pending{background:#fff3d9;color:#79520f}.tags{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.tag{font-size:12px;border:1px solid var(--line);padding:1px 7px;border-radius:5px}.attempt{border-top:1px solid var(--line);padding-top:14px;margin-top:14px}summary{cursor:pointer;font-weight:650}pre{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;background:#f6f8fa;border:1px solid var(--line);border-radius:6px;padding:14px;font:12px/1.6 ui-monospace,monospace;max-height:520px;overflow:auto}details>pre{margin-bottom:0}table{width:100%;border-collapse:collapse;text-align:left;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:8px 10px}th{color:var(--muted);font-weight:600}fieldset{border:1px solid var(--line);border-radius:7px;margin:14px 0 0;padding:12px}legend{font-size:13px;font-weight:650}.review-grid{display:grid;grid-template-columns:180px 1fr;gap:12px}.review-grid label{display:grid;gap:5px}.warning{border-left:3px solid #b88621;padding-left:12px;color:#735314}.hidden{display:none!important}footer{margin-top:28px;font-size:13px;color:var(--muted)}@media(max-width:700px){main{padding:20px 14px}.metrics{grid-template-columns:repeat(2,1fr)}.review-grid,.evidence-grid{grid-template-columns:1fr}.case-head{display:block}}@media print{body{background:white;font-size:11px}main{max-width:none;padding:0}.toolbar,.review-tools,fieldset,button{display:none!important}.panel,.case,.metric{break-inside:avoid;border-radius:0;box-shadow:none}.metrics{grid-template-columns:repeat(4,1fr)}pre{max-height:none;font-size:9px}details{display:block}.hidden{display:block!important}h1{font-size:24px}}`;

const script = `
const cards=[...document.querySelectorAll('.case')];
const fields=[...document.querySelectorAll('[data-review-key]')];
const scope=document.body.dataset.scope;
const storageKey='private-eval-review-v2:'+scope;
const index=new Map(fields.map(field=>[field.dataset.reviewKey,field]));
const message=text=>{document.querySelector('#review-status').textContent=text};
function filter(){
  const query=document.querySelector('#search').value.toLowerCase();
  const status=document.querySelector('#status').value;
  const tag=document.querySelector('#tag').value;
  let visible=0;
  for(const card of cards){
    const show=(!status||card.dataset.status===status)&&(!tag||JSON.parse(card.dataset.tags).includes(tag))&&card.textContent.toLowerCase().includes(query);
    card.classList.toggle('hidden',!show);if(show)visible++;
  }
  document.querySelector('#visible').textContent=visible+' of '+cards.length+' cases shown';
}
for(const id of ['search','status','tag'])document.getElementById(id).addEventListener('input',filter);
function collect(){
  const reviewer=document.querySelector('#reviewer').value;
  return fields.filter(field=>field.querySelector('select')?.value||field.querySelector('textarea').value).map(field=>{
    const [caseId,repetition,criterionId]=JSON.parse(field.dataset.reviewKey);
    return {schemaVersion:2,scope,evidenceId:field.dataset.evidenceId,caseId,repetition,criterionId,label:criterionId===null?null:field.querySelector('select').value||'Defer',note:field.querySelector('textarea').value,reviewer:field.dataset.reviewer||reviewer,reviewedAt:field.dataset.reviewedAt||new Date().toISOString()};
  });
}
function restore(imported,skipStale=false){
  if(!Array.isArray(imported))throw Error('Expected an array of review records.');
  const seen=new Set;const accepted=[];let stale=0;
  for(const row of imported){
    const key=JSON.stringify([row.caseId,row.repetition,row.criterionId]);
    const validLabel=row.criterionId===null?row.label===null:['Pass','Fail','Defer'].includes(row.label);
    if(row.schemaVersion!==2||row.scope!==scope||!index.has(key)||seen.has(key)||!validLabel||typeof row.evidenceId!=='string'||!/^[a-f0-9]{64}$/.test(row.evidenceId)||typeof row.note!=='string'||typeof row.reviewer!=='string'||typeof row.reviewedAt!=='string')throw Error('Invalid, duplicate, differently scoped, or unversioned-evidence review row.');
    seen.add(key);
    if(row.evidenceId!==index.get(key).dataset.evidenceId){
      if(!skipStale)throw Error('Review evidence changed for '+row.caseId+', attempt '+row.repetition+'. No imported notes were applied.');
      stale++;continue;
    }
    accepted.push(row);
  }
  for(const row of accepted){
    const field=index.get(JSON.stringify([row.caseId,row.repetition,row.criterionId]));
    if(field.querySelector('select'))field.querySelector('select').value=row.label;
    field.querySelector('textarea').value=row.note;
    field.dataset.reviewer=row.reviewer;field.dataset.reviewedAt=row.reviewedAt;
  }
  return {restored:accepted.length,stale};
}
for(const field of fields)field.addEventListener('input',()=>{field.dataset.reviewer=document.querySelector('#reviewer').value;field.dataset.reviewedAt=new Date().toISOString()});
document.querySelector('#export').addEventListener('click',()=>{
  const rows=collect();const lines=rows.map(row=>JSON.stringify(row));
  const url=URL.createObjectURL(new Blob([lines.join('\\n')+(lines.length?'\\n':'')],{type:'application/x-ndjson'}));
  const link=document.createElement('a');link.href=url;link.download='human-labels.jsonl';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);message('Exported '+rows.length+' review rows. Your browser chooses the download location; keep private evidence private.');
});
document.querySelector('#import').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  try{if(file.size>5000000)throw Error('Review file is larger than 5 MB.');const imported=(await file.text()).split(/\\r?\\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));restore(imported);message('Imported '+imported.length+' rows with reviewer attribution. Save explicitly to persist them.');}
  catch(error){message('Import failed: '+error.message)}event.target.value='';
});
document.querySelector('#save').addEventListener('click',()=>{try{const rows=collect();localStorage.setItem(storageKey,JSON.stringify(rows));message('Saved '+rows.length+' current-evidence annotation rows in this browser. Use Forget saved copy to remove them.');}catch(error){message('Browser save unavailable: '+error.message)}});
document.querySelector('#forget').addEventListener('click',()=>{try{localStorage.removeItem(storageKey);message('Stored browser copy removed. Current tab notes remain until you clear or close this page.');}catch(error){message('Could not remove browser copy: '+error.message)}});
try{const saved=localStorage.getItem(storageKey);if(saved){const result=restore(JSON.parse(saved),true);message('Restored '+result.restored+' previously saved annotation rows.'+(result.stale?' Skipped '+result.stale+' stale reviews because their evidence changed; the saved copy is unchanged. Saving will replace it with current notes.':''));}}catch(error){message('Saved notes could not be loaded: '+error.message)}
const openForPrint=()=>{for(const details of document.querySelectorAll('details'))details.open=true};
window.addEventListener('beforeprint',openForPrint);
document.querySelector('#print').addEventListener('click',()=>{openForPrint();window.print()});
filter();`;

function reviewFields(item, repetition, criteria, row, review) {
  const key = (criterionId) => escape(JSON.stringify([item.id, repetition, criterionId]));
  const evidence = rowData(item, row, repetition, review);
  const evidenceId = (criterion) => digest({ evidence, criterion });
  const discovery = `<fieldset data-review-key="${key(null)}" data-evidence-id="${evidenceId(criteria)}"><legend>Discovery observations</legend><label>What is wrong, missing, or acceptable?<textarea aria-label="Discovery observations" placeholder="Start with evidence and observations, before choosing a failure category."></textarea></label></fieldset>`;
  const criteriaFields = criteria.map((criterion) => `<fieldset data-review-key="${key(criterion.id)}" data-evidence-id="${evidenceId(criterion)}"><legend>${escape(criterion.id)} · ${criterion.required === false ? 'optional' : 'required'} · ${escape(criterion.grading ?? 'code')}</legend><p>${escape(criterion.description)}</p><div class="review-grid"><label>Human label<select aria-label="Human criterion label"><option value="">Not reviewed</option><option>Pass</option><option>Fail</option><option>Defer</option></select></label><label>Evidence and reason<textarea aria-label="Criterion review reason"></textarea></label></div></fieldset>`).join('');
  return `<details class="human-review"><summary>Discovery notes and per-criterion human labels</summary>${discovery}${criteriaFields}</details>`;
}

function htmlReport(run, cases, rows, summary) {
  const review = run.kind === 'review';
  const required = run.manifest.criteria.filter((criterion) => criterion.required !== false);
  // Appending completed attempts must not move the browser-storage namespace.
  // Each editor separately binds its annotation to the evidence of that attempt.
  const scope = digest({ schemaVersion: 2, id: run.id, kind: run.kind, fingerprint: run.fingerprint, startedAt: run.startedAt ?? null, sourceRun: run.sourceRun ?? null, sourceEvidenceDigest: run.sourceEvidenceDigest ?? null, manifest: run.manifest, repetitions: run.repetitions, plannedCases: run.plannedCases, plannedAttempts: run.plannedAttempts, cases: cases.map(({ observed, ...plan }) => plan) });
  const tags = [...new Set(cases.flatMap((item) => item.tags ?? []))].sort();
  const body = cases.map((item, index) => {
    const result = summary.perCase[index];
    const attempts = Array.from({ length: run.repetitions }, (_, offset) => {
      const repetition = offset + 1;
      const row = rows.find((candidate) => candidate.caseId === item.id && candidate.repetition === repetition);
      const outcome = quality(row, required);
      const heading = review ? (row ? 'Supplied observed value · ungraded' : 'Unrun · no observed output') : `Attempt ${repetition} · quality ${outcome} · execution ${row?.status ?? 'pending'}`;
      return `<div class="attempt"><p><strong>${escape(heading)}</strong></p><details class="interaction"><summary>Read the complete interaction and reasons</summary>${interactionHtml(item, row, run.manifest.criteria)}<details><summary>Full raw recorded evidence</summary><pre>${escape(json(rowData(item, row, repetition, review)))}</pre></details></details>${reviewFields(item, repetition, run.manifest.criteria, row, review)}</div>`;
    }).join('');
    return `<article class="case" data-status="${result.outcome}" data-tags="${escape(JSON.stringify(item.tags ?? []))}"><div class="case-head"><div><h3>${escape(item.title ?? item.id)}</h3><small>${escape(item.id)} · ${escape(item.origin)} · ${escape(item.split)}${item.groupId ? ` · group ${escape(item.groupId)}` : ''}</small></div><span class="badge ${result.outcome}">${review ? 'unreviewed' : result.outcome}</span></div><div class="tags">${(item.tags ?? []).map((tag) => `<span class="tag">${escape(tag)}</span>`).join('')}</div>${review ? '' : `<p class="muted">${result.counts.pass} pass · ${result.counts.fail} fail · ${result.counts.unscored} unscored · ${result.counts.pending} pending, across ${result.planned} planned attempts.</p>`}${item.split === 'test' ? '<p class="warning">Held-out test evidence. Using these outcomes to revise the application or evaluator consumes its independent test status. Details start closed.</p>' : ''}${attempts}</article>`;
  }).join('');
  const metric = (label, value, hint) => `<div class="metric"><span>${escape(label)}</span><strong>${escape(value)}</strong><span>${escape(hint)}</span></div>`;
  const metrics = review ? '' : `<div class="metrics">${metric(summary.measurementStatus === 'provisional' ? 'Provisional passes' : 'Passes under recorded checks', `${summary.quality.pass}/${summary.plannedAttempts}`, 'Recorded passes / all planned attempts')}${metric('Decided quality', `${summary.quality.pass}/${summary.decidedAttempts}`, 'Passes / passes + failures')}${metric(run.kind === 'fresh' ? 'Application completed' : 'Recorded outputs available', `${summary.applicationCompletedAttempts}/${summary.plannedAttempts}`, 'Output returned; grading can still fail')}${metric('Selected cases', String(summary.plannedCases), `${summary.repetitions} planned repetitions per case`)}</div>`;
  const performance = review ? '' : `<section class="panel"><h2>${run.kind === 'regrade' ? 'Recorded source execution and performance' : 'Execution and observed performance'}</h2><table><thead><tr><th>Pipeline status</th><th>Attempts</th></tr></thead><tbody>${Object.entries(summary.execution).map(([key, value]) => `<tr><td>${escape(key)}</td><td>${value}</td></tr>`).join('')}</tbody></table><h3>Actual model identities</h3><pre>${escape(json({ application: summary.actualModels, judge: summary.judgeModels }))}</pre><p>Task latency: median ${number(summary.latencyMs.median)} ms · p90 ${number(summary.latencyMs.p90)} ms · ${summary.latencyMs.observed}/${summary.plannedAttempts} observed.</p><details><summary>Observed task and model-call latency distributions</summary><pre>${escape(json({ taskLatencyMs: summary.latencyMs, modelLatencyMs: summary.modelLatencyMs }))}</pre></details><p class="muted">Only recorded values enter these distributions. Missing timings remain unknown.</p></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(run.manifest.name)} — ${review ? 'discovery review' : 'eval report'}</title><style>${style}</style></head><body data-scope="${scope}"><main>
<header><div class="eyebrow">Private ${review ? 'discovery review' : 'eval report'} · ${escape(run.manifest.mode)}</div><h1>${escape(run.manifest.name)}</h1><p>${escape(kindLabel(run.kind))} · ${escape(run.id)}</p><p class="muted">${escape(run.manifest.description ?? '')}</p><section class="panel"><h2>Source workload</h2><table><tbody>${workloadFields(run.manifest.workload).map(([label, value]) => `<tr><th scope="row">${label}</th><td>${escape(value)}</td></tr>`).join('')}</tbody></table><p class="muted">${workloadScope}</p></section></header>
${metrics}<section class="panel"><h2>${review ? 'Review before running' : 'What these numbers mean'}</h2>${summaryText(run, summary).map((line) => `<p>${escape(line)}</p>`).join('')}<p class="warning">${escape(run.manifest.rubricStatus ? `Rubric status: ${run.manifest.rubricStatus}.` : 'Rubric validation status is unknown.')} Selection and rubric quality limit what this establishes.</p><details><summary>Frozen purpose, selection, requirements, settings, and provenance</summary><pre>${escape(json({ runId: run.id, sourceRun: run.sourceRun, startedAt: run.startedAt, completedAt: run.completedAt, fingerprint: run.fingerprint, manifest: run.manifest }))}</pre></details></section>
${performance}<section class="panel review-tools"><h2>Review the evidence</h2><p>Read complete interactions, record discovery observations, then label each criterion Pass/Fail/Defer. Human labels remain separate from automated metrics. Notes begin in memory; Save in this browser explicitly persists them under the frozen review scope and their attempt evidence. Finishing unrelated attempts preserves notes. Browser restore skips stale evidence; importing any stale row rejects the whole import. Browser storage and downloads may be outside your private app directory. Respect the evidence retention policy.</p><div class="toolbar"><label>Reviewer<input id="reviewer" placeholder="Your name or review role"></label><button id="export" class="primary">Export labels</button><label>Import matching labels<input id="import" type="file" accept=".jsonl,.ndjson"></label><button id="save">Save in this browser</button><button id="forget">Forget saved copy</button><button id="print">Print full report</button></div><p id="review-status" role="status" class="muted">Notes stay in this tab until you explicitly save or export them.</p></section>
<section class="panel"><h2>All selected cases</h2><div class="toolbar"><label>Search evidence<input id="search" type="search" placeholder="Input, output, reason, or case"></label><label>Quality status<select id="status"><option value="">All statuses</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="unscored">Unscored / observed</option><option value="pending">Pending / unrun</option></select></label><label>Tag<select id="tag"><option value="">All tags</option>${tags.map((tag) => `<option value="${escape(tag)}">${escape(tag)}</option>`).join('')}</select></label></div><p id="visible" class="muted">${cases.length} cases</p></section>${body}<footer>Generated only from supplied or recorded evidence. No model or scorer was executed to build this page. Source references are displayed as data, never followed as paths or links. The printable Markdown contains the same full evidence.</footer></main><script>${script}</script></body></html>`;
}

/** Write a self-contained report; never run inference, tools, or graders. */
export async function buildReport(evalRoot, runId) {
  validateRunId(runId);
  const evalDir = await resolveEval(evalRoot);
  const { directory, run, rows, cases } = await loadRun(evalDir, runId);
  const summary = summarizeRun(run, cases, rows);
  const paths = { html: join(directory, 'report.html'), markdown: join(directory, 'report.md'), summary: join(directory, 'summary.json') };
  await writePrivate(paths.html, htmlReport(run, cases, rows, summary));
  await writePrivate(paths.markdown, markdownReport(run, cases, rows, summary));
  await atomicJson(paths.summary, summary);
  return paths;
}

/** Human discovery review of inputs and optional observed values before any run. */
export async function buildReview(evalRoot) {
  const evalDir = await resolveEval(evalRoot);
  const { manifest, cases, fingerprint } = await loadEval(evalDir);
  const run = { id: 'input-review', kind: 'review', manifest, fingerprint, repetitions: 1, plannedCases: cases.length, plannedAttempts: cases.length };
  const rows = cases.filter((item) => Object.hasOwn(item, 'observed')).map((item) => ({ caseId: item.id, repetition: 1, ...item.observed, status: 'ok' }));
  const summary = summarizeRun(run, cases, rows);
  const paths = { html: join(evalDir, 'review.html'), markdown: join(evalDir, 'review.md') };
  await writePrivate(paths.html, htmlReport(run, cases, rows, summary));
  await writePrivate(paths.markdown, markdownReport(run, cases, rows, summary));
  return paths;
}
