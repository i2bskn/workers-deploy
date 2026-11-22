import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configWith, db, MISSING_AUTO_D1, MISSING_D1, MISSING_R2, runMain } from "./helpers.js";

const MIGRATE = "d1 migrations apply DB --remote";

function respondTo(table) {
  return (args) => {
    const command = args.join(" ");
    for (const [prefix, result] of table) {
      if (command === prefix || command.startsWith(`${prefix} `)) {
        return typeof result === "function" ? result() : result;
      }
    }
    return undefined;
  };
}

describe("D1 existence and order", () => {
  it("migrates then deploys when the database exists (1)", async () => {
    const r = await runMain({ config: configWith({ d1_databases: [db()] }) });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["d1 info DB", MIGRATE, "deploy"]);
    assert.deepEqual(
      r.calls.map((c) => c.capture),
      [true, false, false],
    );
    assert.ok(r.logs.includes("LOCATION_HINT is not set: wrangler deploy creates the missing resources near the build environment."));
  });

  it("deploys first when the database is missing (2)", async () => {
    const r = await runMain({
      config: configWith({ d1_databases: [db()] }),
      respond: respondTo([["d1 info", MISSING_D1]]),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["d1 info DB", "deploy", MIGRATE]);
    assert.ok(r.logs.includes('The D1 database for "DB" does not exist yet: deploying first to create it.'));
  });

  it("treats the auto-provisioned lookup error as missing (3)", async () => {
    const r = await runMain({
      config: configWith({ d1_databases: [db()] }),
      respond: respondTo([["d1 info", { ...MISSING_AUTO_D1, stdout: MISSING_AUTO_D1.stderr, stderr: "" }]]),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["d1 info DB", "deploy", MIGRATE]);
  });

  it("treats a database without name and id as missing without d1 info (4)", async () => {
    const r = await runMain({ config: configWith({ d1_databases: [{ binding: "DB" }] }) });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["deploy", MIGRATE]);
  });

  it("writes the output of an unexpected d1 info failure and stops (5, 26)", async () => {
    const r = await runMain({
      config: configWith({ d1_databases: [db()] }),
      respond: respondTo([["d1 info", { status: 7, stdout: "out text\n", stderr: "Authentication error [code: 10000]\n" }]]),
    });
    assert.equal(r.code, 7);
    assert.deepEqual(r.commands, ["d1 info DB"]);
    assert.equal(r.stdout, "out text\n");
    assert.equal(r.stderr, "Authentication error [code: 10000]\n");
  });

  it("returns 1 when an unexpected d1 info failure has no status", async () => {
    const r = await runMain({
      config: configWith({ d1_databases: [db()] }),
      respond: respondTo([["d1 info", { status: null, stdout: "", stderr: "killed" }]]),
    });
    assert.equal(r.code, 1);
    assert.deepEqual(r.commands, ["d1 info DB"]);
  });

  it("only deploys when d1_databases is not defined (19)", async () => {
    const r = await runMain({ config: configWith({}) });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["deploy"]);
  });

  it("deploys first and migrates every database with migrations when existing and missing are mixed (20)", async () => {
    const r = await runMain({
      config: configWith({
        d1_databases: [db({ binding: "A", database_name: "a" }), db({ binding: "B", database_name: "b" })],
      }),
      respond: respondTo([["d1 info B", MISSING_D1]]),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, [
      "d1 info A",
      "d1 info B",
      "deploy",
      "d1 migrations apply A --remote",
      "d1 migrations apply B --remote",
    ]);
  });
});

