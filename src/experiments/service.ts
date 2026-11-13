import { resolveManagementScope, type ManagementScopeOptions } from "../context/service.js";
import { CliError } from "../errors.js";
import {
  assertUniqueIds,
  customerPath,
  experimentListSchema,
  experimentSchema,
  experimentStatusSchema,
  instant,
  maxRangeDays,
  minimumRatedTraces,
  oauthOnlyMessage,
  resourceId,
  type Experiment,
  type Interval,
  type SummaryStats,
} from "../evaluators/contracts.js";
import { listVisibleEvaluators, readEvaluatorSummary } from "../evaluators/service.js";
import { requestManagementJson } from "../management/client.js";
import type { ManagementSession } from "../management/session.js";

/** The customer API returns at most this many experiments, newest first. */
export const experimentListLimit = 200;
const dayMs = 86_400_000;

export interface ExperimentListInput { project?: string; workload?: string; status?: string }
export interface ExperimentResultsInput { experiment: string; from?: string; to?: string }

export interface ExperimentListResult {
  experiments: Experiment[];
  /** True when the platform returned its maximum page, so older experiments may be missing. */
  possiblyTruncated: boolean;
}

export interface ExperimentArm {
  variant: "control" | "candidate";
  /** The configured arm model. Sessions are grouped by assignment, not by the model that served them. */
  assigned_model: string;
  traces_judged: number;
  rated_traces: number;
  passed_traces: number;
  trace_pass_rate: Interval | null;
  priced_traces: number;
  unpriced_traces: number;
  cost_per_trace_usd: number | null;
  skips: Record<string, number>;
}

export interface ExperimentResults {
  experiment: Experiment;
  evaluator: {
    id: string;
    name: string;
    status: string;
    version: number;
    versionId: string;
  } | null;
  range: { from: string; to: string; clampedToMaxRange: boolean } | null;
  control: ExperimentArm | null;
  candidate: ExperimentArm | null;
  /** Candidate trace pass rate minus control, with its 95% interval; null below the minimum sample. */
  candidateMinusControl: Interval | null;
  minimumRatedTraces: number;
  notes: string[];
}

export interface ExperimentsService {
  list(input?: ExperimentListInput): Promise<ExperimentListResult>;
  show(input: { experiment: string }): Promise<Experiment>;
  results(input: ExperimentResultsInput): Promise<ExperimentResults>;
}

