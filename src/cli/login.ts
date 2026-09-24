import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ConfigError, loadConfig, projectPaths } from "../config/load.js";
import { closeBrowser, openBrowser, saveAuthState } from "../browser/session.js";

export interface LoginOptions {
  as?: string;
  dir?: string;
}

/** Headed browser + a human + Enter = a saved storageState (brief §P1-T9). */
export async function loginCommand(opts: LoginOptions): Promise<void> {
  const dir = opts.dir ?? process.cwd();
  const cfg = loadConfig(dir);
  const paths = projectPaths(dir);
  const authName = opts.as ?? "default";
  const target = cfg.auth.login_url ?? cfg.base_url;

  const session = await openBrowser(cfg, { dir, authName, headed: true });
  let closedEarly = false;
  session.page.on("close", () => {
    closedEarly = true;
  });

  try {
    await session.page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`Opened ${target}`);
    console.log("Log in in the opened browser, then press Enter here…");

    const rl = readline.createInterface({ input, output });
    try {
      await rl.question("");
    } finally {
      rl.close();
    }

    if (closedEarly || session.page.isClosed()) {
      throw new ConfigError(
        "The browser window was closed before you pressed Enter, so there is no session to save. Run `magpie login` again and leave the window open.",
      );
    }

    const saved = await saveAuthState(session.context, dir, authName);
    const cookies = (await session.context.cookies()).length;
    console.log(`Saved ${cookies} cookie(s) to ${path.relative(paths.dir, saved)}`);
    if (cookies === 0) {
      console.log("Warning: no cookies were captured — check that the login actually completed.");
    }

    const gitignore = path.join(paths.dir, ".gitignore");
    const ignored = fs.existsSync(gitignore) && fs.readFileSync(gitignore, "utf8").includes(".auth/");
    if (!ignored) {
      console.log("Add `.auth/` to your .gitignore — session files are credentials.");
    }
    console.log('Now run: magpie run --charter "..."');
    console.log(
      "If Magpie still reports AUTH_REQUIRED, set auth.probe_url to a page that needs a\n" +
        "session (e.g. probe_url: /dashboard): on apps whose landing page is always the\n" +
        "login form, that page is the only way to tell a live session from a dead one.\n" +
        "base_url stays where it is — only the session check moves.",
    );
  } finally {
    await closeBrowser(session); // discard the trace: it would capture the login

  }
}
