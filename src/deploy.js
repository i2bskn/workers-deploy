// `workers-deploy`: creates the missing D1 databases and R2 buckets in the requested location, applies the D1
// migrations, then deploys the Worker.
//
// The Deploy to Cloudflare button and Workers Builds run this command as the deploy command (`pnpm run deploy`), so it
// must also work on the very first deploy. `wrangler d1 migrations apply` only looks up an existing database, while
// `wrangler deploy` creates the missing D1 databases, KV namespaces, R2 buckets and queues. So when a database does not
// exist yet, this command deploys first and applies the migrations right after. In that case the new Worker runs
// without tables for a few seconds, which is harmless because nobody uses it yet. With --require-existing-databases,
// a missing database is an error instead, so that `wrangler deploy` never creates a new, empty one.
//
// On later deploys the migrations are applied before `wrangler deploy`, so that new code never runs against missing
// tables.
//
// `wrangler deploy` creates D1 databases and R2 buckets without a location, so they end up near the build
// environment. When the LOCATION_HINT environment variable is set (a Workers Builds build variable), this command
// creates the missing ones in that location first, and `wrangler deploy` then connects to them by name. The location
// of an existing database or bucket cannot be changed, so existing ones are left as they are.
//
// When the CUSTOM_DOMAINS environment variable is set (a Workers Builds build variable; hostnames separated by commas
// or spaces), the hostnames are passed to `wrangler deploy --domains`, which attaches them as Custom Domains. Wrangler
// replaces the Worker's Custom Domains with the ones in the configuration's routes and --domains together, so every
// Custom Domain of the Worker must be listed in one of them.
//
// The bindings are read from the Wrangler configuration (top level only, not `env.*`), so this command does not
// depend on the names used by a project.
//
// Every side effect is injected, so that this module can be imported and tested without wrangler.
import path from "node:path";

export const USAGE = "Usage: workers-deploy [--require-existing-databases]";

const HELP = `${USAGE}

Environment variables:
  LOCATION_HINT   Location of the D1 databases and R2 buckets to create: weur, eeur, apac, oc, wnam or enam.
  CUSTOM_DOMAINS  Hostnames passed to wrangler deploy --domains, separated by commas or spaces.
`;

const REQUIRE_EXISTING_DATABASES = "--require-existing-databases";
const LOCATIONS = ["weur", "eeur", "apac", "oc", "wnam", "enam"];
const MISSING_DATABASE = /Couldn't find (a|an auto-provisioned) D1 DB/;
const MISSING_BUCKET = "[code: 10006]";
// The default of `migrations_dir` in wrangler.
const DEFAULT_MIGRATIONS_DIR = "./migrations";
// Hostnames only: Custom Domains take no scheme, path, port or wildcard.
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Stops the deploy with an exit code. Thrown from deep inside and caught by `main`.
class Exit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function output(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/**
 * Parses the command line arguments.
 * @param {string[]} argv
 * @returns {{ help: true } | { help: false, requireExistingDatabases: boolean } | { error: string }}
 */
export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }
  let requireExistingDatabases = false;
  for (const arg of argv) {
    if (arg === REQUIRE_EXISTING_DATABASES) {
      requireExistingDatabases = true;
    } else {
      return { error: `Unknown argument "${arg}". ${USAGE}` };
    }
  }
  return { help: false, requireExistingDatabases };
}

/**
 * Reads LOCATION_HINT.
 * @returns {{ location: string | undefined } | { error: string }}
 */
export function parseLocation(value) {
  const location = (value ?? "").trim().toLowerCase() || undefined;
  if (location !== undefined && !LOCATIONS.includes(location)) {
    return { error: `Invalid LOCATION_HINT "${value}": expected one of ${LOCATIONS.join(", ")}.` };
  }
  return { location };
}

/**
 * Reads CUSTOM_DOMAINS, rejecting the former name CUSTOM_DOMAIN.
 * @returns {{ domains: string[] } | { error: string }}
 */
