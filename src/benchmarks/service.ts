import { z } from "zod";

import { resolveManagementScope, type ManagementScopeOptions } from "../context/service.js";
import { CliError } from "../errors.js";
import { requestManagementJson } from "../management/client.js";
import { resolveManagementSession } from "../management/session.js";

const publicationSchema = z.object({
  id: z.string().min(1),
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  workload_id: z.string().min(1),
  name: z.string().min(1),
  artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  model_count: z.number().int().positive(),
  task_count: z.number().int().positive(),
  best_score: z.number().min(0).max(1),
  best_pass_rate: z.number().min(0).max(1),
  published_at: z.string().min(1),
});

const indexSchema = z.object({
  workloads: z.array(z.object({
    project_id: z.string().min(1),
    project_name: z.string().min(1),
    project_slug: z.string().min(1),
    workload_id: z.string().min(1),
    workload_name: z.string().min(1),
    benchmark: publicationSchema.nullable(),
  })),
});

// Validate the identity and the fields used in the summary, while preserving
// every server-owned report field for the explicit full-report output.
const manifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  project_id: z.string().min(1),
  workload_id: z.string().min(1),
  created_at: z.string().min(1),
  models: z.array(z.object({ model: z.string().min(1) }).passthrough()).min(1),
  report: z.object({
    recommendation: z.object({
      headline: z.string().min(1),
      summary: z.string().min(1),
    }).passthrough(),
    arms: z.array(z.object({
      arm_id: z.string().min(1),
      model: z.string().min(1),
      display_name: z.string().min(1),
      prompt: z.string().min(1),
      role: z.enum(["current", "recommended", "compared"]),
      score: z.number().min(0).max(1),
    }).passthrough()).min(2),
    prompt_change: z.object({
      diff: z.array(z.object({
        op: z.enum(["equal", "insert", "delete", "replace"]),
        before: z.array(z.string()),
        after: z.array(z.string()),
      }).passthrough()).min(1),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const detailSchema = z.object({
  benchmark: manifestSchema.nullable(),
  publication: publicationSchema.nullable(),
});

type Publication = z.infer<typeof publicationSchema>;
type IndexRow = z.infer<typeof indexSchema>["workloads"][number];
type Manifest = z.infer<typeof manifestSchema>;

export interface BenchmarkListResult {
  workloads: IndexRow[];
}

export interface BenchmarkShowInput {
  project?: string;
  workload?: string;
  includeReport?: boolean;
}

export interface BenchmarkShowResult {
  project: { id: string; slug: string; name: string };
  workload: { id: string; name: string };
  publication: Publication | null;
  recommendation: NonNullable<Manifest["report"]>["recommendation"] | null;
  arms: Array<Pick<NonNullable<Manifest["report"]>["arms"][number], "arm_id" | "model" | "display_name" | "role" | "score">>;
  hasPromptDiff: boolean;
  reportAvailable: boolean;
  manifestBytes: number | null;
  benchmark?: Manifest | null;
}

export interface BenchmarksService {
  list(): Promise<BenchmarkListResult>;
  show(input: BenchmarkShowInput): Promise<BenchmarkShowResult>;
}

export function createBenchmarksService(options: ManagementScopeOptions): BenchmarksService {
  return {
    async list() {
      const session = await resolveManagementSession(options);
      const result = await requestManagementJson(session, {
        path: `/admin/v1/orgs/${encodeURIComponent(session.organizationId)}/benchmarks`,
        action: "Benchmark listing",
      }, indexSchema);
      const seen = new Set<string>();
      for (const row of result.workloads) {
        const key = `${row.project_id}\0${row.workload_id}`;
        if (seen.has(key) || (row.benchmark && (
          row.benchmark.org_id !== session.organizationId ||
          row.benchmark.project_id !== row.project_id ||
          row.benchmark.workload_id !== row.workload_id
        ))) throw new CliError("Understudy returned an invalid benchmark listing.");
        seen.add(key);
      }
      return result;
    },

    async show(input) {
      const scope = await resolveManagementScope(options, {
        project: input.project,
        workload: input.workload,
        requireWorkload: true,
        ignoreDefaults: input.project !== undefined,
      });
      const { session, project, workload } = scope;
      const result = await requestManagementJson(session, {
        path: `/admin/v1/orgs/${encodeURIComponent(session.organizationId)}/projects/${encodeURIComponent(project!.id)}/workloads/${encodeURIComponent(workload!.id)}/benchmark`,
        action: "Benchmark read",
      }, detailSchema);
      if ((result.benchmark === null) !== (result.publication === null) ||
          (result.benchmark && (result.benchmark.project_id !== project!.id || result.benchmark.workload_id !== workload!.id)) ||
          (result.publication && (result.publication.org_id !== session.organizationId || result.publication.project_id !== project!.id || result.publication.workload_id !== workload!.id))) {
        throw new CliError("Understudy returned a benchmark outside the selected workload.");
      }
      const report = result.benchmark?.report;
      return {
        project: { id: project!.id, slug: project!.slug, name: project!.name },
        workload: { id: workload!.id, name: workload!.name },
        publication: result.publication,
        recommendation: report?.recommendation ?? null,
        arms: report?.arms.map(({ arm_id, model, display_name, role, score }) =>
          ({ arm_id, model, display_name, role, score })) ?? [],
        hasPromptDiff: report?.prompt_change !== undefined,
        reportAvailable: report !== undefined,
        manifestBytes: result.benchmark ? Buffer.byteLength(JSON.stringify(result.benchmark), "utf8") : null,
        ...(input.includeReport ? { benchmark: result.benchmark } : {}),
      };
    },
  };
}