describe("LOCATION_HINT", () => {
  for (const value of ["apac", " APAC "]) {
    it(`creates a missing D1 database in the location (${JSON.stringify(value)}) then migrates first (6)`, async () => {
      const r = await runMain({
        env: { LOCATION_HINT: value },
        config: configWith({ d1_databases: [db()] }),
        respond: respondTo([["d1 info", MISSING_D1]]),
      });
      assert.equal(r.code, 0);
      assert.deepEqual(r.commands, [
        "d1 info DB",
        "d1 create app --location apac --no-update-config",
        MIGRATE,
        "deploy",
      ]);
    });
  }

  it("does not create a database with a database_id or without a database_name (7)", async () => {
    const r = await runMain({
      env: { LOCATION_HINT: "weur" },
      config: configWith({
        d1_databases: [
          db({ binding: "A", database_name: "a", database_id: "0000" }),
          db({ binding: "B", database_name: undefined, database_id: "1111" }),
        ],
      }),
      respond: respondTo([["d1 info", MISSING_D1]]),
    });
    assert.equal(r.code, 0);
    assert.ok(!r.commands.some((c) => c.startsWith("d1 create")));
    assert.deepEqual(r.commands, [
      "d1 info A",
      "d1 info B",
      "deploy",
      "d1 migrations apply A --remote",
      "d1 migrations apply B --remote",
    ]);
  });

  it("leaves an existing database as is", async () => {
    const r = await runMain({ env: { LOCATION_HINT: "weur" }, config: configWith({ d1_databases: [db()] }) });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["d1 info DB", MIGRATE, "deploy"]);
    assert.ok(r.logs.includes('The D1 database for "DB" already exists: leaving it as is.'));
  });

  it("rejects an invalid value without calling anything (10, 27)", async () => {
    const r = await runMain({ env: { LOCATION_HINT: "xyz" }, config: configWith({ d1_databases: [db()] }) });
    assert.equal(r.code, 1);
    assert.deepEqual(r.calls, []);
    assert.equal(r.readConfigCalls(), 0);
    assert.deepEqual(r.errors, ['Invalid LOCATION_HINT "xyz": expected one of weur, eeur, apac, oc, wnam, enam.']);
  });

  it("treats a blank value as not set (24)", async () => {
    const r = await runMain({ env: { LOCATION_HINT: "  " }, config: configWith({ d1_databases: [db()] }) });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["d1 info DB", MIGRATE, "deploy"]);
    assert.ok(r.logs.some((l) => l.startsWith("LOCATION_HINT is not set")));
  });
});

