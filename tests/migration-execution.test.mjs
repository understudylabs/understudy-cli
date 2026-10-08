// All capture data is invented. These tests verify primitives, not model quality.
import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {createMigrationService} from "../dist/migrations/service.js";
import {createInferenceCredentialStore} from "../dist/inference/credentials.js";
import {MigrationStorage, digest} from "../dist/migrations/storage.js";
import {canonical} from "../dist/migrations/interactions.js";
import {appendResults, compileSchema, decodeCandidate} from "../dist/migrations/protocol.js";

const org="synthetic-org", project="synthetic-project", workload="synthetic-workload", model="synthetic-open-model";
const tool={name:"read_tile", input_schema:{type:"object",properties:{tile:{type:"integer"}},required:["tile"],additionalProperties:false}};
const user={role:"user",content:"Read the two invented tiles."};
const request={model:"synthetic-incumbent",system:"Use recorded tile information.",messages:[user],tools:[tool],max_tokens:300};
function response(content,stop_reason="end_turn"){return {type:"message",role:"assistant",content,stop_reason};}
const call=(tile,id="synthetic-call")=>({type:"tool_use",id,name:tool.name,input:{tile}});
const action={role:"assistant",content:[call(2,"synthetic-original-call")]};
const result=response([{type:"text",text:"violet and gold"}]);
function live(body, effective=model){return new Response(JSON.stringify(body),{headers:{"x-understudy-request-id":"synthetic-served-request","x-understudy-effective-model":effective,"x-understudy-environment":"test"}});}
async function setup(t, handler=async()=>live(result), extra={}, catalogModels=[{id:model,is_open_weight:true}]){
 const home=await mkdtemp(path.join(tmpdir(),"synthetic-harness-")); t.after(()=>rm(home,{recursive:true,force:true}));
 const claims=Buffer.from(JSON.stringify({org_id:org,exp:Date.now()/1000+3600})).toString("base64url");
 const calls=[], checks=[];
 const service=createMigrationService({cwd:home,store:{read:async()=>({version:1,method:"oauth",accessToken:`synthetic.${claims}.signature`}),write:async()=>{},clear:async()=>{}},baseUrl:"https://example.test",
  credential:async()=>({organizationId:org,apiKey:"fake",inferenceUrl:"https://example.test"}),...extra,
  fetchImplementation:async(url,init)=>{
   const u=String(url); checks.push({u,authorization:init.headers.authorization});
   if(u.endsWith("/projects"))return Response.json({projects:[{id:project,org_id:org,slug:project,name:"Synthetic project"}],cursor:null});
   if(u.endsWith("/workloads"))return Response.json({workloads:[{id:workload,project_id:project,name:workload,capture_enabled:true}]});
   if(u.endsWith("/models"))return Response.json({models:catalogModels});
   assert.ok(["/v1/messages","/v1/chat/completions","/v1/responses"].some(endpoint=>u===`https://example.test${endpoint}`)); calls.push(JSON.parse(init.body)); return handler(calls.length,init,u);
  }});
 const run=await service.init({runId:"synthetic-run",project,workload});
 const storage=new MigrationStorage(home), directory=path.join(home,".understudy","input"); await mkdir(directory,{mode:0o700});
 const action={role:"assistant",content:[call(2,"original-two"),call(3,"original-three")]};
 const captures=[{request_id:"synthetic-first",request_body:request,response_body:response(action.content,"tool_use")},
  {request_id:"synthetic-last",parent_request_id:"synthetic-first",request_body:{...request,messages:[user,action,{role:"user",content:[{type:"tool_result",tool_use_id:"original-two",content:"violet"},{type:"tool_result",tool_use_id:"original-three",content:"gold"}]}]},response_body:result}];
 const rows=[];
 for(const [i,capture]of captures.entries()){
  const bytes=JSON.stringify({...capture,endpoint:"/v1/messages",workos_org_id:org,project_id:project,workload_id:workload,trace_id:"synthetic-trace",ts:`2020-01-01T01:0${i}:00Z`});
  const file=`capture-${i}.jsonl`; await storage.write(path.join(directory,file),bytes); rows.push({file,request_id:capture.request_id,size:Buffer.byteLength(bytes),content_sha256:digest(bytes)});
 }
 const index=path.join(directory,"index.jsonl"); await storage.write(index,rows.map(row=>JSON.stringify(row)).join("\n"));
 await service.import(run.runId,index); await service.prepareCaptures(run.runId);
 const harness=path.join(directory,"harness.cjs");
 const writeHarness=async fn=>storage.write(harness,`module.exports = ${fn.toString()};\n`);
 await writeHarness(async function(api){
  const taskId=api.taskIds[0], source=await api.task(taskId); let body=source.requests[0].body;
  body.reasoning_effort="synthetic-level";
  for(let step=0;step<8;step++){
   const out=await api.request({id:`model-${step}`,taskId,protocol:"messages",body});
   if(out.terminal)return {answer:out.text};
   const results=await Promise.all(out.calls.map((call,i)=>api.mockTool({id:`tool-${step}-${i}`,caseId:"case-one",taskId,turnId:source.requests[0].turnId,call})));
   body=api.appendToolResults(body,"messages",out.response,results);
  }
  return {unresolved:true};
 });
 const input={id:"synthetic-replay",harness,model,maxCalls:8,maxOutputTokens:100};
 return {service,run,storage,home,directory,calls,checks,input,writeHarness,readJournal:async result=>storage.json(result.artifact)};
}

