import { z } from "zod";

import { resolveManagementScope, type ManagementScopeOptions } from "../context/service.js";
import { CliError } from "../errors.js";
import { requestManagementJson } from "../management/client.js";
import type { ManagementSession } from "../management/session.js";
import { textFilter } from "../requests/filters.js";
import {
  assertUniqueIds,
  customerPath,
  evaluatorDetailSchema,
  evaluatorListSchema,
  oauthOnlyMessage,
  rangeQuery,
  resourceId,
  scoreListSchema,
  scoreRange,
  summarySchema,
  type Evaluator,
  type EvaluatorListRow,
  type Range,
  type Summary,
} from "./contracts.js";

export interface EvaluatorListInput { project?: string; workload?: string }
export interface EvaluatorShowInput { evaluator?: string; project?: string; workload?: string }
export interface EvaluatorSummaryInput extends Range { evaluator: string }
export interface EvaluatorScoresInput extends Range {
  evaluator: string;
  verdict?: string;
  model?: string;
  rubric?: string;
  limit?: string | number;
  cursor?: string;
  includeReasons?: boolean;
}

export interface EvaluatorListResult { evaluators: EvaluatorListRow[] }
export interface EvaluatorShowResult {
  evaluator: Evaluator;
  experiments: z.infer<typeof evaluatorDetailSchema>["experiments"];
}
export interface EvaluatorScore {
  request_id: string;
  trace_ended_at: string;
  model: string;
  rubric: string;
  verdict: "pass" | "fail" | "na";
  reason?: string | null;
}
export interface EvaluatorScoresResult {
  evaluatorId: string;
  evaluatorVersionId: string;
  reasonsIncluded: boolean;
  scores: EvaluatorScore[];
  nextCursor: string | null;
}

export interface EvaluatorsService {
  list(input?: EvaluatorListInput): Promise<EvaluatorListResult>;
  show(input: EvaluatorShowInput): Promise<EvaluatorShowResult>;
  summary(input: EvaluatorSummaryInput): Promise<Summary>;
  scores(input: EvaluatorScoresInput): Promise<EvaluatorScoresResult>;
}

/** Read every evaluator visible to the signed-in member, with its 30-day stats. */
export async function listVisibleEvaluators(session: ManagementSession): Promise<EvaluatorListRow[]> {
  requireOAuth(session);
  const result = await requestManagementJson(session, {
    path: customerPath(session.organizationId, "evaluators"),
    action: "Evaluator listing",
    timeoutMs: 30_000,
  }, evaluatorListSchema);
  assertUniqueIds(result.evaluators, "evaluator");
  if (new Set(result.evaluators.map((row) => row.workload_id)).size !== result.evaluators.length) {
    throw new CliError("Understudy returned more than one evaluator for a workload.");
  }
  return result.evaluators;
}

export async function readEvaluatorSummary(session: ManagementSession, evaluatorId: string, range: Range): Promise<Summary> {
  requireOAuth(session);
  const summary = await requestManagementJson(session, {
    path: `${customerPath(session.organizationId, "evaluators", evaluatorId, "summary")}${rangeQuery(range)}`,
    action: "Evaluator summary",
    timeoutMs: 30_000,
    responseFailureMessages: { 404: "Evaluator not found among the evaluators visible to this organization." },
  }, summarySchema);
  if (summary.evaluator_id !== evaluatorId) {
    throw new CliError("Understudy returned a summary for another evaluator.");
  }
  return summary;
}

