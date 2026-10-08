import assert from "node:assert/strict";
import test from "node:test";

import { createReportService } from "../dist/report/service.js";

const organizationId = "synthetic/organization";
const accessToken = tokenFor(organizationId);

function tokenFor(orgId) {
  const claims = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      org_id: orgId,
    }),
  ).toString("base64url");
  return `synthetic.${claims}.signature`;
}

function authStore(onRead = () => undefined) {
  return {
    read: async () => {
      onRead();
      return { version: 1, method: "oauth", accessToken };
    },
    write: async () => undefined,
    clear: async () => undefined,
  };
}

function coverage(gap = null) {
  return {
    source_timestamp: "2026-08-01T12:00:00.000Z",
    data_completeness: gap ? 0.9 : 1,
    known_gaps: gap ? [gap] : [],
  };
}

function healthResponse() {
  return {
    org_id: organizationId,
    recent: {
      state: "degraded",
      window_minutes: 10,
      window_start: "2026-08-01T11:50:00.000Z",
      window_end: "2026-08-01T12:00:00.000Z",
      requests: 20,
      errors: 2,
      error_rate: 0.1,
    },
    baseline: {
      state: "observing",
      window_minutes: 60,
      window_start: "2026-08-01T11:00:00.000Z",
      window_end: "2026-08-01T12:00:00.000Z",
      requests: 100,
      errors: 3,
      error_rate: 0.03,
    },
    workloads: [
      {
        project_id: "synthetic-project",
        project: "Synthetic Project",
        workload_id: "synthetic-workload",
        workload: "Synthetic Workload",
        state: "degraded",
        requests: 20,
        errors: 2,
        error_rate: 0.1,
      },
    ],
    active_workloads: 1,
    idle_workloads: 2,
    roster_available: true,
    workloads_truncated: false,
    coverage: coverage("synthetic health gap"),
    generated_at: "2026-08-01T12:00:01.000Z",
  };
}

function usageRow(overrides = {}) {
  return {
    project_id: null,
    project: null,
    workload_id: "synthetic-workload",
    workload: "Synthetic Workload",
    requests: 4,
    input_tokens: 40,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 2,
    output_tokens: 8,
    total_tokens: 48,
    customer_cost_usd: 0.25,
    ...overrides,
  };
}

function reportingResponse(window) {
  return {
    org_id: organizationId,
    window,
    window_start: "2026-07-31T12:00:00.000Z",
    window_end: "2026-08-01T12:00:00.000Z",
    group_by: "workload",
    filters: {
      project_id: null,
      workload_id: null,
      exclude_project_ids: [],
    },
    totals: {
      requests: 10,
      input_tokens: 100,
      cache_read_input_tokens: 25,
      cache_creation_input_tokens: 5,
      output_tokens: 20,
      total_tokens: 120,
      customer_cost_usd: 1.5,
    },
    series: [
      usageRow(),
      usageRow({
        requests: 6,
        input_tokens: 60,
        cache_read_input_tokens: 15,
        cache_creation_input_tokens: 3,
        output_tokens: 12,
        total_tokens: 72,
        customer_cost_usd: 1.25,
      }),
    ],
    generated_at: "2026-08-01T12:00:02.000Z",
  };
}

function reportingOptionsResponse(overrides = {}) {
  return {
    projects: [{ id: "synthetic-project", name: "Synthetic Project" }],
    workloads: [
      {
        id: "synthetic-workload",
        project_id: "synthetic-project",
        name: "Synthetic Workload",
      },
    ],
    generated_at: "2026-08-01T12:00:04.000Z",
    ...overrides,
  };
}

function errorsResponse(window) {
  return {
    org_id: organizationId,
    window,
    window_start: "2026-07-31T12:00:00.000Z",
    window_end: "2026-08-01T12:00:00.000Z",
    group_by: "workload",
    filters: { project_id: null, workload_id: null },
    totals: {
      requests: 10,
      errors: 2,
      error_rate: 0.2,
      by_source: { upstream: 1, network: 1, edge: 0, unclassified: 0 },
      by_status: [{ status_code: 503, count: 2 }],
    },
    groups: [
      {
        project_id: "synthetic-project",
        project: "Synthetic Project",
        workload_id: "synthetic-workload",
        workload: "Synthetic Workload",
        requests: 10,
        errors: 2,
        error_rate: 0.2,
        last_error_at: "2026-08-01T11:59:00.000Z",
      },
    ],
    recent: [
      {
        request_id: "synthetic-request-must-not-be-returned",
        synthetic_payload: "synthetic-private-response-data",
      },
    ],
    coverage: coverage("synthetic pre-routing errors are not covered"),
    generated_at: "2026-08-01T12:00:03.000Z",
  };
}

