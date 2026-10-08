import assert from "node:assert/strict";
import test from "node:test";

import { createWorkloadsService } from "../dist/workloads/service.js";

function syntheticJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return [header, payload, "synthetic-signature"].join(".");
}

const organizationId = "synthetic/organization";
const accessToken = syntheticJwt({
  exp: Date.now() / 1_000 + 3_600,
  org_id: organizationId,
});

function authStore() {
  return {
    read: async () => ({
      version: 1,
      method: "oauth",
      accessToken,
    }),
    write: async () => undefined,
    clear: async () => undefined,
  };
}

const project = {
  id: "synthetic/project",
  slug: "synthetic-project",
  name: "Synthetic Project",
};

function projectRecord(overrides = {}) {
  return { ...project, org_id: organizationId, ...overrides };
}

function workload(overrides = {}) {
  return {
    id: "synthetic/workload",
    project_id: project.id,
    name: "main",
    capture_enabled: false,
    route_deployment_id: null,
    route_model_id: null,
    route_traffic_pct: 0,
    is_default: true,
    created_at: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function service(fetchImplementation) {
  return createWorkloadsService({
    store: authStore(),
    baseUrl: "https://example.test/",
    fetchImplementation,
  });
}

function assertOAuthRequest(init) {
  assert.equal(init.headers.authorization, `Bearer ${accessToken}`);
}

function isProjectList(input) {
  return new URL(String(input)).pathname.endsWith("/projects");
}

test("workload listing fully paginates projects and removes private route ids", async () => {
  const requests = [];
  const privateRouteReference = "synthetic-internal-route";
  const result = await service(async (input, init) => {
    requests.push({ input, init });
    assertOAuthRequest(init);
    if (String(input).includes("cursor=synthetic%2Fcursor")) {
      return Response.json({ projects: [projectRecord()], cursor: null });
    }
    if (String(input).endsWith("/projects")) {
      return Response.json({
        projects: [
          {
            id: "other-project",
            org_id: organizationId,
            slug: "other-project",
            name: "Other Project",
          },
        ],
        cursor: "synthetic/cursor",
      });
    }
    return Response.json({
      workloads: [
        workload({
          route_deployment_id: privateRouteReference,
          route_model_id: "synthetic-model",
          route_traffic_pct: 40,
        }),
      ],
    });
  }).list(project.slug);

  assert.equal(requests.length, 3);
  assert.equal(
    requests[2].input,
    "https://example.test/admin/v1/orgs/synthetic%2Forganization/projects/synthetic%2Fproject/workloads",
  );
  assert.deepEqual(result.project, project);
  assert.equal(result.workloads[0].routeKind, "deployment");
  assert.equal(result.workloads[0].routeModelId, "synthetic-model");
  assert.equal(result.workloads[0].routeTrafficPercent, 40);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateRouteReference));
});

test("workload listing reports a model route when no deployment is pinned", async () => {
  const result = await service(async (input) => {
    if (isProjectList(input)) {
      return Response.json({ projects: [projectRecord()], cursor: null });
    }
    return Response.json({
      workloads: [
        workload({
          route_model_id: "synthetic-model",
          route_traffic_pct: 40,
        }),
      ],
    });
  }).list(project.slug);

  assert.equal(result.workloads[0].routeKind, "model");
  assert.equal(result.workloads[0].routeModelId, "synthetic-model");
  assert.equal(result.workloads[0].routeTrafficPercent, 40);
});

test("workload listing preserves deployment routing without exposing its id", async () => {
  const privateRouteReference = "synthetic-private-route";
  const result = await service(async (input) => {
    if (isProjectList(input)) {
      return Response.json({ projects: [projectRecord()], cursor: null });
    }
    return Response.json({
      workloads: [
        workload({
          route_deployment_id: privateRouteReference,
          route_traffic_pct: 35,
        }),
      ],
    });
  }).list(project.slug);

  assert.equal(result.workloads[0].routeKind, "deployment");
  assert.equal(result.workloads[0].routeModelId, null);
  assert.equal(result.workloads[0].routeTrafficPercent, 35);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateRouteReference));
});