export function parseDomains(env) {
  if ((env.CUSTOM_DOMAIN ?? "").trim() !== "") {
    return {
      error:
        "CUSTOM_DOMAIN is no longer read: rename the variable to CUSTOM_DOMAINS (hostnames separated by commas or spaces).",
    };
  }
  const domains = [];
  for (const entry of (env.CUSTOM_DOMAINS ?? "").split(/[\s,]+/)) {
    const domain = entry.trim().toLowerCase();
    if (domain === "" || domains.includes(domain)) {
      continue;
    }
    if (!HOSTNAME.test(domain)) {
      return {
        error: `Invalid CUSTOM_DOMAINS entry "${domain}": expected hostnames such as app.example.com, separated by commas or spaces.`,
      };
    }
    domains.push(domain);
  }
  return { domains };
}

/**
 * Runs the deploy and resolves to the exit code. Never calls `process.exit`.
 * @param {object} deps
 * @param {string[]} deps.argv
 * @param {Record<string, string | undefined>} deps.env
 * @param {() => any} deps.readConfig Returns (or resolves to) the Wrangler configuration.
 * @param {(args: string[], options: { capture: boolean }) => { status: number | null, stdout?: string, stderr?: string }} deps.wrangler
 * @param {(absPath: string) => boolean} deps.exists
 * @param {string} deps.cwd
 * @param {(message: string) => void} deps.log
 * @param {(message: string) => void} deps.warn
 * @param {(message: string) => void} deps.error
 * @param {(text: string) => void} deps.writeStdout
 * @param {(text: string) => void} deps.writeStderr
 * @returns {Promise<number>}
 */
export async function main(deps) {
  try {
    return await deploy(deps);
  } catch (e) {
    if (e instanceof Exit) {
      return e.code;
    }
    throw e;
  }
}

