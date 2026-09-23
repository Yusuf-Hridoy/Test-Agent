#!/usr/bin/env node
import { Command } from "commander";
import { MAGPIE_VERSION } from "../version.js";

const program = new Command();

program
  .name("magpie")
  .description("The testing agent that remembers your app.")
  .version(MAGPIE_VERSION, "-v, --version");

program
  .command("init")
  .description("Create a Magpie test project in the current directory")
  .option("--name <name>", "project name")
  .option("--url <url>", "base URL of the application under test")
  .option("--dir <dir>", "target directory (default: current directory)")
  .action(async (opts) => {
    const { initCommand } = await import("./init.js");
    await initCommand(opts);
  });

program
  .command("login")
  .description("Open a browser, log in by hand, and save the session")
  .option("--as <name>", "auth profile name", "default")
  .option("--dir <dir>", "project directory (default: current directory)")
  .action(async (opts) => {
    const { loginCommand } = await import("./login.js");
    await loginCommand(opts);
  });

program
  .command("run")
  .description("Run an instructed test session against the application")
  .requiredOption("--charter <string>", "what the agent should test")
  .option("--as <name>", "auth profile name", "default")
  .option("--headed", "show the browser window")
  .option("--dir <dir>", "project directory (default: current directory)")
  .action(async (opts) => {
    const { runCommand } = await import("./run.js");
    await runCommand(opts);
  });

const flows = program.command("flows").description("Work with remembered flows");

flows
  .command("replay <slug>")
  .description("Replay a remembered flow deterministically — no model calls")
  .option("--as <name>", "auth profile name", "default")
  .option("--headed", "show the browser window")
  .option("--dir <dir>", "project directory (default: current directory)")
  .action(async (slug: string, opts: { as?: string; headed?: boolean; dir?: string }) => {
    const { flowsReplayCommand } = await import("./flows.js");
    await flowsReplayCommand({ slug, ...opts });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(3);
});