test("an agent harness makes two tool calls and its own continuation without a phase plan",async t=>{
 const c=await setup(t,async(n,init)=>{assert.equal(init.headers["x-understudy-environment"],"test");return live(n<3?response([call(n+1,`candidate-${n}`)],"tool_use"):result);});
 const run=await c.service.replay(c.run.runId,c.input), journal=await c.readJournal(run);
 assert.equal(run.status,"recorded"); assert.equal(run.requestEnvironment,"test"); assert.equal(journal.identity.requestEnvironment,"test"); assert.equal(run.modelCalls,3); assert.equal(run.harnessResult.answer,"violet and gold");
 assert.deepEqual(journal.entries.filter(e=>e.kind==="tool").map(e=>e.output.result),["violet","gold"]);
 assert.equal(c.calls[1].messages.at(-2).content[0].id,"candidate-1"); assert.equal(c.calls[2].messages.at(-1).content[0].content,"gold");
 assert.ok(c.calls.every(body=>body.model===model&&body.max_tokens===100&&body.reasoning_effort==="synthetic-level"));
 assert.ok(journal.entries.filter(e=>e.kind==="model").every(e=>e.input.requestEnvironment==="test"&&e.output.requestEnvironment==="test"));
 assert.equal(Object.hasOwn(run,"passed"),false); assert.equal(Object.hasOwn(journal,"review"),false);
 const again=await c.service.replay(c.run.runId,c.input); assert.equal(again.modelCalls,3); assert.equal(c.calls.length,3);
 assert.equal(JSON.stringify(journal).includes("fake"),false);
});

test("replay accepts catalog models regardless of their open-weight label",async t=>{
 for(const entry of [{id:model,is_open_weight:false},{id:model}]){
  const c=await setup(t,undefined,{},[entry]);
  const run=await c.service.replay(c.run.runId,c.input);
  assert.equal(run.status,"recorded"); assert.equal(run.modelCalls,1);
  assert.equal(c.calls[0].model,model); assert.equal(run.harnessResult.answer,"violet and gold");
 }
});

test("all replay protocols keep the same scope and expose the verified test environment", async t => {
 const c = await setup(t, async (_n, init, url) => {
  assert.equal(init.headers["x-understudy-environment"], "test");
  assert.equal(init.headers["x-understudy-project"], project);
  assert.equal(init.headers["x-understudy-workload"], workload);
  const body = url.endsWith("/messages") ? result : url.endsWith("/chat/completions")
   ? { choices: [{ message: { role: "assistant", content: "violet and gold" }, finish_reason: "stop" }] }
   : { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "violet and gold" }] }] };
  return live(body);
 });
 await c.writeHarness(async function(api) {
  const receipts = [];
  for (const protocol of ["messages", "chat", "responses"]) {
   const body = protocol === "responses" ? { input: "Read the invented tiles." } : { messages: [{ role: "user", content: "Read the invented tiles." }] };
   const out = await api.request({ id: protocol, taskId: api.taskIds[0], protocol, body });
   receipts.push({ environment: out.receipt.requestEnvironment, terminal: out.terminal, text: out.text });
  }
  return receipts;
 });
 const run = await c.service.replay(c.run.runId, c.input);
 assert.equal(run.status, "recorded");
 assert.equal(c.calls.length, 3);
 assert.deepEqual((await c.readJournal(run)).harnessResult, Array(3).fill({ environment: "test", terminal: true, text: "violet and gold" }));
});

