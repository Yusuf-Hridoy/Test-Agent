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
  .description("Run an instructed test session, or replay remembered flows")
  .option("--charter <string>", "what the agent should test")
  .option("--regress <slug|all>", "replay remembered flows instead of exploring")
  .option("--include-draft", "with --regress all, also replay draft flows")
  .option("--heal", "let the model relocate a failed step (costs model calls)")
  .option("--json", "with --regress, print suite.json to stdout and logs to stderr")
  .option("--as <name>", "auth profile name", "default")
  .option("--headed", "show the browser window")
  .option("--dir <dir>", "project directory (default: current directory)")
  .action(async (opts) => {
    const { runCommand } = await import("./run.js");
    await runCommand(opts);
  });

const memory = program.command("memory").description("Inspect what Magpie remembers");

memory
  .command("show")
  .description("Pages, flows and sessions this project remembers")
  .option("--dir <dir>", "project directory (default: current directory)")
  .action(async (opts: { dir?: string }) => {
    const { memoryShowCommand } = await import("./memory.js");
    memoryShowCommand(opts);
  });

memory
  .command("stats")
  .description("Database size and totals")
  .option("--dir <dir>", "project directory (default: current directory)")
  .action(async (opts: { dir?: string }) => {
    const { memoryStatsCommand } = await import("./memory.js");
    memoryStatsCommand(opts);
  });

const flows = program.command("flows").description("Work with remembered flows");

flows
  .command("list")
  .description("List remembered flows")
  .option("--dir <dir>", "project directory (default: current directory)")
  .action(async (opts: { dir?: string }) => {
    const { flowsListCommand } = await import("./flows.js");
    flowsListCommand(opts);
  });

flows
  .command("show <slug>")
  .description("Show a flow's steps in replay order")
  .option("--dir <dir>", "project directory (default: current directory)")
  .action(async (slug: string, opts: { dir?: string }) => {
    const { flowsShowCommand } = await import("./flows.js");
    flowsShowCommand(slug, opts);
  });

flows
  .command("rename <slug> <name...>")
  .description("Give a flow a human name")
  .option("--dir <dir>", "project directory (default: current directory)")
  .action(async (slug: string, name: string[], opts: { dir?: string }) => {
    const { flowsRenameCommand } = await import("./flows.js");
    flowsRenameCommand(slug, name.join(" "), opts);
  });

flows
  .command("verify <slug>")
  .description("Prove a flow still runs, and promote it to verified")
  .option("--as <name>", "auth profile name", "default")
  .option("--headed", "show the browser window")
  .option("--dir <dir>", "project directory (default: current directory)")
  .action(async (slug: string, opts: { as?: string; headed?: boolean; dir?: string }) => {
    const { flowsVerifyCommand } = await import("./flows.js");
    await flowsVerifyCommand({ slug, ...opts });
  });

flows
  .command("delete <slug>")
  .description("Forget a flow (its steps go with it)")
  .option("-y, --yes", "do not ask for confirmation")
  .option("--dir <dir>", "project directory (default: current directory)")
  .action(async (slug: string, opts: { yes?: boolean; dir?: string }) => {
    const { flowsDeleteCommand } = await import("./flows.js");
    await flowsDeleteCommand(slug, opts);
  });

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