export function createExperimentsService(options: ManagementScopeOptions, now: () => number = Date.now): ExperimentsService {
  return {
    async list(input = {}) {
      const status = input.status === undefined ? undefined : experimentStatusSchema.safeParse(input.status);
      if (status && !status.success) throw new CliError("Status must be draft, active, or stopped.");
      const scope = await resolveManagementScope(options, {
        project: input.project,
        workload: input.workload,
        ignoreDefaults: true,
      });
      requireOAuth(scope.session);
      const result = await requestManagementJson(scope.session, {
        path: customerPath(scope.session.organizationId, "experiments"),
        action: "Experiment listing",
      }, experimentListSchema);
      assertUniqueIds(result.experiments, "experiment");
      return {
        experiments: result.experiments.filter((row) =>
          (!scope.project || row.project_id === scope.project.id) &&
          (!scope.workload || row.workload_id === scope.workload.id) &&
          (!status || row.status === status.data)),
        possiblyTruncated: result.experiments.length >= experimentListLimit,
      };
    },

    async show(input) {
      const scope = await resolveManagementScope(options, { useDefaults: false });
      return readExperiment(scope.session, resourceId(input.experiment, "experiment"));
    },

    async results(input) {
      const from = input.from === undefined ? undefined : Date.parse(instant(input.from, "--from"));
      const to = input.to === undefined ? undefined : Date.parse(instant(input.to, "--to"));
      const scope = await resolveManagementScope(options, { useDefaults: false });
      const experiment = await readExperiment(scope.session, resourceId(input.experiment, "experiment"));
      const base = {
        experiment,
        control: null,
        candidate: null,
        candidateMinusControl: null,
        minimumRatedTraces,
      };
      if (experiment.status === "draft") {
        return { ...base, evaluator: null, range: null, notes: ["The experiment is a draft and has served no traffic."] };
      }
      const evaluators = (await listVisibleEvaluators(scope.session)).filter((row) =>
        row.project_id === experiment.project_id && row.workload_id === experiment.workload_id);
      if (evaluators.length === 0) {
        return {
          ...base,
          evaluator: null,
          range: null,
          notes: ["No evaluator is visible for this workload, so the experiment's quality cannot be measured."],
        };
      }
      const evaluator = evaluators[0]!;

      // Default to the experiment's whole life, bounded by the API's widest range.
      const end = to ?? now();
      const earliest = end - maxRangeDays * dayMs;
      const start = from ?? Math.max(experiment.created_at_ms, earliest);
      if (start >= end) throw new CliError("--from must be before --to.");
      if (end - start > maxRangeDays * dayMs) throw new CliError(`The range can span at most ${maxRangeDays} days.`);
      const range = {
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
        clampedToMaxRange: from === undefined && experiment.created_at_ms < earliest,
      };

      const summary = await readEvaluatorSummary(scope.session, evaluator.id, range);
      const arm = (variant: "control" | "candidate"): ExperimentArm | null => {
        const groups = summary.by_variant.filter((group) => group.experiment_id === experiment.id && group.variant === variant);
        if (groups.length > 1) throw new CliError("Understudy returned a repeated experiment arm.");
        return groups[0] ? armStats(variant, variant === "control" ? experiment.control_model : experiment.candidate_model, groups[0]) : null;
      };
      const differences = summary.variant_differences.filter((item) => item.experiment_id === experiment.id);
      if (differences.length > 1) throw new CliError("Understudy returned a repeated experiment difference.");
      const control = arm("control");
      const candidate = arm("candidate");

      const notes = [
        `Results use evaluator version ${summary.version} only; activating another version restarts the comparison.`,
        "Arms group traces by session assignment; a fallback response still counts in its assigned arm.",
      ];
      if (evaluator.status === "paused") notes.push("The evaluator is paused, so new traces are not being judged.");
      if (!control || !candidate) notes.push("At least one arm has no judged traces in this range.");
      else if (control.rated_traces < minimumRatedTraces || candidate.rated_traces < minimumRatedTraces) {
        notes.push(`Each arm needs ${minimumRatedTraces} rated traces before rates and the difference are reported.`);
      }
      if (range.clampedToMaxRange) notes.push(`The experiment is older than ${maxRangeDays} days; only the latest ${maxRangeDays} days are included.`);

      return {
        ...base,
        evaluator: {
          id: evaluator.id,
          name: evaluator.name,
          status: evaluator.status,
          version: summary.version,
          versionId: summary.evaluator_version_id,
        },
        range,
        control,
        candidate,
        candidateMinusControl: differences[0]?.candidate_minus_control ?? null,
        notes,
      };
    },
  };
}

async function readExperiment(session: ManagementSession, experimentId: string): Promise<Experiment> {
  requireOAuth(session);
  const experiment = await requestManagementJson(session, {
    path: customerPath(session.organizationId, "experiments", experimentId),
    action: "Experiment read",
    responseFailureMessages: { 404: "Experiment not found among the experiments visible to this organization." },
  }, experimentSchema);
  if (experiment.id !== experimentId) throw new CliError("Understudy returned another experiment.");
  return experiment;
}

function armStats(variant: "control" | "candidate", assignedModel: string, stats: SummaryStats): ExperimentArm {
  return {
    variant,
    assigned_model: assignedModel,
    traces_judged: stats.traces_judged,
    rated_traces: stats.rated_traces,
    passed_traces: stats.passed_traces,
    trace_pass_rate: stats.trace_pass_rate,
    priced_traces: stats.priced_traces,
    unpriced_traces: stats.unpriced_traces,
    cost_per_trace_usd: stats.cost_per_trace_usd,
    skips: stats.skips,
  };
}

function requireOAuth(session: ManagementSession): void {
  if (session.credentialClass !== "oauth") throw new CliError(oauthOnlyMessage);
}
