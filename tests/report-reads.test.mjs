import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { createReportReads, reportRange, billingRange } from "../dist/report/reads.js";
import { addReportCommands } from "../dist/commands/report.js";
import { addReportReadCommands } from "../dist/commands/report-reads.js";
import { addBillingCommands } from "../dist/commands/billing.js";

const org = "synthetic-organization";
const project = { id: "synthetic-project", org_id: org, slug: "synthetic-app", name: "Synthetic App" };
const workload = { id: "synthetic-workload", project_id: project.id, name: "synthetic-workload" };
const claims = Buffer.from(JSON.stringify({ org_id: org, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
const authStore = { read: async () => ({version: 1, method: "oauth", accessToken: `synthetic.${claims}.signature`}), write: async () => {}, clear: async () => {} };
const contextStore = { read: async () => null, write: async () => {}, clear: async () => {} };
const tokens = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 12 };
const totals = { requests: 2, input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2, total_tokens: 12, customer_cost_usd: 0.01 };
const fixedNow = new Date("2026-08-02T00:00:00.000Z");
function harness(reply) {
  const calls = [];
  const reads = createReportReads({ authStore, contextStore, now: () => fixedNow, baseUrl: "https://example.test", fetchImplementation: async (url, init) => {
    calls.push({url: new URL(url), init});
    const path = new URL(url).pathname;
    if (path.endsWith("/projects")) return Response.json({projects:[project]});
    if (path.endsWith("/workloads")) return Response.json({workloads:[workload]});
    return Response.json(await reply(new URL(url)));
  }});
  return {reads, calls};
}
function usage(overrides = {}) {
  return {org_id:org, window:"24h", window_start:"2026-08-01T00:00:00.000Z", window_end:fixedNow.toISOString(), granularity:"hour", group_by:"workload", filters:{project_id:null,workload_id:null,exclude_project_ids:[],request_environment:"all"},totals,series:[],generated_at:fixedNow.toISOString(),...overrides};
}

test("filtered usage resolves org/project/workload ancestry and sends exact supported filters", async () => {
  const result = harness(() => usage({filters:{project_id:project.id,workload_id:workload.id,exclude_project_ids:[],request_environment:"test"}, group_by:"model"}));
  const output = await result.reads.query("usage", {project:project.slug,workload:workload.name,environment:"test",groupBy:"model",granularity:"hour"});
  assert.equal(result.calls.length,3);
  for (const call of result.calls) {
    assert.match(call.url.pathname, new RegExp(`/orgs/${org}/`));
    assert.equal(call.init.redirect,"error");
  }
  const query = result.calls.at(-1).url.searchParams;
  assert.equal(query.get("project_id"),project.id);
  assert.equal(query.get("workload_id"),workload.id);
  assert.equal(query.get("request_environment"),"test");
  assert.equal(query.get("group_by"),"model");
  assert.equal(output.organizationId,org);
  assert.equal(output.workloadId,workload.id);
});

test("reports reject wrong org, selection, environment, and row scope", async () => {
  const selected = {project_id:project.id,workload_id:workload.id,exclude_project_ids:[],request_environment:"all"};
  const cases = [
    {org_id:"synthetic-foreign-org",filters:selected},
    {filters:{...selected,project_id:"synthetic-foreign-project"}},
    {filters:{...selected,request_environment:"test"}},
    {filters:selected,series:[{...totals,bucket:fixedNow.toISOString(),project_id:"synthetic-foreign-project",project:null,workload_id:workload.id,workload:null,model:null}]},
  ];
  for (const response of cases) {
    const {reads} = harness(() => usage(response));
    await assert.rejects(reads.query("usage",{project:project.slug,workload:workload.name}),/wrong organization|different selection|outside the selected scope/);
  }
});

test("project selection cannot address an ID outside the current org roster", async () => {
  const {reads,calls} = harness(() => {throw new Error("report endpoint must not be called");});
  await assert.rejects(reads.query("costs",{project:"synthetic-other-project"}),/not found.*authenticated organization/);
  assert.equal(calls.length,1);
});

test("report date bounds are inclusive UTC dates and validate granularity before auth/network", async () => {
  assert.equal(reportRange({from:"2026-08-01",to:"2026-08-01"}).minutes,1440);
  for (const input of [{from:"2026-02-30",to:"2026-03-02"},{from:"2026-08-02",to:"2026-08-01"},{from:"2026-08-01"},{from:"2026-08-01",to:"2026-08-01",window:"7d"}]) assert.throws(()=>reportRange(input));
  const {reads,calls}=harness(()=>usage());
  await assert.rejects(reads.query("usage",{window:"7d",granularity:"minute"}),/Granularity/);
  await assert.rejects(reads.query("errors",{excludeProject:["synthetic-app"]}),/do not support/);
  assert.equal(calls.length,0);
});

test("report custom dates require the server to echo the exact half-open bounds", async () => {
  const {reads}=harness(()=>usage({window:"custom"}));
  const output=await reads.query("costs",{from:"2026-08-01",to:"2026-08-01"});
  assert.equal(output.pricingCoverage,"unavailable");
  const wrong=harness(()=>usage({window:"custom",window_end:"2026-08-03T00:00:00.000Z"}));
  await assert.rejects(wrong.reads.query("costs",{from:"2026-08-01",to:"2026-08-01"}),/different UTC/);
});

test("billing timestamp bounds are half-open, never inclusive calendar dates", () => {
  const range=billingRange({from:"2026-08-01T00:00:00Z",to:"2026-08-02T00:00:00Z"},fixedNow);
  assert.equal(range.get("to"),fixedNow.toISOString());
  assert.throws(()=>billingRange({from:"2026-08-01",to:"2026-08-02"},fixedNow),/timestamps/);
  assert.throws(()=>billingRange({from:"2026-02-30T00:00:00Z",to:"2026-03-03T00:00:00Z"},fixedNow),/Invalid/);
  assert.throws(()=>billingRange({from:fixedNow.toISOString(),to:fixedNow.toISOString()},fixedNow),/after/);
});

test("billing preserves priced events, metered requests and pricing uncertainty", async () => {
  const {reads,calls}=harness((url)=>({summary:{org_id:org,from:url.searchParams.get("from"),to:url.searchParams.get("to"),tokens,metered_requests:2,priced_events:3,estimated_cost_usd:0.01,blended_price_per_mtok:1}}));
  const output=await reads.billing("summary",{window:"24h"});
  assert.equal(output.data.summary.priced_events,3);
  assert.equal(output.data.summary.metered_requests,2);
  assert.equal(output.pricingCoverage,"unavailable");
  assert.equal(calls[0].url.searchParams.get("from"),"2026-08-01T00:00:00.000Z");
});

test("ledger balance validates org and allows negative prepaid/postpaid values", async () => {
  const balance={org_id:org,billing_mode:"postpaid",status:"active",balance_usd:-2,currency:"USD",low_balance_threshold_usd:1,grants:{total_granted_usd:0,total_remaining_usd:0,soonest_expiry:null}};
  const {reads}=harness(()=>({balance}));
  assert.equal((await reads.billing("balance")).data.balance.balance_usd,-2);
  await assert.rejects(reads.billing("balance",{window:"24h"}),/does not accept/);
  const foreign=harness(()=>({balance:{...balance,org_id:"synthetic-foreign-org"}}));
  await assert.rejects(foreign.reads.billing("balance"),/wrong organization/);
});

test("billing summary refuses mismatched bounds and unexpected provider labels", async () => {
  const {reads}=harness(()=>({summary:{org_id:org,from:"2026-08-01T01:00:00Z",to:fixedNow.toISOString(),tokens,metered_requests:0,priced_events:0,estimated_cost_usd:0,blended_price_per_mtok:0}}));
  await assert.rejects(reads.billing("summary",{window:"24h"}),/different billing bounds/);
  const other=harness(()=>({rows:[{provider:"synthetic-private-provider",served_model:"synthetic-model",requests:0,tokens,cost_usd:0}]}));
  await assert.rejects(other.reads.billing("usage-by-model"),/invalid response/);
});

test("project reporting rejects unsupported selection rather than dropping it", async () => {
  const {reads,calls}=harness(()=>({}));
  await assert.rejects(reads.project("providers",{project:project.slug,workload:workload.name}),/project-wide/);
  await assert.rejects(reads.project("providers",{window:"1d"}),/minutes or hours/);
  await assert.rejects(reads.project("cost-breakdown",{from:"2026-08-01",to:"2026-08-02"}),/duration/);
  assert.equal(calls.length,0);
});

test("call cost preserves null unpriced amounts and verifies organization", async () => {
  const data={org_id:org,request_id:"synthetic-canonical-request",ts:fixedNow.toISOString(),project_id:project.id,workload_id:workload.id,provider:"managed",served_model:"synthetic-model",tokens,pricing_status:"unpriced",unpriced_reason:"pricing_pending",customer_cost_usd:null,cost_categories:null,coverage:{source_timestamp:null,data_completeness:0,known_gaps:["Synthetic pending pricing"]},generated_at:fixedNow.toISOString()};
  const {reads,calls}=harness(()=>data);
  const output=await reads.cost("synthetic-correlation");
  assert.equal(output.data.customer_cost_usd,null);
  assert.equal(output.data.request_id,"synthetic-canonical-request");
  assert.match(calls[0].url.pathname,/calls\/synthetic-correlation\/cost$/);
});

test("command adapters pass filtered report and billing input without implicit resource changes", async () => {
  const calls=[],output=[];
  const value={organizationId:org,request:{},data:{}};
  const reads={query:async(...args)=>{calls.push(args);return value;},billing:async(...args)=>{calls.push(args);return value;},project:async(...args)=>{calls.push(args);return value;},cost:async()=>value};
  const program=new Command().option("--json");
  addReportCommands(program,{...reads,output:(line)=>output.push(line)});
  addReportReadCommands(program,reads,(line)=>output.push(line));
  addBillingCommands(program,reads,(line)=>output.push(line));
  await program.parseAsync(["node","understudy","--json","report","usage","--project",project.slug,"--from","2026-08-01","--to","2026-08-01"]);
  assert.equal(calls[0][0],"usage"); assert.equal(calls[0][1].from,"2026-08-01"); assert.equal(calls[0][1].window,undefined);
  assert.deepEqual(JSON.parse(output[0]),value);
});
