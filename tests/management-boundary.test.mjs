import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { requestManagementJson, ManagementError, ManagementTransportError } from "../dist/management/client.js";

test("management transport refuses foreign-org paths, operators, and path traversal before sending credentials", async () => {
  for(const path of ["/admin/v1/orgs/synthetic-other/projects","/super-admin/v1/orgs","/admin/v1/orgs/synthetic-org/../synthetic-other/projects","/admin/v1/orgs/synthetic-org/%2e%2e/synthetic-other/projects","//example.test/admin/v1/orgs/synthetic-org/projects", "/customer/v1/orgs/synthetic-other/projects", "/customer/v1/orgs/synthetic-org/../synthetic-other/projects", "/customer/v1/orgs/synthetic-org/%2e%2e/synthetic-other/projects", "/customer/v1/projects"]) {
    for (const credentialClass of ["oauth", "organization_key"]) {
      let called=false;
      await assert.rejects(requestManagementJson({organizationId:"synthetic-org",credentialClass,accessToken:["synthetic","credential"].join("-"),fetchImplementation:async()=>{called=true;return Response.json({});}}, {path,action:"Synthetic read"},z.object({})),/authenticated organization/);
      assert.equal(called,false);
    }
  }
});
test("an org key cannot reach OAuth-only customer endpoints",async()=>{
  let called=false;
  await assert.rejects(requestManagementJson({organizationId:"synthetic-org",accessToken:["synthetic","credential"].join("-"),credentialClass:"organization_key",fetchImplementation:async()=>{called=true;return Response.json({});}}, {path:"/customer/v1/orgs/synthetic-org/projects",action:"Synthetic read"},z.object({})),/requires browser OAuth/);
  assert.equal(called,false);
});
test("organization keys can read reporting and evidence through their tenant admin API", async () => {
  const paths = [
    "reporting", "reporting/options", "errors", "request-logs", "request-logs/health-summary",
    "request-logs/failure-context", "request-logs/requests/synthetic-request", "request-logs/traces/synthetic-trace",
    "billing/balance", "billing/summary", "billing/trend", "billing/usage-by-model", "calls/synthetic-call/cost",
    "projects/synthetic-project/workload-status", "projects/synthetic-project/provider-health", "projects/synthetic-project/cost-breakdown",
    "projects/synthetic-project/captures", "projects/synthetic-project/captures/synthetic-request",
    "projects/synthetic-project/workloads/synthetic-workload/captures", "projects/synthetic-project/workloads/synthetic-workload/captures/export",
  ];
  for (const path of paths) {
    for (const credentialClass of ["organization_key", "oauth"]) {
      let called = false;
      await requestManagementJson({ organizationId: "synthetic-org", credentialClass,
        accessToken: ["synthetic", "credential"].join("-"), fetchImplementation: async (url, init) => {
          called = true;
          assert.equal(new URL(url).pathname, `/admin/v1/orgs/synthetic-org/${path}`);
          assert.equal(init.redirect, "error");
          return Response.json({});
        } },
      { path: `/admin/v1/orgs/synthetic-org/${path}`, action: "Synthetic evidence read" }, z.object({}));
      assert.equal(called, true, path);
    }
  }
});
test("organization keys retain explicit resource management and identity access", async () => {
  for (const path of ["snapshot", "models", "api_keys", "api_keys/synthetic-key", "projects", "projects/default",
    "projects/synthetic-project", "projects/synthetic-project/workloads", "projects/synthetic-project/workloads/synthetic-workload"]) {
    let called = false;
    await requestManagementJson({ organizationId: "synthetic-org", credentialClass: "organization_key",
      accessToken: ["synthetic", "credential"].join("-"), fetchImplementation: async () => { called = true; return Response.json({}); } },
    { path: `/admin/v1/orgs/synthetic-org/${path}`, action: "Synthetic resource operation" }, z.object({}));
    assert.equal(called, true, path);
  }
});
test("HTTP status is available without leaking response details or credentials",async()=>{
  await assert.rejects(requestManagementJson({organizationId:"synthetic-org",accessToken:["synthetic","credential"].join("-"),fetchImplementation:async()=>Response.json({message:"Synthetic private response"},{status:404})}, {path:"/admin/v1/orgs/synthetic-org/projects",action:"Synthetic read",responseFailureMessages:{404:"Capture unavailable."}},z.object({})),(error)=>error instanceof ManagementError && error.status===404 && error.message==="Capture unavailable.");
});

test("response limits reject declared and streamed overflow and cancel the body", async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode("12345")); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(requestManagementJson({
      organizationId: "synthetic-org", accessToken: ["synthetic", "credential"].join("-"),
      fetchImplementation: async () => new Response(body, { headers: declared ? { "content-length": "999" } : {} }),
    }, { path: "/admin/v1/orgs/synthetic-org/projects", action: "Synthetic read", maxResponseBytes: 8 }, z.object({})), /8-byte response limit/);
    assert.equal(cancelled, true);
  }
});

test("a response exactly at the byte limit can be parsed", async () => {
  const result = await requestManagementJson({
    organizationId: "synthetic-org", accessToken: ["synthetic", "credential"].join("-"),
    fetchImplementation: async () => new Response('{"ok":true}'),
  }, { path: "/admin/v1/orgs/synthetic-org/projects", action: "Synthetic read", maxResponseBytes: 11 }, z.object({ ok: z.literal(true) }));
  assert.deepEqual(result, { ok: true });
});

test("transport failures can be retried without treating malformed data as transient", async () => {
  const request = { path: "/admin/v1/orgs/synthetic-org/projects", action: "Synthetic read" };
  const options = { organizationId: "synthetic-org", accessToken: ["synthetic", "credential"].join("-") };
  for (const fetchImplementation of [
    async () => { throw new Error("Synthetic private transport message"); },
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("Synthetic private body message")); } })),
  ]) {
    await assert.rejects(requestManagementJson({ ...options, fetchImplementation }, request, z.object({})), error => {
      assert.ok(error instanceof ManagementTransportError);
      assert.doesNotMatch(error.message, /Synthetic private/);
      return true;
    });
  }
  await assert.rejects(requestManagementJson({ ...options, fetchImplementation: async () => new Response("Synthetic malformed JSON") }, request, z.object({})), error => {
    assert.equal(error instanceof ManagementTransportError, false);
    assert.match(error.message, /invalid response/);
    return true;
  });
});