describe("R2 buckets", () => {
  it("does not look up buckets without bucket_name or with a jurisdiction (8)", async () => {
    const r = await runMain({
      env: { LOCATION_HINT: "apac" },
      config: configWith({
        r2_buckets: [{ binding: "A" }, { binding: "B", bucket_name: "b", jurisdiction: "eu" }],
      }),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["deploy"]);
  });

  it("does not look up buckets when LOCATION_HINT is not set", async () => {
    const r = await runMain({ config: configWith({ r2_buckets: [{ binding: "A", bucket_name: "a" }] }) });
    assert.deepEqual(r.commands, ["deploy"]);
  });

  it("leaves an existing bucket as is (8)", async () => {
    const r = await runMain({
      env: { LOCATION_HINT: "apac" },
      config: configWith({ r2_buckets: [{ binding: "A", bucket_name: "a" }] }),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["r2 bucket info a", "deploy"]);
  });

  it("creates a missing bucket and warns when it ended up elsewhere (8)", async () => {
    let infos = 0;
    const r = await runMain({
      env: { LOCATION_HINT: "apac" },
      config: configWith({ r2_buckets: [{ binding: "A", bucket_name: "a" }] }),
      respond: respondTo([
        [
          "r2 bucket info",
          () => {
            infos += 1;
            return infos === 1 ? MISSING_R2 : { status: 0, stdout: "name: a\nlocation: WNAM\n", stderr: "" };
          },
        ],
      ]),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, [
      "r2 bucket info a",
      "r2 bucket create a --location apac --no-update-config",
      "r2 bucket info a",
      "deploy",
    ]);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /requested in apac but is located in WNAM/);
  });

  it("does not warn when the created bucket is in the requested location", async () => {
    let infos = 0;
    const r = await runMain({
      env: { LOCATION_HINT: "apac" },
      config: configWith({ r2_buckets: [{ binding: "A", bucket_name: "a" }] }),
      respond: respondTo([
        [
          "r2 bucket info",
          () => {
            infos += 1;
            return infos === 1 ? MISSING_R2 : { status: 0, stdout: "location: APAC\n", stderr: "" };
          },
        ],
      ]),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.warnings, []);
  });

  it("writes the output of an unexpected r2 bucket info failure and stops (9, 26)", async () => {
    const r = await runMain({
      env: { LOCATION_HINT: "apac" },
      config: configWith({ d1_databases: [db()], r2_buckets: [{ binding: "A", bucket_name: "a" }] }),
      respond: respondTo([["r2 bucket info", { status: 3, stdout: "r2 out\n", stderr: "R2 is not enabled\n" }]]),
    });
    assert.equal(r.code, 3);
    assert.deepEqual(r.commands, ["d1 info DB", "r2 bucket info a"]);
    assert.equal(r.stdout, "r2 out\n");
    assert.equal(r.stderr, "R2 is not enabled\n");
  });

  it("stops when r2 bucket create fails (22)", async () => {
    const r = await runMain({
      env: { LOCATION_HINT: "apac" },
      config: configWith({ d1_databases: [db()], r2_buckets: [{ binding: "A", bucket_name: "a" }] }),
      respond: respondTo([
        ["r2 bucket info", MISSING_R2],
        ["r2 bucket create", { status: 4 }],
      ]),
    });
    assert.equal(r.code, 4);
    assert.deepEqual(r.commands, ["d1 info DB", "r2 bucket info a", "r2 bucket create a --location apac --no-update-config"]);
  });

  it("warns with (unknown) and continues when the second info fails (23)", async () => {
    let infos = 0;
    const r = await runMain({
      env: { LOCATION_HINT: "apac" },
      config: configWith({ d1_databases: [db()], r2_buckets: [{ binding: "A", bucket_name: "a" }] }),
      respond: respondTo([
        [
          "r2 bucket info",
          () => {
            infos += 1;
            return infos === 1 ? MISSING_R2 : { status: 1, stdout: "", stderr: "network error" };
          },
        ],
      ]),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, [
      "d1 info DB",
      "r2 bucket info a",
      "r2 bucket create a --location apac --no-update-config",
      "r2 bucket info a",
      MIGRATE,
      "deploy",
    ]);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /is located in \(unknown\)/);
  });
});

describe("CUSTOM_DOMAINS", () => {
  it("passes normalized, deduplicated hostnames to deploy (11, 28)", async () => {
    const r = await runMain({
      env: { CUSTOM_DOMAINS: "A.example.com, b.example.com c.example.com,a.example.com" },
      config: configWith({}),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, [
      "deploy --domains a.example.com --domains b.example.com --domains c.example.com",
    ]);
    assert.ok(r.logs.includes("Deploying the Worker with the Custom Domains a.example.com, b.example.com, c.example.com."));
  });

  it("logs the neutral message without domains (28)", async () => {
    const r = await runMain({ config: configWith({}) });
    assert.ok(
      r.logs.includes("Deploying the Worker. CUSTOM_DOMAINS is not set: no Custom Domains are passed to wrangler deploy."),
    );
  });

  for (const value of ["https://a.example.com", "*.example.com", "localhost", "a.example.com:8443", "a.example.com/x"]) {
    it(`rejects ${value} without calling anything (12, 27)`, async () => {
      const r = await runMain({ env: { CUSTOM_DOMAINS: `ok.example.com,${value}` }, config: configWith({}) });
      assert.equal(r.code, 1);
      assert.deepEqual(r.calls, []);
      assert.equal(r.readConfigCalls(), 0);
      assert.deepEqual(r.errors, [
        `Invalid CUSTOM_DOMAINS entry "${value}": expected hostnames such as app.example.com, separated by commas or spaces.`,
      ]);
    });
  }

  it("treats separators only as not set (24)", async () => {
    const r = await runMain({ env: { CUSTOM_DOMAINS: " , " }, config: configWith({}) });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["deploy"]);
  });

  const legacyMessage =
    "CUSTOM_DOMAIN is no longer read: rename the variable to CUSTOM_DOMAINS (hostnames separated by commas or spaces).";

  it("rejects the former CUSTOM_DOMAIN (13, 27)", async () => {
    const r = await runMain({ env: { CUSTOM_DOMAIN: "a.example.com" }, config: configWith({}) });
    assert.equal(r.code, 1);
    assert.deepEqual(r.calls, []);
    assert.equal(r.readConfigCalls(), 0);
    assert.deepEqual(r.errors, [legacyMessage]);
  });

  it("rejects CUSTOM_DOMAIN together with CUSTOM_DOMAINS (13)", async () => {
    const r = await runMain({
      env: { CUSTOM_DOMAIN: "a.example.com", CUSTOM_DOMAINS: "a.example.com" },
      config: configWith({}),
    });
    assert.equal(r.code, 1);
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.errors, [legacyMessage]);
  });

  for (const value of ["", "  "]) {
    it(`ignores CUSTOM_DOMAIN=${JSON.stringify(value)} (13, 24)`, async () => {
      const r = await runMain({ env: { CUSTOM_DOMAIN: value }, config: configWith({}) });
      assert.equal(r.code, 0);
      assert.deepEqual(r.commands, ["deploy"]);
    });
  }
});

describe("--require-existing-databases", () => {
  const argv = ["--require-existing-databases"];

  it("deploys as usual when the database exists (14)", async () => {
    const r = await runMain({ argv, config: configWith({ d1_databases: [db()] }) });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["d1 info DB", MIGRATE, "deploy"]);
  });

  it("stops without calling anything but d1 info when the database is missing (14)", async () => {
    const r = await runMain({
      argv,
      env: { LOCATION_HINT: "apac" },
      config: configWith({ d1_databases: [db()], r2_buckets: [{ binding: "A", bucket_name: "a" }] }),
      respond: respondTo([["d1 info", MISSING_D1]]),
    });
    assert.equal(r.code, 1);
    assert.deepEqual(r.commands, ["d1 info DB"]);
    assert.deepEqual(r.errors, [
      'The D1 database for "DB" does not exist. Nothing was deployed: with --require-existing-databases, a missing database is an error so that wrangler deploy does not create a new, empty one.',
    ]);
  });

  it("still creates a missing R2 bucket with LOCATION_HINT (14)", async () => {
    let infos = 0;
    const r = await runMain({
      argv,
      env: { LOCATION_HINT: "apac" },
      config: configWith({ d1_databases: [db()], r2_buckets: [{ binding: "A", bucket_name: "a" }] }),
      respond: respondTo([
        [
          "r2 bucket info",
          () => {
            infos += 1;
            return infos === 1 ? MISSING_R2 : { status: 0, stdout: "location: apac\n", stderr: "" };
          },
        ],
      ]),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, [
      "d1 info DB",
      "r2 bucket info a",
      "r2 bucket create a --location apac --no-update-config",
      "r2 bucket info a",
      MIGRATE,
      "deploy",
    ]);
  });

  it("reports every missing database, including one without name and id (21)", async () => {
    const r = await runMain({
      argv,
      config: configWith({
        d1_databases: [
          db({ binding: "A", database_name: "a" }),
          { binding: "B" },
          db({ binding: "C", database_name: "c" }),
        ],
      }),
      respond: respondTo([["d1 info A", MISSING_D1]]),
    });
    assert.equal(r.code, 1);
    assert.deepEqual(r.commands, ["d1 info A", "d1 info C"]);
    assert.equal(r.errors.length, 2);
    assert.match(r.errors[0], /^The D1 database for "A" does not exist\./);
    assert.match(r.errors[1], /^The D1 database for "B" does not exist\./);
  });

  it("only deploys when d1_databases is not defined (25)", async () => {
    const r = await runMain({ argv, config: configWith({}) });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["deploy"]);
  });
});

describe("migrations directory", () => {
  it("skips a database without a migrations directory, and does not deploy first for it (15)", async () => {
    const r = await runMain({
      config: configWith({ d1_databases: [db()] }),
      existing: [],
      respond: respondTo([["d1 info", MISSING_D1]]),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["d1 info DB", "deploy"]);
    assert.ok(r.logs.includes('The D1 database for "DB" has no migrations directory: skipping its migrations.'));
  });

  it("resolves migrations_dir against the configuration directory", async () => {
    const r = await runMain({
      config: { configPath: "/repo/app/wrangler.jsonc", d1_databases: [db()] },
      existing: ["/repo/app/drizzle/migrations"],
    });
    assert.deepEqual(r.checkedPaths, ["/repo/app/drizzle/migrations"]);
    assert.deepEqual(r.commands, ["d1 info DB", MIGRATE, "deploy"]);
  });

  it("defaults to ./migrations next to the configuration (16)", async () => {
    const r = await runMain({
      config: { configPath: "/repo/app/wrangler.jsonc", d1_databases: [db({ migrations_dir: undefined })] },
    });
    assert.deepEqual(r.checkedPaths, ["/repo/app/migrations"]);
  });

  it("defaults to ./migrations in cwd without a configPath (16)", async () => {
    const r = await runMain({
      cwd: "/somewhere",
      config: { d1_databases: [db({ migrations_dir: undefined })] },
    });
    assert.deepEqual(r.checkedPaths, ["/somewhere/migrations"]);
  });
});

describe("wrangler failures (17)", () => {
  const cases = [
    { name: "migrations apply", table: [[MIGRATE, { status: 5 }]], code: 5, commands: ["d1 info DB", MIGRATE] },
    { name: "deploy", table: [["deploy", { status: 6 }]], code: 6, commands: ["d1 info DB", MIGRATE, "deploy"] },
    { name: "deploy with null status", table: [["deploy", { status: null }]], code: 1, commands: ["d1 info DB", MIGRATE, "deploy"] },
  ];
  for (const c of cases) {
    it(`stops when ${c.name} fails`, async () => {
      const r = await runMain({ config: configWith({ d1_databases: [db()] }), respond: respondTo(c.table) });
      assert.equal(r.code, c.code);
      assert.deepEqual(r.commands, c.commands);
    });
  }

  it("stops when deploy fails before the migrations of a missing database", async () => {
    const r = await runMain({
      config: configWith({ d1_databases: [db()] }),
      respond: respondTo([
        ["d1 info", MISSING_D1],
        ["deploy", { status: 2 }],
      ]),
    });
    assert.equal(r.code, 2);
    assert.deepEqual(r.commands, ["d1 info DB", "deploy"]);
  });

  it("stops when d1 create fails", async () => {
    const r = await runMain({
      env: { LOCATION_HINT: "apac" },
      config: configWith({ d1_databases: [db()] }),
      respond: respondTo([
        ["d1 info", MISSING_D1],
        ["d1 create", { status: null }],
      ]),
    });
    assert.equal(r.code, 1);
    assert.deepEqual(r.commands, ["d1 info DB", "d1 create app --location apac --no-update-config"]);
  });
});

describe("arguments (18, 27)", () => {
  for (const arg of ["--foo", "--require-existing-databases=true"]) {
    it(`rejects ${arg}`, async () => {
      const r = await runMain({ argv: [arg], config: configWith({ d1_databases: [db()] }) });
      assert.equal(r.code, 1);
      assert.deepEqual(r.calls, []);
      assert.equal(r.readConfigCalls(), 0);
      assert.deepEqual(r.errors, [`Unknown argument "${arg}". Usage: workers-deploy [--require-existing-databases] [--keep-vars]`]);
    });
  }

  for (const argv of [["--help"], ["-h"], ["--foo", "-h"], ["--require-existing-databases", "--help"]]) {
    it(`prints the usage for ${argv.join(" ")}`, async () => {
      const r = await runMain({
        argv,
        env: { LOCATION_HINT: "xyz", CUSTOM_DOMAIN: "a.example.com" },
        config: configWith({ d1_databases: [db()] }),
      });
      assert.equal(r.code, 0);
      assert.deepEqual(r.calls, []);
      assert.equal(r.readConfigCalls(), 0);
      assert.match(r.stdout, /^Usage: workers-deploy \[--require-existing-databases\] \[--keep-vars\]\n/);
      assert.match(r.stdout, /LOCATION_HINT/);
      assert.match(r.stdout, /CUSTOM_DOMAINS/);
      assert.deepEqual(r.errors, []);
    });
  }

  it("accepts a repeated flag", async () => {
    const r = await runMain({
      argv: ["--require-existing-databases", "--require-existing-databases"],
      config: configWith({ d1_databases: [db()] }),
      respond: respondTo([["d1 info", MISSING_D1]]),
    });
    assert.equal(r.code, 1);
    assert.deepEqual(r.commands, ["d1 info DB"]);
    assert.equal(r.errors.length, 1);
  });
});

describe("--keep-vars", () => {
  const argv = ["--keep-vars"];

  it("passes --keep-vars to deploy only", async () => {
    const r = await runMain({ argv, config: configWith({ d1_databases: [db()] }) });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["d1 info DB", MIGRATE, "deploy --keep-vars"]);
  });

  for (const flags of [
    ["--require-existing-databases", "--keep-vars"],
    ["--keep-vars", "--require-existing-databases"],
  ]) {
    it(`applies both flags for ${flags.join(" ")}`, async () => {
      const ok = await runMain({ argv: flags, config: configWith({ d1_databases: [db()] }) });
      assert.equal(ok.code, 0);
      assert.deepEqual(ok.commands, ["d1 info DB", MIGRATE, "deploy --keep-vars"]);

      const missing = await runMain({
        argv: flags,
        config: configWith({ d1_databases: [db()] }),
        respond: respondTo([["d1 info", MISSING_D1]]),
      });
      assert.equal(missing.code, 1);
      assert.deepEqual(missing.commands, ["d1 info DB"]);
      assert.equal(missing.errors.length, 1);
    });
  }

  it("adds --keep-vars after the Custom Domains", async () => {
    const r = await runMain({
      argv,
      env: { CUSTOM_DOMAINS: "a.example.com,b.example.com" },
      config: configWith({}),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["deploy --domains a.example.com --domains b.example.com --keep-vars"]);
    assert.ok(r.logs.includes("Deploying the Worker with the Custom Domains a.example.com, b.example.com."));
  });

  it("passes --keep-vars when deploying first", async () => {
    const r = await runMain({
      argv,
      config: configWith({ d1_databases: [db()] }),
      respond: respondTo([["d1 info", MISSING_D1]]),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["d1 info DB", "deploy --keep-vars", MIGRATE]);
  });

  it("does not pass --keep-vars to d1 create or r2 bucket commands", async () => {
    let infos = 0;
    const r = await runMain({
      argv,
      env: { LOCATION_HINT: "apac" },
      config: configWith({ d1_databases: [db()], r2_buckets: [{ binding: "A", bucket_name: "a" }] }),
      respond: respondTo([
        ["d1 info", MISSING_D1],
        [
          "r2 bucket info",
          () => {
            infos += 1;
            return infos === 1 ? MISSING_R2 : { status: 0, stdout: "location: apac\n", stderr: "" };
          },
        ],
      ]),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, [
      "d1 info DB",
      "d1 create app --location apac --no-update-config",
      "r2 bucket info a",
      "r2 bucket create a --location apac --no-update-config",
      "r2 bucket info a",
      MIGRATE,
      "deploy --keep-vars",
    ]);
  });

  it("returns the status of a failed deploy with --keep-vars", async () => {
    const r = await runMain({
      argv,
      config: configWith({ d1_databases: [db()] }),
      respond: respondTo([["deploy", { status: 3 }]]),
    });
    assert.equal(r.code, 3);
    assert.deepEqual(r.commands, ["d1 info DB", MIGRATE, "deploy --keep-vars"]);
  });

  for (const arg of ["--keep-vars=true", "--keep-var"]) {
    it(`rejects ${arg}`, async () => {
      const r = await runMain({ argv: [arg], config: configWith({ d1_databases: [db()] }) });
      assert.equal(r.code, 1);
      assert.deepEqual(r.calls, []);
      assert.equal(r.readConfigCalls(), 0);
      assert.deepEqual(r.errors, [
        `Unknown argument "${arg}". Usage: workers-deploy [--require-existing-databases] [--keep-vars]`,
      ]);
    });
  }

  it("passes --keep-vars once when repeated", async () => {
    const r = await runMain({ argv: ["--keep-vars", "--keep-vars"], config: configWith({ d1_databases: [db()] }) });
    assert.equal(r.code, 0);
    assert.deepEqual(r.commands, ["d1 info DB", MIGRATE, "deploy --keep-vars"]);
  });

  it("prints the help for --help --keep-vars", async () => {
    const r = await runMain({ argv: ["--help", "--keep-vars"], config: configWith({ d1_databases: [db()] }) });
    assert.equal(r.code, 0);
    assert.deepEqual(r.calls, []);
    assert.equal(r.readConfigCalls(), 0);
    assert.match(r.stdout, /^Usage: workers-deploy \[--require-existing-databases\] \[--keep-vars\]\n/);
    assert.match(r.stdout, /--keep-vars {19}Pass --keep-vars to wrangler deploy/);
  });
});

describe("readConfig", () => {
  it("rejects when readConfig throws (27)", async () => {
    await assert.rejects(
      runMain({
        config: () => {
          throw new Error("no config");
        },
      }),
      /no config/,
    );
  });

  it("rejects when wrangler itself cannot be spawned", async () => {
    await assert.rejects(
      runMain({
        config: configWith({}),
        respond: () => {
          throw new Error("spawnSync wrangler ENOENT");
        },
      }),
      /ENOENT/,
    );
  });
});
