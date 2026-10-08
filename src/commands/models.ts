import { Command } from "commander";

import { createCredentialStore } from "../auth/credentials.js";
import {
  listModels,
  showModel,
  type ModelDetailResult,
  type ModelListResult,
  type ModelSummary,
  type ModelCatalogSelection,
} from "../models/service.js";
import { formatOutput } from "../output.js";
import { createInferenceCredentialStore } from "../inference/credentials.js";

const catalogLimitations = [
  "Catalog availability does not establish workload compatibility.",
  "Unknown here: endpoint and tool support, context limits, response formats, reasoning parameters, and pricing.",
];
const gatewayCatalogLimitations = [
  "Wire shapes describe active catalog mappings, not current serving health or workload compatibility.",
  "Unknown here: tool support, context limits, response formats, reasoning parameters, and pricing.",
];

export interface ModelsCommandDependencies {
  listModels(selection?: ModelCatalogSelection): Promise<ModelListResult>;
  showModel(model: string, selection?: ModelCatalogSelection): Promise<ModelDetailResult>;
  output(message: string): void;
}

export function createModelsCommandDependencies(): ModelsCommandDependencies {
  const store = createCredentialStore();
  const inferenceStore = createInferenceCredentialStore();
  return {
    listModels: (selection) => listModels({ ...selection, store, inferenceStore }),
    showModel: (model, selection) => showModel({ ...selection, store, inferenceStore }, model),
    output: (message) => process.stdout.write(`${message}\n`),
  };
}

export function addModelsCommand(
  program: Command,
  dependencies: ModelsCommandDependencies = createModelsCommandDependencies(),
): void {
  const models = program
    .command("models")
    .description("Inspect models available through Understudy.");

  models
    .command("list")
    .description("List models available to the current organization.")
    .option("--gateway", "Read public gateway protocol mappings using existing setup credentials; no inference requests.")
    .action(async function (this: Command) {
      const result = await dependencies.listModels(this.opts<ModelCatalogSelection>());
      dependencies.output(formatModels(this, result));
    });

  models.command("show <model>")
    .description("Show known catalog metadata for an exact model id.")
    .option("--gateway", "Read public gateway protocol mappings using existing setup credentials; no inference requests.")
    .action(async function (this: Command, model: string) {
      const result = await dependencies.showModel(model, this.opts<ModelCatalogSelection>());
      const gateway = result.source === "gateway_catalog";
      dependencies.output(formatOutput(this, result, [
        `Model: ${result.model.id}`,
        `Name: ${result.model.displayName}`,
        `Open weight: ${openWeightLabel(result.model.openWeight)}`,
        ...(gateway ? [`Wire shapes: ${wireShapesLabel(result.model.wireShapes)}`] : []),
        `Availability: listed in the ${gateway ? "gateway catalog for the current organization" : "current organization's catalog"}.`,
        ...(gateway ? gatewayCatalogLimitations : catalogLimitations),
      ]));
    });
}

function formatModels(command: Command, result: ModelListResult): string {
  if (result.models.length === 0) {
    return formatOutput(command, result, "No models are currently available.");
  }

  const gateway = result.source === "gateway_catalog";
  return formatOutput(command, result, [...modelTable(result.models, gateway), "", ...(gateway ? gatewayCatalogLimitations : catalogLimitations)]);
}

function openWeightLabel(value: ModelSummary["openWeight"]): string {
  return value === null ? "unknown" : value ? "yes" : "no";
}

function wireShapesLabel(shapes: ModelSummary["wireShapes"]): string {
  return shapes == null ? "unknown" : shapes.length === 0 ? "none declared" : shapes.join(", ");
}

function modelTable(models: readonly ModelSummary[], gateway: boolean): string[] {
  const rows = models.map((model) => [
    model.id,
    model.displayName,
    openWeightLabel(model.openWeight),
    ...(gateway ? [wireShapesLabel(model.wireShapes)] : []),
  ]);
  const headers = ["MODEL", "NAME", "OPEN WEIGHT", ...(gateway ? ["WIRE SHAPES"] : [])];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const formatRow = (row: readonly string[]) =>
    row.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd();

  return [formatRow(headers), ...rows.map(formatRow)];
}