test("workload creation sends capture off by default", async () => {
  let createRequest;
  const result = await service(async (input, init) => {
    assertOAuthRequest(init);
    if (isProjectList(input)) {
      return Response.json({ projects: [projectRecord()], cursor: null });
    }
    createRequest = { input, init };
    return Response.json(workload({ name: "new-workload" }), { status: 201 });
  }).create({ project: project.id, name: "new-workload" });

  assert.equal(
    createRequest.input,
    "https://example.test/admin/v1/orgs/synthetic%2Forganization/projects/synthetic%2Fproject/workloads",
  );
  assert.equal(createRequest.init.method, "POST");
  assert.deepEqual(JSON.parse(createRequest.init.body), {
    name: "new-workload",
    capture_enabled: false,
  });
  assert.equal(result.workload.captureEnabled, false);
});

test("workload show resolves an exact name from the verified listing", async () => {
  const namedLikeAnId = workload({
    id: "resolved/workload",
    name: "usp_phantom",
  });

  const result = await service(async (input) => {
    const url = String(input);
    if (isProjectList(input)) {
      return Response.json({ projects: [projectRecord()], cursor: null });
    }
    if (url.endsWith("/workloads")) {
      return Response.json({ workloads: [namedLikeAnId] });
    }
    throw new Error(`unexpected request: ${url}`);
  }).show({ project: project.slug, workload: "usp_phantom" });

  assert.equal(result.workload.id, "resolved/workload");
});

test("workload update resolves the exact id and sends only requested fields", async () => {
  const existing = workload();
  let updateRequest;
  const result = await service(async (input, init) => {
    const url = String(input);
    if (isProjectList(input)) {
      return Response.json({ projects: [projectRecord()], cursor: null });
    }
    if (url.endsWith("/workloads")) {
      return Response.json({ workloads: [existing] });
    }
    updateRequest = { input, init };
    return Response.json(
      workload({ name: "renamed-workload", capture_enabled: true }),
    );
  }).update({
    project: project.slug,
    workload: existing.id,
    name: "renamed-workload",
    capture: true,
  });

  assert.equal(
    updateRequest.input,
    "https://example.test/admin/v1/orgs/synthetic%2Forganization/projects/synthetic%2Fproject/workloads/synthetic%2Fworkload",
  );
  assert.equal(updateRequest.init.method, "PATCH");
  assert.deepEqual(JSON.parse(updateRequest.init.body), {
    name: "renamed-workload",
    capture_enabled: true,
  });
  assert.equal(result.workload.name, "renamed-workload");
  assert.equal(result.workload.captureEnabled, true);
});

test("workload lookup never treats an unknown id-shaped value as a direct path", async () => {
  const requests = [];
  await assert.rejects(
    service(async (input) => {
      requests.push(String(input));
      if (isProjectList(input)) {
        return Response.json({ projects: [projectRecord()], cursor: null });
      }
      return Response.json({ workloads: [workload()] });
    }).show({ project: project.slug, workload: "usp_missing" }),
    /exact id or name/i,
  );

  assert.equal(requests.length, 2);
  assert.equal(requests.some((url) => url.endsWith("/usp_missing")), false);
});

test("project selection rejects an id and slug collision", async () => {
  const requests = [];
  await assert.rejects(
    service(async (input) => {
      requests.push(String(input));
      return Response.json({
        projects: [
          projectRecord({ id: "collision", slug: "first-project" }),
          projectRecord({ id: "second-project", slug: "collision" }),
        ],
        cursor: null,
      });
    }).list("collision"),
    /project selector is ambiguous/i,
  );

  assert.equal(requests.length, 1);
});

test("workload update rejects an id and name collision before mutation", async () => {
  const requests = [];
  await assert.rejects(
    service(async (input) => {
      requests.push(String(input));
      if (isProjectList(input)) {
        return Response.json({ projects: [projectRecord()], cursor: null });
      }
      return Response.json({
        workloads: [
          workload({ id: "usp_collision", name: "main" }),
          workload({ id: "synthetic-other", name: "usp_collision" }),
        ],
      });
    }).update({
      project: project.slug,
      workload: "usp_collision",
      capture: true,
    }),
    /ambiguous workload listing/i,
  );

  assert.equal(requests.length, 2);
});

test("mutation transport failures preserve an ambiguous outcome", async () => {
  await assert.rejects(
    service(async (input) => {
      if (isProjectList(input)) {
        return Response.json({ projects: [projectRecord()], cursor: null });
      }
      throw new Error("transport details stay private");
    }).create({ project: project.slug, name: "new-workload" }),
    (error) => {
      assert.match(error.message, /may have succeeded/i);
      assert.match(error.message, /list workloads before retrying/i);
      assert.doesNotMatch(error.message, /transport details/i);
      return true;
    },
  );
});