test("missing or different environment echoes stop replay and retain HTTP evidence", async t => {
 for (const environment of [null, "production", "beta", "TEST", "test, test"]) {
  for (const status of [200, 503]) {
   const c = await setup(t, async () => {
    const res = live(result);
    if (environment === null) res.headers.delete("x-understudy-environment");
    else res.headers.set("x-understudy-environment", environment);
    return new Response(res.body, { status, headers: res.headers });
   });
   const run = await c.service.replay(c.run.runId, c.input), journal = await c.readJournal(run);
   assert.equal(run.status, "stopped");
   assert.equal(run.stop.code, "unverified_request_environment");
   assert.equal(journal.entries[0].state, "recorded");
   assert.equal(journal.entries[0].input.requestEnvironment, "test");
   assert.equal(journal.entries[0].output.requestEnvironment, environment);
   assert.equal(journal.entries[0].output.status, status);
   assert.equal(journal.entries[0].output.raw, JSON.stringify(result));
   const again = await c.service.replay(c.run.runId, c.input);
   assert.equal(again.stop.code, "unverified_request_environment");
   assert.equal(c.calls.length, 1);
  }
 }
});

test("a caught environment error still blocks queued and later model requests", async t => {
 const c = await setup(t, async () => {
  const res = live(result); res.headers.set("x-understudy-environment", "production"); return res;
 });
 await c.writeHarness(async function(api) {
  const body = (await api.task(api.taskIds[0])).requests[0].body;
  await Promise.allSettled([0, 1].map(i => api.request({ id: `parallel-${i}`, taskId: api.taskIds[0], protocol: "messages", body })));
  try { await api.request({ id: "later", taskId: api.taskIds[0], protocol: "messages", body }); } catch {}
  return { ignoredError: true };
 });
 const run = await c.service.replay(c.run.runId, c.input);
 assert.equal(run.status, "stopped");
 assert.equal(run.stop.code, "unverified_request_environment");
 assert.equal(c.calls.length, 1);
 const journal = await c.readJournal(run);
 delete journal.stop;
 await c.storage.writeJson(run.artifact, journal);
 assert.equal((await c.service.replay(c.run.runId, c.input)).stop.code, "unverified_request_environment");
 assert.equal(c.calls.length, 1);
});

test("legacy or differently labeled journals cannot mix with test replay", async t => {
 for (const environment of [undefined, "production"]) {
  const c = await setup(t), run = await c.service.replay(c.run.runId, c.input);
  const journal = await c.readJournal(run);
  if (environment === undefined) {
   delete journal.identity.requestEnvironment;
   for (const entry of journal.entries) {
    delete entry.input.requestEnvironment; delete entry.output.requestEnvironment;
    entry.inputDigest = digest(canonical(entry.input)); entry.outputDigest = digest(canonical(entry.output));
   }
  } else journal.identity.requestEnvironment = environment;
  await c.storage.writeJson(run.artifact, journal);
  const before = await c.storage.read(run.artifact);
  await assert.rejects(c.service.replay(c.run.runId, c.input), /request environment.*new replay id/);
  assert.equal(c.calls.length, 1);
  assert.deepEqual(await c.storage.read(run.artifact), before);
  const fresh = await c.service.replay(c.run.runId, { ...c.input, id: "synthetic-new-replay" });
  assert.equal(fresh.status, "recorded"); assert.equal(fresh.requestEnvironment, "test");
  assert.equal(c.calls.length, 2);
  assert.deepEqual(await c.storage.read(run.artifact), before);
 }
});

test("replay rejects models absent from the catalog before sending inference",async t=>{
 for(const entries of [[],[{id:"synthetic-other-model",is_open_weight:true}]]){
  const c=await setup(t,undefined,{},entries);
  await assert.rejects(c.service.replay(c.run.runId,c.input),/Select an available catalog model/);
  assert.equal(c.calls.length,0);
 }
});

