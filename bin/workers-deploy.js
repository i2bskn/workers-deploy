#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { main } from "../src/deploy.js";

// wrangler is resolved from the PATH, which `pnpm run` extends with node_modules/.bin.
function wrangler(args, { capture }) {
  const result = spawnSync("wrangler", args, {
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

// exitCode instead of process.exit(), so that the output written to a pipe is flushed before Node exits. Nothing
// else keeps the event loop alive: every wrangler call is synchronous.
process.exitCode = await main({
    argv: process.argv.slice(2),
    env: process.env,
    // Imported lazily, so that --help and argument errors do not load wrangler.
    readConfig: async () => {
      const { unstable_readConfig } = await import("wrangler");
      return unstable_readConfig({});
    },
    wrangler,
    exists: existsSync,
    cwd: process.cwd(),
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
});
