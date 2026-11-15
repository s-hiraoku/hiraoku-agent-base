# JavaScript to TypeScript migration

ADR-018 (2026-11-13) later deleted `packages/relay-nats`, the NATS installer and broker tooling, `test/ci-nats/` and `test/jetstream-pump-worker.ts`; their entries below are historical.

This is a staged source migration. `src/` and `db/` were already TypeScript at
`4dfcd14`; the remaining JavaScript was mainly tests and tooling (about 64,000
lines). The product's wire contracts, storage schemas and authorization do not
change. Node's existing native type stripping runs the new `.ts` entry points;
no new loader, transpiler or dependency is needed.

## First stage

The implementations of these entry points and helpers now live in TypeScript:

- `scripts/build.ts`
- `scripts/hab-host.ts` and `scripts/hab-admin.ts`
- `scripts/hab-enrollment-demo.ts`
- `scripts/pilot-preflight.ts`
- `scripts/native-trial-preflight.ts` and `scripts/lib/native-trial-preflight.ts`
- `scripts/install-ci-nats.ts`
- `scripts/lib/nats-broker.ts`

`test/ci-nats/install.test.ts` is also migrated. The added
`test/tools/entrypoints.test.ts` checks CLI refusal diagnostics, import safety and
the synthetic enrollment resume through both old and new entry points.

`tsconfig.tools.json` extends the root strict, no-emit, erasable-syntax settings
and includes migrated tooling and its TypeScript tests. Both `npm run check`
and `npm run typecheck` check the application and tools. `npm run lint` includes
all new TypeScript files. `npm run test:tools` runs the nested CLI, installer and
offline-preflight tests; CI and `npm test` run it explicitly. The design runner's
root behavioral check also includes those nested tests.

The seven former CLI `.mjs` paths remain as small compatibility entry points
that delegate to the typed implementations. The Relay/admin/installer aliases
preserve their exports and do not execute the CLI merely on import. Existing
LaunchAgent release paths therefore remain usable. Package commands and owned
verification recipes use `.ts`; no installed job, credential or live config is
changed by this migration.

## Worker entry points

The SQLite claim/startup workers and the JetStream synchronous pump worker now
live in `test/claim-worker.ts`, `test/startup-worker.ts` and
`test/jetstream-pump-worker.ts`. Their existing callers use the `.ts` Worker
URLs. Root strict typechecking includes `test/*-worker.ts`; parent ports,
trusted worker data, pump commands and replies are typed using the existing
`Principal` and `JetStreamRelayOptions` contracts. The ready/go handshake,
SQLite close order, pump error codes and post-reply atomic wakeup are retained.
No test case or assertion is removed. Historical P7 pins and compressed fixture
bytes remain unchanged; the successor records the new paths and callers.

## Diagram integrity renderer

`docs/diagrams/render-mermaid.ts` now owns the existing Markdown extraction,
pinned renderer/engine checks, Mermaid/PNG hashes and optional local browser
rendering. The `.mjs` path delegates to it, so CI and documented commands remain
usable. `tsconfig.diagrams.json` applies the same strict no-emit/erasable settings
without changing the application or tools compiler inventories; `typecheck` and
lint include the new implementation. Eleven disposable CLI cases check both
entry points against the committed artifacts and refused source/image/version
drift. They do not install or launch a real rendering browser. The Markdown,
PNG and manifest bytes are unchanged, and diagram integrity remains separate
from product topology or native-agent acceptance.

This unit is stacked on the worker-entry-point PR because the maintained design
source index and migration inventory are shared. Apply the worker unit first,
then this renderer unit. Their implementations do not overlap.

## Remaining source inventory

Counts below describe the tree after these stages, not an execution result or a
claim that the overall migration is finished.

| Remaining owned JavaScript | Files | Next migration unit |
| --- | ---: | --- |
| `test/**/*.js` and the generic-async worker `.mjs` | 157 | Shared fixtures and child-process entry points, then tests grouped by subsystem; include `.test.ts` in every matching runner/catalog before renaming. Negative schema tests must keep exercising invalid runtime inputs. |
| `scripts/**/*.mjs`, excluding the seven CLI compatibility aliases | 18 | Lab/proof runners and their libraries, rollback tooling and Python compatibility parent; preserve process ownership and exact evidence gates. |
| `packages/relay-nats/{scripts,test}/**` | 16 | Package fixtures, startup cases and proof/install tools; extend that package's strict tsconfig and update root consumers together. |
| `verification/design/checks/*.mjs` | 3 | Preserve the TAP/report protocols, independent durable-save observer and all negative controls. |
| `.claude/skills/verify-hab/scripts/{stack,inspect}.mjs` | 2 | Owned verification scaffold and inspector, including every shell caller and helper hash. |
| `docs/diagrams/render-mermaid.mjs` | 0 | Implementation migrated; the legacy command remains a compatibility alias. |

The seven tooling compatibility aliases, the diagram CLI alias and
`eslint.config.js` intentionally remain
JavaScript. Four `.cjs` validators/tests under `.claude/skills/security-audit/`
are vendored third-party code pinned by `UPSTREAM.md`; do not rewrite them as
part of HAB's migration. Generated `dist/worker.js`, installed dependencies,
historical compressed source fixtures and inline JavaScript examples are not
source migration targets.

Each following unit needs strict typechecking, its relevant existing behavioral
tests and the full P7/design checks. P7 uses committed source bytes: commit the
source first, generate a reviewed successor pin with the new paths included,
then commit the pin separately. Keep the historical pin and results unchanged.
The eight-feature verification map remains the public behavior map; this file
is an engineering inventory, not a new product requirement or native-agent
acceptance record.