test("project replay reads global credentials and ignores a project credential file",async t=>{
 const globalHome=await mkdtemp(path.join(tmpdir(),"synthetic-global-credential-"));
 t.after(()=>rm(globalHome,{recursive:true,force:true}));
 await createInferenceCredentialStore({directory:path.join(globalHome,".understudy")}).write({version:1,organizationId:org,keyId:"synthetic-key",apiKey:"fake",inferenceUrl:"https://example.test"});
 const c=await setup(t,async(n,init)=>{assert.equal(init.headers["x-api-key"],"fake");return live(result);},{credential:undefined,environment:{}});
 await c.storage.writeJson(path.join(c.storage.root,"gateway-credential.json"),{synthetic:"project credentials must not be read"});
 const previous=process.env.HOME;process.env.HOME=globalHome;
 try {
  const run=await c.service.replay(c.run.runId,c.input);
  assert.equal(run.harnessResult.answer,"violet and gold");
  assert.doesNotMatch(JSON.stringify(await c.readJournal(run)),/fake/);
 } finally {if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;}
});

test("new journals preserve exact partial matches and stop unmatched calls as environment gaps",async t=>{
 const c=await setup(t,async()=>live(response([call(2,"first"),call(4,"missing")],"tool_use")));
 const run=await c.service.replay(c.run.runId,c.input), journal=await c.readJournal(run), entries=journal.entries.filter(e=>e.kind==="tool");
 assert.equal(journal.schemaVersion,2);
 assert.equal(run.status,"stopped"); assert.equal(run.stop.code,"recorded_result_unavailable");
 assert.equal(run.harnessResult,null); assert.equal(c.calls.length,1);
 assert.equal(entries.length,2); assert.equal(entries[0].output.result,"violet"); assert.equal(entries[0].output.provenance,"recorded");
 assert.equal(entries[1].output.provenance,"environment_gap"); assert.equal(Object.hasOwn(entries[1].output,"result"),false);
 assert.doesNotMatch(JSON.stringify(entries[1].output),/correct.*call|correct.*arguments/i);
 const again=await c.service.replay(c.run.runId,c.input);
 assert.equal(again.stop.code,"recorded_result_unavailable"); assert.equal(c.calls.length,1);
 assert.deepEqual((await c.readJournal(again)).entries,journal.entries);
});

test("invalid schema arguments and unknown tools receive recoverable errors",async t=>{
 const c=await setup(t,async n=>live(n===1?response([call("2","invalid"),{...call(2,"unknown"),name:"unrecorded_tool"}],"tool_use"):n===2?response([call(2,"fixed")],"tool_use"):result));
 const run=await c.service.replay(c.run.runId,c.input), tools=(await c.readJournal(run)).entries.filter(e=>e.kind==="tool");
 assert.deepEqual(tools.slice(0,2).map(e=>e.output.result.error.code),["invalid_tool_arguments","unexpected_tool_call"]);
 assert.equal(tools[2].output.result,"violet");
});

test("application argument bindings preserve both the candidate and effective call",async t=>{
 const c=await setup(t);
 await c.writeHarness(async function(api){const taskId=api.taskIds[0];return api.mockTool({id:"bound",caseId:"case",taskId,turnId:"turn-1",call:{id:"candidate",name:"read_tile",arguments:{}},effectiveArguments:{tile:2}});});
 const run=await c.service.replay(c.run.runId,c.input), entry=(await c.readJournal(run)).entries[0];
 assert.equal(c.calls.length,0); assert.deepEqual(entry.input.call.arguments,{}); assert.deepEqual(entry.input.effectiveArguments,{tile:2}); assert.equal(entry.output.result,"violet");
});

test("unknown inference outcomes stay pending and cannot be automatically retried",async t=>{
 const c=await setup(t,async()=>{throw new TypeError("Synthetic connection drop");});
 const run=await c.service.replay(c.run.runId,c.input); assert.equal(run.stop.code,"inference_outcome_unknown");
 const again=await c.service.replay(c.run.runId,c.input); assert.equal(again.stop.code,"inference_outcome_unknown"); assert.equal(c.calls.length,1);
});

test("the model-call budget holds across parallel requests and resume",async t=>{
 const c=await setup(t);
 await c.writeHarness(async function(api){const taskId=api.taskIds[0],body=(await api.task(taskId)).requests[0].body;return Promise.all([0,1].map(i=>api.request({id:`request-${i}`,taskId,protocol:"messages",body})));});
 c.input.maxCalls=1;
 const run=await c.service.replay(c.run.runId,c.input); assert.equal(run.stop.code,"call_budget_exhausted"); assert.equal(c.calls.length,1);
 await c.service.replay(c.run.runId,c.input); assert.equal(c.calls.length,1);
});

