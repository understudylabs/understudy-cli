import { Command } from "commander";
import path from "node:path";
import { formatOutput } from "../output.js";
import { installSkill, installSkills, listSkills } from "../skills/service.js";
import { resolveSkillTarget } from "../skills/targets.js";

export function addSkillsCommands(program: Command): void {
  const skills = program.command("skills")
    .description("List, install, or refresh bundled coding-agent skills locally.");

  skills.command("list")
    .description("List bundled skills, content versions, and file hashes.")
    .action(function (this: Command) {
      const result = listSkills();
      process.stdout.write(`${formatOutput(this, result, [
        `Bundled skills for CLI ${result.cliVersion}`,
        ...result.skills.flatMap(skill => [
          skill.name,
          `  ${skill.description}`,
        ]),
        "Install all: understudy skills install",
        "Choose your coding agent: understudy skills install --harness claude",
        "Harnesses: codex, claude, cursor, opencode. The default is the shared agent skills directory used by Codex.",
      ])}\n`);
    });

  skills.command("install [name]")
    .description("Install or refresh all bundled skills, or one named skill. Replaces edits inside selected bundled skill directories.")
    .option("--harness <harness>", "Install for codex, claude, cursor, or opencode; defaults to shared agent skills (Codex).")
    .option("--directory <agent-skills-root>", "Custom skill root instead of --harness; skill directories are created inside it.")
    .addHelpText("after", `
Examples:
  understudy skills install
  understudy skills install --harness claude
  understudy skills install --harness cursor
  understudy skills install setup-understudy --directory ./agent-skills

Installation is local and needs no login. Start a new agent session afterward
for automatic discovery. In an existing session, agents can read the installed
SKILL.md directly; --json returns each installed entrypoint path.
Run the same command after updating the CLI to refresh the installed skills.
Selected bundled skill directories are replaced, including local edits and stale
files. Unrelated skills, application .understudy data, and credentials are untouched.
`)
    .action(async function (this: Command, name: string | undefined, options: { directory?: string; harness?: string }) {
      const destination = resolveSkillTarget(options);
      const installation = name !== undefined
        ? await installSkill(name, destination.directory)
        : await installSkills(destination.directory);
      const target = {
        ...destination,
        directory: "skills" in installation ? installation.directory : path.dirname(installation.directory),
      };
      const result = "skills" in installation ? { ...installation, target } : installation;
      const installed = "skills" in result ? result.skills : [result];
      const setupSkill = installed.find(skill => skill.name === "setup-understudy");
      process.stdout.write(`${formatOutput(this, result, [
        `Skills for ${target.label}`,
        `Location: ${target.directory}`,
        ...installed.map(skill => `${skill.status === "installed" ? "Installed" : "Already installed"} ${skill.name}`),
        target.reload,
        ...(setupSkill ? [
          `Setup entrypoint: ${setupSkill.entrypoint}`,
          "In the current agent session, read this SKILL.md and its relevant references before starting integration work.",
          'Then ask: "Use setup-understudy to connect this application to Understudy. Ask me to approve the proposed workload names and setup plan before proceeding."',
        ] : []),
      ])}\n`);
    });
}