export function createEvaluatorsService(options: ManagementScopeOptions): EvaluatorsService {
  return {
    async list(input = {}) {
      const scope = await resolveManagementScope(options, {
        project: input.project,
        workload: input.workload,
        ignoreDefaults: true,
      });
      const rows = await listVisibleEvaluators(scope.session);
      return {
        evaluators: rows.filter((row) =>
          (!scope.project || row.project_id === scope.project.id) &&
          (!scope.workload || row.workload_id === scope.workload.id)),
      };
    },

    async show(input) {
      if (input.evaluator !== undefined) {
        if (input.project !== undefined || input.workload !== undefined) {
          throw new CliError("Select an evaluator by id or by --project and --workload, not both.");
        }
        const scope = await resolveManagementScope(options, { useDefaults: false });
        return readDetail(scope.session, resourceId(input.evaluator, "evaluator"));
      }
      const scope = await resolveManagementScope(options, {
        project: input.project,
        workload: input.workload,
        requireWorkload: true,
        ignoreDefaults: input.project !== undefined,
      });
      const rows = (await listVisibleEvaluators(scope.session))
        .filter((row) => row.project_id === scope.project!.id && row.workload_id === scope.workload!.id);
      if (rows.length === 0) {
        throw new CliError(`No evaluator is visible for ${scope.project!.slug}/${scope.workload!.name}.`);
      }
      return readDetail(scope.session, rows[0]!.id);
    },

    async summary(input) {
      const range = scoreRange(input);
      const scope = await resolveManagementScope(options, { useDefaults: false });
      return readEvaluatorSummary(scope.session, resourceId(input.evaluator, "evaluator"), range);
    },

    async scores(input) {
      const evaluatorId = resourceId(input.evaluator, "evaluator");
      const query = new URLSearchParams();
      const range = scoreRange(input);
      if (range.from) query.set("from", range.from);
      if (range.to) query.set("to", range.to);
      if (input.verdict !== undefined) {
        if (!["pass", "fail", "na"].includes(input.verdict)) throw new CliError("Verdict must be pass, fail, or na.");
        query.set("verdict", input.verdict);
      }
      if (input.model !== undefined) query.set("model", textFilter(input.model, "model", 256));
      if (input.rubric !== undefined) {
        if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(input.rubric) || input.rubric.length > 40) {
          throw new CliError("Rubric must be a snake_case rubric name of at most 40 characters.");
        }
        query.set("rubric", input.rubric);
      }
      if (input.limit !== undefined) query.set("limit", String(scoreLimit(input.limit)));
      if (input.cursor !== undefined) query.set("cursor", textFilter(input.cursor, "cursor", 512));

      const scope = await resolveManagementScope(options, { useDefaults: false });
      requireOAuth(scope.session);
      const text = query.toString();
      const result = await requestManagementJson(scope.session, {
        path: `${customerPath(scope.session.organizationId, "evaluators", evaluatorId, "scores")}${text ? `?${text}` : ""}`,
        action: "Evaluator scores",
        timeoutMs: 30_000,
        responseFailureMessages: {
          403: "Evaluator scores are available only to organization admins signed in with browser OAuth.",
          404: "Evaluator not found among the evaluators visible to this organization.",
        },
      }, scoreListSchema);
      const includeReasons = input.includeReasons === true;
      return {
        evaluatorId,
        evaluatorVersionId: result.evaluator_version_id,
        reasonsIncluded: includeReasons,
        // Judge reasons can quote the organization's traces, so they are
        // returned only on explicit request.
        scores: result.scores.map(({ reason, ...score }) => includeReasons ? { ...score, reason } : score),
        nextCursor: result.next_cursor,
      };
    },
  };
}

async function readDetail(session: ManagementSession, evaluatorId: string): Promise<EvaluatorShowResult> {
  requireOAuth(session);
  const detail = await requestManagementJson(session, {
    path: customerPath(session.organizationId, "evaluators", evaluatorId),
    action: "Evaluator read",
    responseFailureMessages: { 404: "Evaluator not found among the evaluators visible to this organization." },
  }, evaluatorDetailSchema);
  if (detail.evaluator.id !== evaluatorId) throw new CliError("Understudy returned another evaluator.");
  assertUniqueIds(detail.experiments, "experiment");
  return detail;
}

function requireOAuth(session: ManagementSession): void {
  if (session.credentialClass !== "oauth") throw new CliError(oauthOnlyMessage);
}

function scoreLimit(value: string | number): number {
  const parsed = typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new CliError("Score page size must be an integer from 1 to 20.");
  }
  return parsed;
}