function responseFor(input) {
  const url = new URL(String(input));
  const window = url.searchParams.get("window") ?? "24h";
  if (url.pathname.endsWith("/request-logs/health-summary")) {
    return healthResponse();
  }
  if (url.pathname.endsWith("/reporting/options")) {
    return reportingOptionsResponse();
  }
  if (url.pathname.endsWith("/reporting")) return reportingResponse(window);
  if (url.pathname.endsWith("/errors")) return errorsResponse(window);
  throw new Error(`Unexpected synthetic URL: ${url.pathname}`);
}

test("report windows are rejected before OAuth or network access", async () => {
  let reads = 0;
  let requests = 0;
  const service = createReportService({
    authStore: authStore(() => {
      reads += 1;
    }),
    fetchImplementation: async () => {
      requests += 1;
      throw new Error("must not request");
    },
  });

  for (const method of ["summary", "usage", "errors", "costs"]) {
    await assert.rejects(service[method]("1h"), /24h, 7d, or 30d/);
  }
  assert.equal(reads, 0);
  assert.equal(requests, 0);
});

test("the combined report resolves OAuth once and starts all three reads concurrently", async () => {
  let reads = 0;
  const requests = [];
  const pending = [];
  const service = createReportService({
    authStore: authStore(() => {
      reads += 1;
    }),
    baseUrl: "https://example.test/",
    fetchImplementation: (input, init) =>
      new Promise((resolve) => {
        requests.push({ url: String(input), authorization: init.headers.authorization });
        pending.push(() => resolve(Response.json(responseFor(input))));
        if (pending.length === 3) {
          for (const release of pending.splice(0)) release();
        }
      }),
  });

  const result = await service.summary("7d");

  assert.equal(reads, 1);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.authorization === `Bearer ${accessToken}`));
  assert.deepEqual(
    requests.map((request) => request.url).sort(),
    [
      "https://example.test/admin/v1/orgs/synthetic%2Forganization/errors?window=7d&group_by=workload",
      "https://example.test/admin/v1/orgs/synthetic%2Forganization/reporting?window=7d&group_by=workload",
      "https://example.test/admin/v1/orgs/synthetic%2Forganization/request-logs/health-summary",
    ],
  );
  assert.equal(result.window, "7d");
  assert.equal(result.health.state, "degraded");
  assert.deepEqual(result.health.coverage.knownGaps, ["synthetic health gap"]);
  assert.equal(result.usage.totalTokens, 120);
  assert.equal(result.errors.errors, 2);
  assert.deepEqual(result.errors.coverage.knownGaps, [
    "synthetic pre-routing errors are not covered",
  ]);
  assert.deepEqual(result.costs, {
    recordedCustomerCostUsd: 1.5,
    pricingCoverage: "unavailable",
  });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-request-must-not-be-returned/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-response-data/);
});

test("usage resolves OAuth once and starts reporting and roster reads concurrently", async () => {
  let reads = 0;
  const requests = [];
  const pending = [];
  const service = createReportService({
    authStore: authStore(() => {
      reads += 1;
    }),
    baseUrl: "https://example.test",
    fetchImplementation: (input) =>
      new Promise((resolve) => {
        requests.push(String(input));
        pending.push(() => resolve(Response.json(responseFor(input))));
        if (pending.length === 2) {
          for (const release of pending.splice(0)) release();
        }
      }),
  });

  const result = await service.usage("7d");

  assert.equal(reads, 1);
  assert.deepEqual(requests.sort(), [
    "https://example.test/admin/v1/orgs/synthetic%2Forganization/reporting/options",
    "https://example.test/admin/v1/orgs/synthetic%2Forganization/reporting?window=7d&group_by=workload",
  ]);
  assert.equal(result.workloads[0].projectId, "synthetic-project");
});

test("individual report views normalize aggregate-only data", async () => {
  const urls = [];
  const service = createReportService({
    authStore: authStore(),
    baseUrl: "https://example.test",
    fetchImplementation: async (input) => {
      urls.push(String(input));
      return Response.json(responseFor(input));
    },
  });

  const health = await service.health();
  const usage = await service.usage("7d");
  const errors = await service.errors("30d");
  const costs = await service.costs();

  assert.equal(health.recent.windowMinutes, 10);
  assert.equal(health.workloads[0].workload, "Synthetic Workload");
  assert.deepEqual(usage.workloads[0], {
    projectId: "synthetic-project",
    project: "Synthetic Project",
    workloadId: "synthetic-workload",
    workload: "Synthetic Workload",
    requests: 10,
    inputTokens: 100,
    cacheReadInputTokens: 25,
    cacheCreationInputTokens: 5,
    outputTokens: 20,
    totalTokens: 120,
  });
  assert.equal(errors.totals.byStatus[0].statusCode, 503);
  assert.equal(errors.workloads[0].lastErrorAt, "2026-08-01T11:59:00.000Z");
  assert.equal(costs.window, "24h");
  assert.equal(costs.recordedCustomerCostUsd, 1.5);
  assert.equal(costs.pricingCoverage, "unavailable");
  assert.deepEqual(costs.workloads[0], {
    projectId: "synthetic-project",
    project: "Synthetic Project",
    workloadId: "synthetic-workload",
    workload: "Synthetic Workload",
    requests: 10,
    recordedCustomerCostUsd: 1.5,
  });
  assert.equal(urls.length, 6);
  assert.equal(
    urls.filter((url) => url.endsWith("/reporting/options")).length,
    2,
  );
});

