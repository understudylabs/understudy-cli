import test from "node:test";
import assert from "node:assert/strict";
import { loadToolEnvironment } from "../dist/migrations/tool-environment.js";
import { appendResults } from "../dist/migrations/protocol.js";

// Every contract, value and handler in this file is independently synthetic.
const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
function environment(handler = `({arguments:args,state}) => ({result:{value:args.value},state:{value:args.value}})`, overrides = {}) {
  return `module.exports = {
    schemaVersion:1, version:"synthetic-environment-v1",
    stateSchema:${JSON.stringify(schema)}, initialState:{value:"empty"}, context:{tick:1},
    tools:{store_value:{version:"synthetic-handler-v1",inputSchema:${JSON.stringify(schema)},outputSchema:${JSON.stringify(schema)},handler:${handler}}},
    tests:[{id:"stores-novel-value",steps:[{tool:"store_value",arguments:{value:"independently invented"},expect:{result:{value:"independently invented"},state:{value:"independently invented"}}}]}],
    ...${JSON.stringify(overrides)}
  };`;
}
const load = (source, declared = ["store_value"]) => loadToolEnvironment({ read: async () => Buffer.from(source) }, "synthetic-environment.cjs", declared);

test("offline validation identifies exactly tested, assumed, and unsupported tool coverage", async () => {
  const verified = await load(environment());
  assert.equal(verified.report.valid, true);
  assert.deepEqual(verified.report.tests.map(({passed,reproducible}) => ({passed,reproducible})), [{passed:true,reproducible:true}]);
  assert.equal(verified.report.coverage[0].status, "verified");
  assert.match(verified.report.scope, /explicit contract assertions/);
  const assumed = await load(environment(undefined, {tests:[]}));
  assert.equal(assumed.report.valid, false);
  assert.equal(assumed.report.coverage[0].status, "assumed");
  const missing = await load(environment(), ["store_value", "missing_tool"]);
  assert.equal(missing.report.valid, false);
  assert.equal(missing.report.coverage.find(row => row.name === "missing_tool").status, "unsupported");
  assert.equal(missing.execute("missing_tool", {}, {value:"empty"}, {}, {}).kind, "environment_gap");
});

test("explicit recorded-only declarations support mixed environments without invented handlers", async () => {
  const mixed = await load(environment(undefined, {recordedTools:["read_recorded"]}), ["store_value", "read_recorded"]);
  assert.equal(mixed.report.valid, true);
  const recorded = mixed.report.coverage.find(row => row.name === "read_recorded");
  assert.equal(recorded.mode, "recorded");
  assert.equal(recorded.status, "assumed");
  assert.equal(mixed.execute("read_recorded", {}, {value:"empty"}, {}, {}).kind, "environment_gap");
  for (const recordedTools of [["unknown"], ["read_recorded", "read_recorded"], ["store_value"]]) {
    const invalid = await load(environment(undefined, {recordedTools}), ["store_value", "read_recorded"]);
    assert.equal(invalid.report.valid, false);
    assert.ok(invalid.report.problems.some(problem => problem.includes("Recorded-only")));
  }
  const noSimulation = await load(environment(undefined, {tools:{},recordedTools:["read_recorded"],tests:[]}), ["read_recorded"]);
  assert.equal(noSimulation.report.valid, true);
  const incorrectTest = await load(environment(undefined, {recordedTools:["read_recorded"],tests:[{id:"cannot-simulate-recording",steps:[{tool:"read_recorded",arguments:{},expect:{result:{value:"invented"}}}]}]}), ["store_value", "read_recorded"]);
  assert.equal(incorrectTest.report.valid, false);
});

test("fresh execution realms reset hidden module state and own all inputs and outputs", async () => {
  const source = `let invocations = 0;\n${environment(`({arguments:args,state}) => { invocations++; state.value=args.value; args.value="handler mutation"; return {result:{value:String(invocations)},state}; }`, {tests:[]})}`;
  const loaded = await load(source), state = {value:"empty"}, args = {value:"first"};
  const first = loaded.execute("store_value", args, state, {}, {});
  assert.equal(first.kind, "success");
  assert.deepEqual(first.result, {value:"1"});
  assert.deepEqual(first.stateAfter, {value:"first"});
  assert.deepEqual(args, {value:"first"});
  assert.deepEqual(state, {value:"empty"});
  first.stateAfter.value = "external mutation";
  const second = loaded.execute("store_value", {value:"second"}, state, {}, {});
  assert.deepEqual(second.result, {value:"1"});
  assert.deepEqual(second.stateBefore, {value:"empty"});
  assert.deepEqual(second.stateAfter, {value:"second"});
});