test("HTTP and model provenance problems are recorded without a task verdict",async t=>{
 for(const [server,code]of [[async()=>new Response("Synthetic unavailable",{status:503,headers:{"x-understudy-environment":"test"}}),"inference_http_503"],[async()=>live(result,"synthetic-other-model"),"unverified_model_provenance"]]){
  const c=await setup(t,server),run=await c.service.replay(c.run.runId,c.input); assert.equal(run.stop.code,code); assert.equal(run.status,"stopped");
  const again=await c.service.replay(c.run.runId,c.input); assert.equal(again.modelCalls,1); assert.equal(c.calls.length,1);
 }
});

test("a changed harness or journal cannot reuse old model receipts",async t=>{
 const c=await setup(t),run=await c.service.replay(c.run.runId,c.input);
 const original=await c.storage.read(c.input.harness); await c.storage.write(c.input.harness,Buffer.concat([original,Buffer.from("\n// Changed harness\n")]));
 await assert.rejects(()=>c.service.replay(c.run.runId,c.input),/does not match/);
 await c.storage.write(c.input.harness,original);
 const journal=await c.readJournal(run); journal.entries[0].output.raw="changed"; await c.storage.writeJson(run.artifact,journal);
 await assert.rejects(()=>c.service.replay(c.run.runId,c.input),/journal has changed/); assert.equal(c.calls.length,1);
});

test("limits and private harness paths are checked before inference",async t=>{
 const c=await setup(t);
 for(const input of [{...c.input,maxCalls:0},{...c.input,maxOutputTokens:Infinity},{...c.input,harness:path.join(c.home,"outside.cjs")}]) await assert.rejects(()=>c.service.replay(c.run.runId,input),/limits|private state/);
 assert.equal(c.calls.length,0);
});