test("reporting options enrich name collisions only by stable workload id", async () => {
  const service = createReportService({
    authStore: authStore(),
    baseUrl: "https://example.test",
    fetchImplementation: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/reporting/options")) {
        return Response.json(
          reportingOptionsResponse({
            projects: [
              { id: "first-project", name: "First Project" },
              { id: "second-project", name: "Second Project" },
            ],
            workloads: [
              { id: "first-main", project_id: "first-project", name: "main" },
              { id: "second-main", project_id: "second-project", name: "main" },
              {
                id: "current-same-name",
                project_id: "first-project",
                name: "Historical Name",
              },
            ],
          }),
        );
      }
      return Response.json({
        ...reportingResponse("24h"),
        series: [
          usageRow({ workload_id: "first-main", workload: "main" }),
          usageRow({ workload_id: "second-main", workload: "main" }),
          usageRow({
            workload_id: "deleted-workload",
            workload: "Historical Name",
          }),
        ],
      });
    },
  });

  const result = await service.usage();

  assert.deepEqual(
    result.workloads.map((workload) => ({
      projectId: workload.projectId,
      project: workload.project,
      workloadId: workload.workloadId,
      workload: workload.workload,
    })),
    [
      {
        projectId: "first-project",
        project: "First Project",
        workloadId: "first-main",
        workload: "main",
      },
      {
        projectId: "second-project",
        project: "Second Project",
        workloadId: "second-main",
        workload: "main",
      },
      {
        projectId: null,
        project: null,
        workloadId: "deleted-workload",
        workload: "Historical Name",
      },
    ],
  );
});

test("valid unattributed workload rows remain visible", async () => {
  const service = createReportService({
    authStore: authStore(),
    baseUrl: "https://example.test",
    fetchImplementation: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/reporting/options")) {
        return Response.json(reportingOptionsResponse());
      }
      if (url.pathname.endsWith("/reporting")) {
        return Response.json({
          ...reportingResponse("24h"),
          series: [
            usageRow({
              project_id: "",
              project: null,
              workload_id: null,
              workload: null,
            }),
          ],
        });
      }
      return Response.json({
        ...errorsResponse("24h"),
        groups: [
          {
            project_id: "",
            project: null,
            workload_id: null,
            workload: "",
            requests: 4,
            errors: 1,
            error_rate: 0.25,
            last_error_at: "2026-08-01T11:59:00.000Z",
          },
        ],
      });
    },
  });

  const usage = await service.usage();
  const errors = await service.errors();

  assert.deepEqual(usage.workloads[0], {
    projectId: null,
    project: null,
    workloadId: null,
    workload: "unattributed",
    requests: 4,
    inputTokens: 40,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: 2,
    outputTokens: 8,
    totalTokens: 48,
  });
  assert.equal(errors.workloads[0].projectId, null);
  assert.equal(errors.workloads[0].project, "unattributed");
  assert.equal(errors.workloads[0].workloadId, null);
  assert.equal(errors.workloads[0].workload, "unattributed");
});

