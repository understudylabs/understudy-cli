import type { Command } from "commander";

const terminalControlPattern =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
const rawJsonTerminalControlPattern =
  /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;

export function sanitizeTerminalText(value: string): string {
  return value.replace(terminalControlPattern, "?");
}

export function stringifyJsonOutput(value: unknown): string {
  return JSON.stringify(value).replace(
    rawJsonTerminalControlPattern,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function isJsonOutput(command: Command): boolean {
  return command.optsWithGlobals<{ json?: boolean }>().json === true;
}

export function formatOutput(
  command: Command,
  data: unknown,
  human: string | readonly string[],
): string {
  if (isJsonOutput(command)) return stringifyJsonOutput(data);
  const lines = typeof human === "string" ? [human] : human;
  return lines.map(sanitizeTerminalText).join("\n");
}
