import { main } from "../src/deploy.js";

export const MISSING_D1 = { status: 1, stdout: "", stderr: "✘ [ERROR] Couldn't find a D1 DB with the name or binding 'DB'\n" };
export const MISSING_AUTO_D1 = {
  status: 1,
  stdout: "",
  stderr: "✘ [ERROR] Couldn't find an auto-provisioned D1 DB for the binding 'DB'\n",
};
export const MISSING_R2 = { status: 1, stdout: "", stderr: "✘ [ERROR] The specified bucket does not exist. [code: 10006]\n" };
export const OK = { status: 0, stdout: "", stderr: "" };

/**
 * Runs `main` with fakes and records everything.
 * @param {object} options
 * @param {string[]} [options.argv]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {object | (() => any)} [options.config] The configuration, or a function used as readConfig.
 * @param {(args: string[], capture: boolean) => object | undefined} [options.respond] Result of each wrangler call;
 *   undefined means success.
 * @param {string[]} [options.existing] Absolute paths that exist. Defaults to every path.
 * @param {string} [options.cwd]
 */
export async function runMain({ argv = [], env = {}, config = {}, respond = () => undefined, existing, cwd = "/work" } = {}) {
  const calls = [];
  const logs = [];
  const warnings = [];
  const errors = [];
  const stdout = [];
  const stderr = [];
  const checkedPaths = [];
  let readConfigCalls = 0;
  const code = await main({
    argv,
    env,
    readConfig: () => {
      readConfigCalls += 1;
      return typeof config === "function" ? config() : config;
    },
    wrangler: (args, { capture }) => {
      calls.push({ args, capture });
      return { ...OK, ...(respond(args, capture) ?? {}) };
    },
    exists: (absPath) => {
      checkedPaths.push(absPath);
      return existing === undefined ? true : existing.includes(absPath);
    },
    cwd,
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
    error: (message) => errors.push(message),
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
  });
  return {
    code,
    calls,
    commands: calls.map((call) => call.args.join(" ")),
    logs,
    warnings,
    errors,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    checkedPaths,
    readConfigCalls: () => readConfigCalls,
  };
}

export function db(overrides = {}) {
  return { binding: "DB", database_name: "app", migrations_dir: "drizzle/migrations", ...overrides };
}

export function configWith(fields = {}) {
  return { configPath: "/work/wrangler.jsonc", ...fields };
}