async function deploy({ argv, env, readConfig, wrangler, exists, cwd, log, warn, error, writeStdout, writeStderr }) {
  const args = parseArgs(argv);
  if ("error" in args) {
    error(args.error);
    return 1;
  }
  if (args.help) {
    writeStdout(HELP);
    return 0;
  }

  const parsedLocation = parseLocation(env.LOCATION_HINT);
  if ("error" in parsedLocation) {
    error(parsedLocation.error);
    return 1;
  }
  const { location } = parsedLocation;

  const parsedDomains = parseDomains(env);
  if ("error" in parsedDomains) {
    error(parsedDomains.error);
    return 1;
  }
  const { domains } = parsedDomains;

  // Runs wrangler with inherited stdio, and stops on failure.
  function run(wranglerArgs) {
    const { status } = wrangler(wranglerArgs, { capture: false });
    if (status !== 0) {
      throw new Exit(status ?? 1);
    }
  }

  // Prints the captured output of a failed wrangler command and stops with its status.
  function fail(result) {
    writeStdout(result.stdout ?? "");
    writeStderr(result.stderr ?? "");
    throw new Exit(result.status ?? 1);
  }

  const config = await readConfig();
  const configDir = config.configPath ? path.dirname(config.configPath) : cwd;
  const databases = config.d1_databases ?? [];
  const buckets = config.r2_buckets ?? [];

  // Whether each D1 database exists, by binding.
  const databaseExists = new Map();
  for (const db of databases) {
    if (!db.database_name && !db.database_id) {
      // `d1 info` fails with a different error for a binding without a name or an ID, and such a database
      // can only be created by `wrangler deploy`.
      databaseExists.set(db.binding, false);
      continue;
    }
    // `d1 info` fails with the same lookup error as `d1 migrations apply` but never prompts, so its output
    // can be captured safely.
    const info = wrangler(["d1", "info", db.binding], { capture: true });
    if (info.status === 0) {
      databaseExists.set(db.binding, true);
    } else if (MISSING_DATABASE.test(output(info))) {
      databaseExists.set(db.binding, false);
    } else {
      fail(info);
    }
  }

  if (args.requireExistingDatabases) {
    const absent = databases.filter((db) => !databaseExists.get(db.binding));
    if (absent.length > 0) {
      for (const db of absent) {
        error(
          `The D1 database for "${db.binding}" does not exist. Nothing was deployed: with ${REQUIRE_EXISTING_DATABASES}, ` +
            "a missing database is an error so that wrangler deploy does not create a new, empty one.",
        );
      }
      return 1;
    }
  }

  if (location === undefined) {
    log("LOCATION_HINT is not set: wrangler deploy creates the missing resources near the build environment.");
  } else {
    // Failures stop the deploy: LOCATION_HINT is an explicit request, so creating the resources elsewhere
    // without notice would be worse than failing.
    // --no-update-config keeps wrangler from offering to add another binding to the configuration when run locally.
    for (const db of databases) {
      if (databaseExists.get(db.binding)) {
        log(`The D1 database for "${db.binding}" already exists: leaving it as is.`);
      } else if (!db.database_name) {
        log(
          `The D1 database for "${db.binding}" has no database_name, so its location cannot be specified: leaving it to wrangler deploy.`,
        );
      } else if (db.database_id) {
        log(
          `The D1 database for "${db.binding}" has a database_id, so it is not created here: leaving it to wrangler deploy.`,
        );
      } else {
        log(`Creating D1 database "${db.database_name}" in ${location}.`);
        run(["d1", "create", db.database_name, "--location", location, "--no-update-config"]);
        databaseExists.set(db.binding, true);
      }
    }

    for (const bucket of buckets) {
      if (!bucket.bucket_name || bucket.jurisdiction) {
        const reason = bucket.jurisdiction ? "has a jurisdiction" : "has no bucket_name";
        log(
          `The R2 bucket for "${bucket.binding}" ${reason}, so its location cannot be specified: leaving it to wrangler deploy.`,
        );
        continue;
      }
      const info = wrangler(["r2", "bucket", "info", bucket.bucket_name], { capture: true });
      if (info.status === 0) {
        log(`The R2 bucket "${bucket.bucket_name}" already exists: leaving it as is.`);
        continue;
      }
      if (!output(info).includes(MISSING_BUCKET)) {
        fail(info);
      }
      log(`Creating R2 bucket "${bucket.bucket_name}" in ${location}.`);
      run(["r2", "bucket", "create", bucket.bucket_name, "--location", location, "--no-update-config"]);

      // The location hint only applies to the first bucket ever created with a name, so check where it ended up.
      const created = wrangler(["r2", "bucket", "info", bucket.bucket_name], { capture: true });
      const actual = created.status === 0 ? /^\s*location:\s*(\S+)/m.exec(output(created))?.[1] : undefined;
      log(`The R2 bucket "${bucket.bucket_name}" is located in ${actual ?? "(unknown)"}.`);
      if (actual?.toLowerCase() !== location) {
        warn(
          `Warning: the R2 bucket "${bucket.bucket_name}" was requested in ${location} but is located in ${actual ?? "(unknown)"}. ` +
            "The location hint may have been ignored because a bucket with the same name existed before.",
        );
      }
    }
  }

  // `d1 migrations apply` fails when the migrations directory does not exist.
  const migrated = databases.filter((db) => {
    const dir = path.resolve(configDir, db.migrations_dir ?? DEFAULT_MIGRATIONS_DIR);
    if (exists(dir)) {
      return true;
    }
    log(`The D1 database for "${db.binding}" has no migrations directory: skipping its migrations.`);
    return false;
  });

  function migrate() {
    for (const db of migrated) {
      log(`Applying the migrations of the D1 database for "${db.binding}".`);
      run(["d1", "migrations", "apply", db.binding, "--remote"]);
    }
  }

  function deployWorker() {
    if (domains.length === 0) {
      log("Deploying the Worker. CUSTOM_DOMAINS is not set: no Custom Domains are passed to wrangler deploy.");
      run(["deploy"]);
      return;
    }
    log(`Deploying the Worker with the Custom Domains ${domains.join(", ")}.`);
    run(["deploy", ...domains.flatMap((domain) => ["--domains", domain])]);
  }

  const missing = migrated.filter((db) => !databaseExists.get(db.binding));
  if (missing.length === 0) {
    migrate();
    deployWorker();
  } else {
    for (const db of missing) {
      log(`The D1 database for "${db.binding}" does not exist yet: deploying first to create it.`);
    }
    deployWorker();
    migrate();
  }
  return 0;
}