test("duplicate argument keys and supported contract violations are tool rejections", async () => {
  const loaded = await load(environment());
  for (const args of ['{"value":"first","value":"second"}', {value:7}, {value:"text",extra:true}]) {
    const transition = loaded.execute("store_value", args, {value:"empty"}, {}, {});
    assert.equal(transition.kind, "tool_rejection");
    assert.equal(transition.code, "invalid_tool_arguments");
    assert.deepEqual(transition.stateAfter, {value:"empty"});
  }
});

test("unsupported schemas and malformed metadata produce inspectable environment gaps", async () => {
  const unsupported = await load(environment().replace(`inputSchema:${JSON.stringify(schema)}`, 'inputSchema:{$ref:"https://schema.example/remote"}'));
  assert.equal(unsupported.report.valid, false);
  assert.equal(unsupported.report.coverage[0].status, "unsupported");
  assert.equal(unsupported.execute("store_value", {value:"valid"}, {value:"empty"}, {}, {}).kind, "environment_gap");
  const malformed = await load("module.exports = {schemaVersion:2};");
  assert.equal(malformed.report.valid, false);
  assert.ok(malformed.report.problems.length > 0);
});

test("invalid output, promises, ambient randomness and nonserializable values are environment gaps", async () => {
  for (const handler of [
    `({state}) => ({result:{value:1},state})`,
    `async ({state}) => ({result:{value:"async"},state})`,
    `({state}) => ({result:{value:String(Math.random())},state})`,
    `({state}) => ({result:{value:String(Date.now())},state})`,
    `({state}) => ({result:{value:"valid",hidden:undefined},state})`,
    `({state}) => ({result:{value:"valid"},state:new Map()})`,
    `({state}) => ({get result(){return {value:"valid"}},state})`,
  ]) {
    const loaded = await load(environment(handler));
    assert.equal(loaded.report.valid, false);
    const transition = loaded.execute("store_value", {value:"valid"}, {value:"empty"}, {}, {});
    assert.equal(transition.kind, "environment_gap");
    assert.deepEqual(transition.stateAfter, {value:"empty"});
  }
});

test("declared failure outputs are validated and mutations cannot commit on failure", async () => {
  const source = environment(`({state}) => {state.value="uncommitted";return {failure:"synthetic_failure",result:{message:"invented failure"}};}`, {tests:[]})
    .replace('handler:({state})', 'failures:{synthetic_failure:{type:"object",properties:{message:{type:"string"}},required:["message"],additionalProperties:false}},handler:({state})');
  const loaded = await load(source);
  const transition = loaded.execute("store_value", {value:"valid"}, {value:"empty"}, {}, {});
  assert.equal(transition.kind, "application_failure");
  assert.equal(transition.code, "synthetic_failure");
  assert.deepEqual(transition.stateAfter, {value:"empty"});
  const undeclared = await load(environment(`({state}) => ({failure:"undeclared",result:{value:"failure"}})`, {tests:[]}));
  assert.equal(undeclared.execute("store_value", {value:"valid"}, {value:"empty"}, {}, {}).code, "invalid_simulated_failure");
});

test("version changes change identity and malformed or duplicate contract tests fail validation", async () => {
  const first = await load(environment()), second = await load(environment().replace("synthetic-handler-v1", "synthetic-handler-v2"));
  assert.notEqual(first.digest, second.digest);
  assert.equal(second.execute("store_value", {value:"valid"}, {value:"empty"}, {}, {}).handlerVersion, "synthetic-handler-v2");
  const step = {tool:"store_value",arguments:{value:"written"},expect:{state:{value:"wrong"}}};
  const wrong = await load(environment(undefined, {tests:[{id:"incorrect-state",steps:[step]}]}));
  assert.equal(wrong.report.valid, false);
  assert.equal(wrong.report.tests[0].passed, false);
  const duplicate = await load(environment(undefined, {tests:[{id:"duplicate",steps:[step]},{id:"duplicate",steps:[step]}]}));
  assert.equal(duplicate.report.valid, false);
  assert.match(duplicate.report.tests[1].message, /reuses a test id/);
});

test("environment gaps cannot be appended as model-visible tool responses in any protocol", () => {
  for (const protocol of ["chat", "messages", "responses"]) {
    for (const output of [
      {id:"synthetic-gap",provenance:"environment_gap"},
      {id:"synthetic-gap",provenance:"environment_gap",result:{error:"not a model error"}},
      {id:"synthetic-gap",isError:true},
      {id:"synthetic-gap",isError:true,result:undefined},
    ]) {
      assert.throws(() => appendResults({}, protocol, {}, [output]), error => error.code === "tool_environment_gap");
    }
  }
});
