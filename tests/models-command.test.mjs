import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { addModelsCommand } from "../dist/commands/models.js";
import { modelCapabilityGap } from "../dist/models/service.js";

const result = {
  missingCapabilities: [modelCapabilityGap],
  models: [
    {
      id: "synthetic-open-model",
      displayName: "Synthetic Open Model",
      openWeight: true,
    },
    {
      id: "synthetic-hosted-model",
      displayName: "Synthetic Hosted Model",
      openWeight: false,
    },
    {
      id: "synthetic-unknown-model",
      displayName: "Synthetic Unknown Model",
      openWeight: null,
    },
  ],
};

function programFor(modelResult, output) {
  const program = new Command().option("--json");
  addModelsCommand(program, {
    listModels: async () => modelResult,
    showModel: async (id) => ({
      model: modelResult.models.find(model => model.id === id),
      source: modelResult.source ?? "organization_catalog",
      inferenceCapabilities: null,
      missingCapabilities: [modelCapabilityGap],
    }),
    output: (message) => output.push(message),
  });
  return program;
}

test("models list prints a compact human-readable table", async () => {
  const output = [];
  await programFor(result, output).parseAsync([
    "node",
    "understudy",
    "models",
    "list",
  ]);

  assert.match(output[0], /^MODEL\s+NAME\s+OPEN WEIGHT/m);
  assert.match(output[0], /synthetic-open-model\s+Synthetic Open Model\s+yes/);
  assert.match(output[0], /synthetic-hosted-model\s+Synthetic Hosted Model\s+no/);
  assert.match(output[0], /synthetic-unknown-model\s+Synthetic Unknown Model\s+unknown/);
  assert.match(output[0], /Catalog availability does not establish workload compatibility/);
  assert.match(output[0], /Unknown here: endpoint and tool support, context limits/);
  assert.match(output[0], /pricing/);
});

test("gateway flags select the alternate catalog for list and exact show", async () => {
  const calls = [];
  for (const args of [["list", "--gateway"], ["show", "synthetic-model", "--gateway"]]) {
    const program = new Command();
    addModelsCommand(program, {
      listModels: async selection => { calls.push({ command: "list", selection }); return { source: "gateway_catalog", models: [] }; },
      showModel: async (model, selection) => {
        calls.push({ command: "show", model, selection });
        return { source: "gateway_catalog", model: { id: model, displayName: model, openWeight: null, wireShapes: null } };
      },
      output: () => {},
    });
    await program.parseAsync(["node", "understudy", "models", ...args]);
  }
  assert.deepEqual(calls, [
    { command: "list", selection: { gateway: true } },
    { command: "show", model: "synthetic-model", selection: { gateway: true } },
  ]);
});

test("gateway output distinguishes protocol mappings, missing metadata and compatibility", async () => {
  const gatewayResult = { ...result, source: "gateway_catalog", models: result.models.map((model, index) => ({
    ...model, wireShapes: index === 0 ? ["openai-chat", "anthropic-messages"] : index === 1 ? [] : null,
  })) };
  const listOutput = [];
  await programFor(gatewayResult, listOutput).parseAsync(["node", "understudy", "models", "list", "--gateway"]);
  assert.match(listOutput[0], /WIRE SHAPES/);
  assert.match(listOutput[0], /openai-chat, anthropic-messages/);
  assert.match(listOutput[0], /none declared/);
  assert.match(listOutput[0], /unknown/);
  assert.match(listOutput[0], /not current serving health or workload compatibility/);
  for (const json of [false, true]) {
    const output = [];
    await programFor(gatewayResult, output).parseAsync(["node", "understudy", ...(json ? ["--json"] : []), "models", "show", "synthetic-open-model", "--gateway"]);
    if (json) {
      assert.deepEqual(JSON.parse(output[0]).model.wireShapes, ["openai-chat", "anthropic-messages"]);
      assert.equal(JSON.parse(output[0]).source, "gateway_catalog");
    } else {
      assert.match(output[0], /Wire shapes: openai-chat, anthropic-messages/);
      assert.match(output[0], /not current serving health or workload compatibility/);
      assert.doesNotMatch(output[0], /Unknown here: endpoint/);
    }
  }
});

test("models list supports global structured output", async () => {
  const output = [];
  await programFor(result, output).parseAsync([
    "node",
    "understudy",
    "--json",
    "models",
    "list",
  ]);

  assert.deepEqual(JSON.parse(output[0]), result);
  assert.equal(JSON.parse(output[0]).models[2].openWeight, null);
  assert.doesNotMatch(output[0], /--capabilities/);
});

test("models show preserves known and unknown open-weight status and explains catalog limits", async () => {
  for (const [id, label] of [
    ["synthetic-open-model", "yes"],
    ["synthetic-hosted-model", "no"],
    ["synthetic-unknown-model", "unknown"],
  ]) {
    const output = [];
    await programFor(result, output).parseAsync(["node", "understudy", "models", "show", id]);
    assert.match(output[0], new RegExp(`Open weight: ${label}`));
    assert.match(output[0], /Availability: listed in the current organization's catalog/);
    assert.match(output[0], /Unknown here: endpoint and tool support, context limits/);
    assert.match(output[0], /pricing/);
  }
});

test("models show JSON retains unknown values without a fictional discovery command", async () => {
  const output = [];
  await programFor(result, output).parseAsync(["node", "understudy", "--json", "models", "show", "synthetic-unknown-model"]);
  const shown = JSON.parse(output[0]);
  assert.equal(shown.model.openWeight, null);
  assert.equal(shown.inferenceCapabilities, null);
  assert.deepEqual(shown.missingCapabilities, [modelCapabilityGap]);
  assert.doesNotMatch(output[0], /--capabilities/);
});

test("models list explains an empty catalog", async () => {
  const output = [];
  await programFor({ models: [] }, output).parseAsync([
    "node",
    "understudy",
    "models",
    "list",
  ]);

  assert.deepEqual(output, ["No models are currently available."]);
});
