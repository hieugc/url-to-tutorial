# Compiler and code generation

Install from the repository root with Node.js 22+:

```sh
npm ci
npm run verify:toolchain
```

Tools are exact-version development dependencies in `package.json` and
`package-lock.json`. They do not require global installations and are excluded by
the existing production Dockerfile's `npm ci --omit=dev`.

| Tool | Purpose in this repository |
| --- | --- |
| esbuild | Compile the ESM Node modules and bundle/minify Studio JS/CSS into `dist/` |
| TypeScript | Check generated declarations and positive/negative type contract fixtures |
| Zod 4 (existing runtime dependency) | Export JSON Schema from the existing `Plan` schema |
| json-schema-to-typescript | Compile those schemas into TypeScript declarations |
| Plop | Generate a consistent adapter module and runnable unit tests |
| Playwright (existing runtime dependency) | Record browser actions using its existing codegen CLI |

## Generate contracts

```sh
npm run generate
npm run generate:check
npm run typecheck
```

`src/plan.mjs` remains the source of truth. Generated files are committed:

- `schemas/tutorial-plan.input.schema.json` and `types/generated/tutorial-plan.input.d.ts`
  describe input plans, where defaulted fields may be omitted.
- `schemas/tutorial-plan.schema.json` and `types/generated/tutorial-plan.d.ts`
  describe parsed plans, where those defaults are present.

The JSON Schema files use draft-07. Regenerate after changing `Plan`; do not edit
generated files manually. `generate:check` returns a nonzero exit code for missing
or stale files without overwriting them. CI runs this check **before** the build.

The exported schema/types describe structure, not all runtime behavior. Zod custom
refinements include allowed URL protocols/credentials, even viewport dimensions,
action-specific fields, unique step IDs, forward-only edges and reachability.
Continue to use `Plan.parse()` and `validatePlanForExecution()`; TypeScript and JSON
Schema do not authorize clicks, navigation or form input. `typecheck` covers the
generated contracts and `test/types/`, not all existing JavaScript source files.

Example type imports for new TypeScript consumers:

```ts
import type { TutorialPlanInput } from './types/generated/tutorial-plan.input.js';
import type { TutorialPlan } from './types/generated/tutorial-plan.js';
```

The `.js` import specifiers follow NodeNext resolution to the `.d.ts` declarations;
these are type-only imports. VS Code associates `*.plan.json` and `plan.json` files
with the input schema for completion.

## Generate an adapter

```sh
npm run generate:adapter -- example-site
node --test test/example-site.test.mjs
```

This creates `src/adapters/example-site.mjs` and `test/example-site.test.mjs`.
Names must use lowercase kebab-case. Existing files are refused even with
`--force`; either output already existing aborts generation before writing.

The adapter converts supplied observations (`url`, `title`, and `sections` with
`title`, `description`, `selector`) into an unapproved highlight-only plan through
`Plan.parse()`. It does not invent selectors or register a new CLI command.
Implement site observation, host/path restrictions, privacy checks and selector
uniqueness checks before wiring it into CLI/Studio. Hostinger remains the reference
for a complete site-specific observation flow.

To record a browser script locally with the already installed Playwright:

```sh
npm run codegen:browser -- https://example.com
```

Playwright opens an interactive browser/inspector and emits a script; its output is
not a tutorial plan. Review the recorded actions and adapt them to the plan model.

## Build and run

```sh
npm run build
npm run test:build
node dist/src/cli.mjs validate dist/examples/demo.plan.json
node dist/src/studio-server.mjs --port 4173
```

`build` regenerates contracts, checks their types, clears `dist/`, and compiles the
application. Node modules retain the source layout under `dist/src/`, including
`.mjs` extensions and `import.meta.url`. Node code is not bundled/minified: this
preserves resource paths, optional SDK loading and Playwright page callbacks.
Studio JS/CSS are bundled/minified, with HTML kept alongside them.

`dist/` also includes examples, migrations, schemas, declarations, package manifest
and lockfile. To run a copied build independently:

```sh
cd dist
npm ci --omit=dev
npx playwright install chromium
npm run studio
# Or: npm run demo
```

Install FFmpeg and, for narration, espeak-ng on the host as described in the main
README. Runtime dependencies are not embedded in `dist/`. The copied manifest also
contains development scripts; run those from the source checkout. `dist/` is
ignored by Git and uploaded as `tutorial-runtime-build` by the toolchain workflow.

## Verification

```sh
npm run verify:toolchain
npm test
```

The toolchain workflow runs on the existing self-hosted macOS ARM64 runner with
Node 22. It checks generation drift, types, build output, scaffold behavior and
compiled CLI/Studio smoke tests. The existing CI continues to run browser/video
regressions and PostgreSQL integration tests. PostgreSQL integration tests require
`COORDINATION_DATABASE_URL`; browser tests require Chromium.

Primary documentation: [esbuild](https://esbuild.github.io/api/),
[Zod JSON Schema](https://zod.dev/json-schema),
[json-schema-to-typescript](https://github.com/bcherny/json-schema-to-typescript),
[Plop](https://plopjs.com/documentation/).
