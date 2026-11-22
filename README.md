# @i2bskn/workers-deploy

The deploy command for Cloudflare Workers with D1. It creates the missing D1 databases and R2 buckets in the location
given by `LOCATION_HINT`, applies the D1 migrations, then runs `wrangler deploy`.

It is meant to be the deploy command of Workers Builds and of the Deploy to Cloudflare button, so it also works on the
very first deploy, when the D1 database does not exist yet.

## Install

```sh
pnpm add -D @i2bskn/workers-deploy wrangler
```

`wrangler` is a peer dependency. The version tested with this package is 4.154.0.

## Usage

```json
{
  "scripts": {
    "deploy": "workers-deploy"
  }
}
```

```sh
pnpm run deploy
```

Run it from the root of the project. The bindings are read from the Wrangler configuration with wrangler's
`unstable_readConfig` (top level only; `env.*` is not read), and `wrangler` is run from the `PATH`, which `pnpm run`
extends with `node_modules/.bin`.

```
Usage: workers-deploy [--require-existing-databases]
```

## Environment variables

| name | contents |
| --- | --- |
| `LOCATION_HINT` | Optional. `weur`, `eeur`, `apac`, `oc`, `wnam` or `enam` (case-insensitive). The missing D1 databases and R2 buckets are created there. Empty means not set. |
| `CUSTOM_DOMAINS` | Optional. Hostnames separated by commas or spaces, such as `app.example.com, www.example.com`. They are passed to `wrangler deploy --domains`. Duplicates are removed. Schemes, paths, ports, wildcards and single-label names are rejected. |
| `CUSTOM_DOMAIN` | The former name. Setting it to a non-empty value is an error: rename it to `CUSTOM_DOMAINS`. |

In Workers Builds, set them as build variables.

## Flags

| flag | effect |
| --- | --- |
| `--require-existing-databases` | Stops with an error, before creating or deploying anything, when a D1 database of the configuration does not exist. Without it, `wrangler deploy` would create a new, empty database. A D1 binding without both `database_name` and `database_id` counts as missing. R2 buckets are still created as usual. |
| `--help`, `-h` | Prints the usage. |

Any other argument is an error.

## What it does

1. Validates the arguments, `LOCATION_HINT` and `CUSTOM_DOMAINS`. On an error, nothing is called.
2. Reads the Wrangler configuration.
3. Checks whether each D1 database in `d1_databases` exists, with `wrangler d1 info <binding>`. A binding without
   `database_name` and `database_id` is treated as missing without the lookup.
4. With `--require-existing-databases`, stops with exit code 1 if any D1 database is missing.
5. When `LOCATION_HINT` is set:
   - creates each missing D1 database that has a `database_name` and no `database_id` with
     `wrangler d1 create <name> --location <location> --no-update-config`. The others are left to `wrangler deploy`.
   - creates each missing R2 bucket in `r2_buckets` that has a `bucket_name` and no `jurisdiction` with
     `wrangler r2 bucket create <name> --location <location> --no-update-config`, then checks where it ended up and
     warns if the location differs. The location hint only applies to the first bucket ever created with a name.
6. Collects the D1 databases whose migrations directory (`migrations_dir`, default `./migrations`, relative to the
   Wrangler configuration) exists. The others are skipped.
7. If all of those databases exist, applies the migrations (`wrangler d1 migrations apply <binding> --remote`) and then
   deploys, so that new code never runs against missing tables. If any of them is missing, deploys first so that
   `wrangler deploy` creates it, and then applies the migrations. In that case the new Worker runs without tables for a
   few seconds, which is harmless on a first deploy.
8. Deploys with `wrangler deploy`, adding `--domains <hostname>` for each hostname of `CUSTOM_DOMAINS`.

Existing databases and buckets are never moved: their location cannot be changed.

## Exit codes

- `0` on success.
- `1` on an invalid argument, `LOCATION_HINT`, `CUSTOM_DOMAINS` or `CUSTOM_DOMAIN`, and on a missing database with
  `--require-existing-databases`. The message goes to stderr.
- When `wrangler d1 info` or `wrangler r2 bucket info` fails for another reason (e.g. authentication), its captured
  output is printed and its exit status is returned.
- When any other wrangler command fails, its exit status (1 if it has none) is returned and nothing after it runs.
  A failed `d1 create` or `r2 bucket create` stops the deploy: `LOCATION_HINT` is an explicit request, so creating the
  resource elsewhere would be worse.

## Notes

- **Custom Domains are replaced.** `wrangler deploy` replaces the Worker's Custom Domains with the ones in the
  configuration's `routes` together with `--domains`. A Custom Domain added only in the dashboard is removed on the
  next deploy, so list every Custom Domain either in `routes` or in `CUSTOM_DOMAINS`.
- **`routes` and `--domains` are combined.** The hostnames of `CUSTOM_DOMAINS` are added to the `routes` of the
  configuration; they do not override them.
- **`CUSTOM_DOMAIN` is an error.** The former name is rejected rather than ignored, so that a stale build variable does
  not silently stop passing the domains. Rename it to `CUSTOM_DOMAINS`.
- **workers.dev.** When neither `workers_dev` nor `routes` are in the Wrangler configuration, `wrangler deploy` without
  `CUSTOM_DOMAINS` enables the workers.dev subdomain on every deploy, even after it was disabled in the dashboard.
- **Tested wrangler version.** This package was tested with wrangler 4.154.0.

## License

MIT