test("usage keeps anonymous workloads distinct and enriches repeated rows", async () => {
  const service = createReportService({
    authStore: authStore(),
    baseUrl: "https://example.test",
    fetchImplementation: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/reporting/options")) {
        return Response.json(reportingOptionsResponse());
      }
      return Response.json({
        ...reportingResponse("24h"),
        series: [
          usageRow({
            project_id: null,
            project: "Synthetic Project",
            workload_id: null,
            workload: "Anonymous One",
          }),
          usageRow({
            project_id: null,
            project: "Synthetic Project",
            workload_id: null,
            workload: "Anonymous One",
            requests: 6,
          }),
          usageRow({
            project_id: null,
            project: "Synthetic Project",
            workload_id: null,
            workload: "Anonymous Two",
          }),
          usageRow({
            project_id: null,
            project: null,
            workload_id: "synthetic-workload-id",
            workload: null,
          }),
          usageRow({
            project_id: "synthetic-project-id",
            project: "Named Project",
            workload_id: "synthetic-workload-id",
            workload: "Named Workload",
          }),
        ],
      });
    },
  });

  const result = await service.usage();

  assert.equal(result.workloads.length, 3);
  assert.equal(result.workloads[0].projectId, null);
  assert.equal(result.workloads[0].workload, "Anonymous One");
  assert.equal(result.workloads[0].requests, 10);
  assert.equal(result.workloads[1].workload, "Anonymous Two");
  assert.equal(result.workloads[1].requests, 4);
  assert.equal(result.workloads[2].projectId, "synthetic-project-id");
  assert.equal(result.workloads[2].project, "Named Project");
  assert.equal(result.workloads[2].workload, "Named Workload");
  assert.equal(result.workloads[2].requests, 8);
});

test("reports reject conflicting project ownership for a workload id", async () => {
  for (const method of ["usage", "costs"]) {
    const service = createReportService({
      authStore: authStore(),
      baseUrl: "https://example.test",
      fetchImplementation: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/reporting/options")) {
          return Response.json(
            reportingOptionsResponse({ projects: [], workloads: [] }),
          );
        }
        return Response.json({
          ...reportingResponse("24h"),
          series: [
            usageRow({
              project_id: "synthetic-first-project",
              workload_id: "synthetic-shared-workload",
            }),
            usageRow({
              project_id: "synthetic-second-project",
              workload_id: "synthetic-shared-workload",
            }),
          ],
        });
      },
    });

    await assert.rejects(service[method](), /invalid usage report/i);
  }
});

test("a single named project does not claim an anonymous workload row", async () => {
  const service = createReportService({
    authStore: authStore(),
    baseUrl: "https://example.test",
    fetchImplementation: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/reporting/options")) {
        return Response.json(reportingOptionsResponse());
      }
      return Response.json({
        ...reportingResponse("24h"),
        series: [
          usageRow({
            project_id: "named-project-id",
            project: "Shared Project",
            workload_id: null,
            workload: "Shared Workload",
          }),
          usageRow({
            project_id: null,
            project: "Shared Project",
            workload_id: null,
            workload: "Shared Workload",
          }),
        ],
      });
    },
  });

  const result = await service.usage();

  assert.deepEqual(
    result.workloads.map((workload) => workload.projectId),
    ["named-project-id", null],
  );
});

test("ambiguous project names do not claim anonymous workload rows", async () => {
  const service = createReportService({
    authStore: authStore(),
    baseUrl: "https://example.test",
    fetchImplementation: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/reporting/options")) {
        return Response.json(reportingOptionsResponse());
      }
      return Response.json({
        ...reportingResponse("24h"),
        series: [
          usageRow({
            project_id: "first-project-id",
            project: "Shared Project",
            workload_id: null,
            workload: "Shared Workload",
          }),
          usageRow({
            project_id: "second-project-id",
            project: "Shared Project",
            workload_id: null,
            workload: "Shared Workload",
          }),
          usageRow({
            project_id: null,
            project: "Shared Project",
            workload_id: null,
            workload: "Shared Workload",
          }),
        ],
      });
    },
  });

  const result = await service.usage();

  assert.deepEqual(
    result.workloads.map((workload) => workload.projectId),
    ["first-project-id", "second-project-id", null],
  );
});

test("malformed reports fail without leaking OAuth or response data", async () => {
  const privateResponseValue = "synthetic-private-report-value";
  const service = createReportService({
    authStore: authStore(),
    baseUrl: "https://example.test",
    fetchImplementation: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/reporting/options")) {
        return Response.json(reportingOptionsResponse());
      }
      return Response.json({
        ...reportingResponse("24h"),
        totals: {
          ...reportingResponse("24h").totals,
          customer_cost_usd: privateResponseValue,
        },
      });
    },
  });

  await assert.rejects(service.usage(), (error) => {
    assert.match(error.message, /invalid usage report/i);
    assert.doesNotMatch(error.message, new RegExp(accessToken));
    assert.doesNotMatch(error.message, new RegExp(privateResponseValue));
    return true;
  });
});

test("reports reject a response for a different window", async () => {
  const service = createReportService({
    authStore: authStore(),
    baseUrl: "https://example.test",
    fetchImplementation: async (input) => {
      const url = new URL(String(input));
      return Response.json(
        url.pathname.endsWith("/reporting/options")
          ? reportingOptionsResponse()
          : reportingResponse("24h"),
      );
    },
  });

  await assert.rejects(service.usage("7d"), /invalid usage report/i);
});