test("workload creation scope failures preserve an ambiguous outcome", async () => {
  await assert.rejects(
    service(async (input) => {
      if (isProjectList(input)) {
        return Response.json({ projects: [projectRecord()], cursor: null });
      }
      return Response.json(
        workload({ project_id: "synthetic/other-project" }),
        { status: 201 },
      );
    }).create({ project: project.slug, name: "new-workload" }),
    (error) => {
      assert.match(error.message, /may have succeeded/i);
      assert.match(error.message, /list workloads before retrying/i);
      return true;
    },
  );
});

test("workload creation requires the response to confirm requested fields", async () => {
  for (const returned of [
    workload({ name: "different-workload" }),
    workload({ name: "new-workload", capture_enabled: true }),
  ]) {
    await assert.rejects(
      service(async (input) => {
        if (isProjectList(input)) {
          return Response.json({ projects: [projectRecord()], cursor: null });
        }
        return Response.json(returned, { status: 201 });
      }).create({ project: project.slug, name: "new-workload" }),
      (error) => {
        assert.match(error.message, /may have succeeded/i);
        assert.match(error.message, /list workloads before retrying/i);
        return true;
      },
    );
  }
});

test("workload update transport failures require a read before retrying", async () => {
  await assert.rejects(
    service(async (input) => {
      if (isProjectList(input)) {
        return Response.json({ projects: [projectRecord()], cursor: null });
      }
      if (String(input).endsWith("/workloads")) {
        return Response.json({ workloads: [workload()] });
      }
      throw new Error("transport details stay private");
    }).update({
      project: project.slug,
      workload: "main",
      capture: true,
    }),
    (error) => {
      assert.match(error.message, /may have succeeded/i);
      assert.match(error.message, /show the workload before retrying/i);
      assert.doesNotMatch(error.message, /transport details/i);
      return true;
    },
  );
});

test("workload update scope failures require a read before retrying", async () => {
  await assert.rejects(
    service(async (input) => {
      if (isProjectList(input)) {
        return Response.json({ projects: [projectRecord()], cursor: null });
      }
      if (String(input).endsWith("/workloads")) {
        return Response.json({ workloads: [workload()] });
      }
      return Response.json(workload({ id: "synthetic/other-workload" }));
    }).update({
      project: project.slug,
      workload: "main",
      capture: true,
    }),
    (error) => {
      assert.match(error.message, /may have succeeded/i);
      assert.match(error.message, /show the workload before retrying/i);
      return true;
    },
  );
});

test("workload update requires the response to confirm every requested change", async () => {
  for (const returned of [
    workload({ name: "main", capture_enabled: true }),
    workload({ name: "renamed-workload", capture_enabled: false }),
  ]) {
    await assert.rejects(
      service(async (input) => {
        if (isProjectList(input)) {
          return Response.json({ projects: [projectRecord()], cursor: null });
        }
        if (String(input).endsWith("/workloads")) {
          return Response.json({ workloads: [workload()] });
        }
        return Response.json(returned);
      }).update({
        project: project.slug,
        workload: "main",
        name: "renamed-workload",
        capture: true,
      }),
      (error) => {
        assert.match(error.message, /may have succeeded/i);
        assert.match(error.message, /show the workload before retrying/i);
        return true;
      },
    );
  }
});

test("workload update rejects an empty patch before authentication", async () => {
  let reads = 0;
  const emptyUpdateService = createWorkloadsService({
    store: {
      read: async () => {
        reads += 1;
        return null;
      },
      write: async () => undefined,
      clear: async () => undefined,
    },
  });

  await assert.rejects(
    emptyUpdateService.update({
      project: project.slug,
      workload: "main",
    }),
    /at least one workload change/i,
  );
  assert.equal(reads, 0);
});

test("workload creation validates its name before authentication", async () => {
  let reads = 0;
  const invalidService = createWorkloadsService({
    store: {
      read: async () => {
        reads += 1;
        return null;
      },
      write: async () => undefined,
      clear: async () => undefined,
    },
  });

  await assert.rejects(
    invalidService.create({
      project: project.slug,
      name: "Invalid Workload",
    }),
    /workload names/i,
  );
  assert.equal(reads, 0);
});