test("an exported inference key is verified against the selected scope and never journaled",async t=>{
 const c=await setup(t,async()=>live(result),{credential:undefined,environment:{UNDERSTUDY_API_KEY:"sk_synthetic_scope_probe"}});
 const run=await c.service.replay(c.run.runId,c.input);
 assert.ok(c.checks.some(item=>item.u.endsWith("/projects")&&item.authorization==="Bearer sk_synthetic_scope_probe"));
 assert.doesNotMatch(JSON.stringify(await c.readJournal(run)),/sk_synthetic_scope_probe/);
});
test("native tool-result content arrays retain their structure across supported protocols", () => {
  const content = [{ type: "text", text: "An independently invented tile description." }];
  const result = [{ id: "synthetic-candidate-call", result: content, isError: false }];
  const messages = appendResults(request, "messages", response(action.content, "tool_use"), result);
  assert.deepEqual(messages.messages.at(-1).content[0].content, content);
  const chat = appendResults({ messages: [user] }, "chat", { choices: [{ message: { role: "assistant", content: null } }] }, result);
  assert.deepEqual(chat.messages.at(-1).content, content);
  const fileOutput = [{ type: "input_file", file_id: "synthetic-file-reference" }];
  const responses = appendResults({ input: "Inspect the invented tile." }, "responses", { output: [] }, [{ ...result[0], result: fileOutput }]);
  assert.deepEqual(responses.input.at(-1).output, fileOutput);
  const error = appendResults(request, "messages", response(action.content, "tool_use"), [{ ...result[0], result: { error: { code: "invalid_tool_arguments" } }, isError: true }]);
  assert.equal(error.messages.at(-1).content[0].content, '{"error":{"code":"invalid_tool_arguments"}}');
});
test("Responses continuation remains serializable without an incumbent response reference", () => {
  const next = appendResults({ input: "Read the invented tile." }, "responses", { output: [{ type: "function_call", call_id: "synthetic-response-call", name: tool.name, arguments: '{"tile":2}' }] }, [{ id: "synthetic-response-call", result: "violet", isError: false }]);
  assert.equal("previous_response_id" in next, false); assert.doesNotThrow(() => canonical(next));
});
test("asynchronous schemas cannot masquerade as successful synchronous validation", () => {
  assert.throws(() => compileSchema({ $async: true, type: "number" }), /supported self-contained JSON Schema/);
});
test("Messages streaming preserves thinking, signatures, and usage without leaking parser fields into continuation", () => {
  const events = [
    { type: "message_start", message: { id: "synthetic-message", usage: { input_tokens: 11, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Consider the invented tile." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "synthetic-signature" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "synthetic-call", name: tool.name, input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"tile":2}' } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 17 } },
    { type: "message_stop" },
  ];
  const decoded = decodeCandidate(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), "messages");
  const next = appendResults(request, "messages", decoded.response, [{ id: "synthetic-call", result: "violet", isError: false }]);
  assert.equal(next.messages.at(-2).content[0].thinking, "Consider the invented tile.");
  assert.equal(next.messages.at(-2).content[0].signature, "synthetic-signature");
  assert.equal("partial" in next.messages.at(-2).content[1], false);
  assert.deepEqual(decoded.response.usage, { input_tokens: 11, output_tokens: 17 });
});

async function syntheticLegacyJournal(t) {
 const c=await setup(t,async n=>live(n===1?response([call(2,"first"),call(4,"missing")],"tool_use"):n===2?response([call(2,"repeat"),call(3,"recovered")],"tool_use"):result));
 const first=await c.service.replay(c.run.runId,c.input), current=await c.readJournal(first);
 // Construct a wholly synthetic v1 artifact explicitly. Production code must
 // neither convert existing journals nor reinterpret their historical outputs.
 const identity=Object.fromEntries(["runId","sourceDigest","taskDigest","harnessDigest","model","maxCalls","maxOutputTokens","target","requestEnvironment"].map(key=>[key,current.identity[key]]));
 const entries=current.entries.map(entry=>{
  if(entry.kind!=="tool")return structuredClone(entry);
  const output=entry.output.provenance==="environment_gap"
   ? {id:"missing",isError:true,fixtureKey:null,result:{error:{code:"recorded_result_unavailable",source:"replay",retryable:true,message:"Synthetic historical replay could not find this result."}}}
   : {id:entry.output.id,isError:entry.output.isError,fixtureKey:entry.output.fixtureKey,result:entry.output.result};
  return {...entry,output,outputDigest:digest(canonical(output))};
 });
 const journal={schemaVersion:1,id:current.id,identity,calls:current.calls,entries};
 await c.storage.writeJson(first.artifact,journal);
 return {...c,artifact:first.artifact,legacy:journal};
}

test("unchanged v1 replay preserves historical unavailable errors and consumed exact matches",async t=>{
 const c=await syntheticLegacyJournal(t), historical=c.legacy.entries.find(entry=>entry.id==="tool-0-1");
 const run=await c.service.replay(c.run.runId,c.input), journal=await c.readJournal(run), tools=journal.entries.filter(entry=>entry.kind==="tool");
 assert.equal(run.status,"recorded"); assert.equal(journal.schemaVersion,1); assert.equal(run.modelCalls,3);
 assert.equal(c.calls.length,3); assert.equal(run.harnessResult.answer,"violet and gold");
 assert.deepEqual(tools.map(entry=>entry.output.isError),[false,true,true,false]);
 assert.equal(tools[0].output.result,"violet"); assert.equal(tools[3].output.result,"gold");
 assert.equal(tools[2].output.result.error.code,"recorded_result_unavailable");
 assert.deepEqual(tools[1],historical);
 assert.equal(c.calls[1].messages.at(-1).content[1].is_error,true);
 assert.match(c.calls[1].messages.at(-1).content[1].content,/Synthetic historical replay/);
 const again=await c.service.replay(c.run.runId,c.input);
 assert.equal(again.status,"recorded"); assert.equal(c.calls.length,3);
 assert.deepEqual((await c.readJournal(again)).entries,journal.entries);
});

test("v1 journals reject simulation, offline mode, and new tool limits without rewriting evidence",async t=>{
 const c=await syntheticLegacyJournal(t), before=await c.storage.read(c.artifact);
 for(const input of [
  {...c.input,environment:path.join(c.directory,"synthetic-unused-environment.cjs")},
  {id:c.input.id,harness:c.input.harness,offline:true},
  {...c.input,maxToolCalls:5},
 ]) {
  await assert.rejects(c.service.replay(c.run.runId,input),/does not match.*new replay id/);
  assert.deepEqual(await c.storage.read(c.artifact),before);
 }
 assert.equal(c.calls.length,1);
});

test("damaged v1 journals are rejected rather than repaired or resent",async t=>{
 const c=await syntheticLegacyJournal(t);
 for(const field of ["input","output"]) {
  const journal=structuredClone(c.legacy);
  if(field==="input")journal.entries[0].input.body.messages.push({role:"user",content:"Synthetic damaged historical input."});
  else journal.entries[1].output.result="Synthetic damaged historical result.";
  await c.storage.writeJson(c.artifact,journal);
  const before=await c.storage.read(c.artifact);
  await assert.rejects(c.service.replay(c.run.runId,c.input),/journal has changed/);
  assert.deepEqual(await c.storage.read(c.artifact),before);
  assert.equal(c.calls.length,1);
 }
});

test("caught unknown inference outcomes block queued tools, clear completion claims, and never resend",async t=>{
 const c=await setup(t,async()=>{throw new TypeError("Synthetic interrupted inference connection.");});
 await c.writeHarness(async function(api){
  const taskId=api.taskIds[0],source=await api.task(taskId);
  const tool={caseId:"case",taskId,turnId:source.requests[0].turnId,call:{id:"candidate",name:"read_tile",arguments:{tile:2}}};
  await Promise.allSettled([
   api.request({id:"pending",taskId,protocol:"messages",body:source.requests[0].body}),
   api.mockTool({...tool,id:"queued-tool"}),
  ]);
  try{await api.mockTool({...tool,id:"later-tool"});}catch{}
  return {claimedComplete:true};
 });
 const run=await c.service.replay(c.run.runId,c.input), journal=await c.readJournal(run);
 assert.equal(run.status,"stopped"); assert.equal(run.stop.code,"inference_outcome_unknown"); assert.equal(run.harnessResult,null);
 assert.equal(journal.entries.length,1); assert.equal(journal.entries[0].kind,"model"); assert.equal(journal.entries[0].state,"pending");
 const again=await c.service.replay(c.run.runId,c.input);
 assert.equal(again.stop.code,"inference_outcome_unknown"); assert.equal(again.harnessResult,null); assert.equal(c.calls.length,1);
 assert.deepEqual((await c.readJournal(again)).entries,journal.entries);
});

test("mutating the caller conversation while transport is awaiting a response cannot alter sent or saved evidence",async t=>{
 const originalClone=globalThis.structuredClone;
 let callerBody,mutatedWhileAwaiting=false;
 // Capture only the harness's deliberately marked clone so the synthetic server
 // can mutate the caller-owned object after transport begins and before replying.
 globalThis.structuredClone=value=>{
  const copied=originalClone(value);
  if(value?.metadata?.syntheticAwaitMutation===true)callerBody=copied;
  return copied;
 };
 t.after(()=>{globalThis.structuredClone=originalClone;});
 const c=await setup(t,async(_number,init)=>{
  assert.ok(callerBody);
  const transmitted=JSON.parse(init.body);
  assert.equal(transmitted.messages[0].content[0].text,"Synthetic original in-flight request.");
  callerBody.messages[0].content[0].text="Synthetic mutation during the awaited response.";
  callerBody.messages.push({role:"assistant",content:"Synthetic later conversation turn."});
  callerBody.metadata.labels.push("mutated-in-flight");
  mutatedWhileAwaiting=true;
  await new Promise(resolve=>setImmediate(resolve));
  return live(result);
 });
 await c.writeHarness(async function(api){
  const body=structuredClone({messages:[{role:"user",content:[{type:"text",text:"Synthetic original in-flight request."}]}],metadata:{syntheticAwaitMutation:true,labels:["original"]}});
  const out=await api.request({id:"in-flight",taskId:api.taskIds[0],protocol:"messages",body});
  return {requestDigest:out.receipt.requestDigest};
 });
 const run=await c.service.replay(c.run.runId,c.input),journal=await c.readJournal(run),entry=journal.entries[0];
 assert.equal(run.status,"recorded"); assert.equal(mutatedWhileAwaiting,true);
 assert.equal(callerBody.messages.length,2);
 assert.equal(entry.input.body.messages.length,1);
 assert.equal(entry.input.body.messages[0].content[0].text,"Synthetic original in-flight request.");
 assert.deepEqual(entry.input.body.metadata.labels,["original"]);
 assert.deepEqual(entry.input.body,c.calls[0]);
 assert.equal(entry.inputDigest,digest(canonical(entry.input)));
 assert.equal(run.harnessResult.requestDigest,digest(canonical(c.calls[0])));
 const again=await c.service.replay(c.run.runId,c.input);
 assert.equal(again.status,"recorded"); assert.equal(c.calls.length,1);
 assert.deepEqual((await c.readJournal(again)).entries,journal.entries);
});
