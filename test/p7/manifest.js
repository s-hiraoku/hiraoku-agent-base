import { startupCases } from "../../packages/relay-nats/test/startup/startup-cases.js";
import { genericNatsCases } from "../generic-nats/case-names.js";
import a2aCases from "./a2a-cases.json" with { type: "json" };
import natsCases from "./nats-cases.json" with { type: "json" };
import { nativeCases } from "../delivery-lab/a2a-acceptance.js";
export const p7Cases = [
  "P7-01 official A2A and real HAB NATS separate saved ACK from one Task and Artifact",
  "P7-02 whole HAB cold restore preserves a live broker reply and one known engine Task",
  "P7-03 incomplete cold images refuse restoration before serving traffic",
  "P7-04 same-ID rename preserves the NATS chain and receipt across a cold host restart",
  "P7-05 broker outage retains original admission without any SQLite fallback",
];
export const runnerCases = [
  "R01 fixed composite contents validate without producer Git objects",
  "R02 wrong source bytes inventory origins and dependencies fail closed",
  "R03 historical f19 guard rejects the composite candidate",
  "R04 required evidence rejects missing duplicate skipped or malformed cases",
  "R05 P7 CLI and binary refusal never execute unverified bytes",
  "R06 cold image metadata rejects unsafe paths symlinks byte and mode drift",
  "R07 timeout closes an owned worker and its descendant process group",
  "R08 denied group liveness probes verify and close owned descendants through read-only evidence",
];
export const groups = [
  {
    id: "a2a-producer",
    files: [
      "test/a2a-adapter.test.js",
      "test/a2a-sdk-store.test.js",
      "test/a2a-hab-unit-route.test.js",
      "test/a2a-hab-unit.test.js",
      "test/a2a-submission-receipts.test.js",
      "test/a2a-relay-e2e.test.js",
      "test/a2a-rename-acceptance.test.js",
    ],
    cases: a2aCases,
  },
  {
    id: "a2a-native",
    files: ["test/delivery-lab/a2a-native.test.js"],
    cases: nativeCases,
  },
  {
    id: "nats-producer",
    files: [
      "backend",
      "configured-host",
      "guarded-commits",
      "hab-integration",
      "delivery-semantics",
    ].map((name) => `packages/relay-nats/test/${name}.test.js`),
    cases: natsCases,
  },
  {
    id: "broker-startup",
    files: ["packages/relay-nats/test/startup/startup.test.js"],
    cases: startupCases,
  },
  {
    id: "p7-acceptance",
    files: ["test/p7/integration.test.js"],
    cases: p7Cases,
  },
  {
    id: "generic-nats",
    files: ["test/generic-nats/integration.test.js"],
    cases: genericNatsCases,
  },
  { id: "p7-guards", files: ["test/p7/runner.test.js"], cases: runnerCases },
  {
    id: "shared-real-backends",
    generated_common: true,
    cases: [
      "hab-host-jetstream D01 six directed round trips preserve sender, recipient and UTF-8 body",
      "hab-host-jetstream D02 duplicate acceptance returns one receipt and changed content is rejected",
      "hab-host-jetstream D03 ACK is sent only after inbox survives an independent reopen",
      "hab-host-jetstream D04 lost committed ACK response recovers the exact request after restart",
      "hab-host-jetstream D05 ACK loss before commit and lease expiry redeliver without a duplicate inbox entry",
      "hab-host-jetstream D06 two competing consumers receive only one active lease",
      "hab-host-jetstream D07 foreign status, mailbox and ACK cannot cross identity boundaries",
      "hab-host-jetstream D08 disconnected receiver reconnects and recovers an accepted message",
      "nats-jetstream-real-hab D01 six directed round trips preserve sender, recipient and UTF-8 body",
      "nats-jetstream-real-hab D02 duplicate acceptance returns one receipt and changed content is rejected",
      "nats-jetstream-real-hab D03 ACK is sent only after inbox survives an independent reopen",
      "nats-jetstream-real-hab D04 lost committed ACK response recovers the exact request after restart",
      "nats-jetstream-real-hab D05 ACK loss before commit and lease expiry redeliver without a duplicate inbox entry",
      "nats-jetstream-real-hab D06 two competing consumers receive only one active lease",
      "nats-jetstream-real-hab D07 foreign status, mailbox and ACK cannot cross identity boundaries",
      "nats-jetstream-real-hab D08 disconnected receiver reconnects and recovers an accepted message",
    ],
  },
];
export const blockers = [
  "Known Linux container full suite is not green; original71 failures reproduced on main and paired main/candidate each1331pass69fail; no candidate-only regression detected",
  "Selected Linux service account, native volume semantics and independent restore remain pre-move gates; no target server selected",
  "Generic A2A bodies/parts and attachments and formal cancellation remain outside this fixed route",
  "Representative workload and operator latency/recovery/load budgets remain undecided; finite SQLite characterization is not a JetStream SLO",
  "Hosted CI, product wake/GUI, production identities and OS/power/physical-volume faults are not verified",
];
export const historicalDisposition = [
  {
    group: "f19 storage-and-harness27",
    state: "not-applicable-to-composite",
    reason:
      "Its fixed f19 source-positive and old delivery CLI tests intentionally reject approved e9/ee bytes; original successful result remains at b4bc2fc",
  },
  {
    group: "f19 A2A8 placeholders",
    state: "historically-reclassified",
    reason:
      "Native protocol remains distinct from delivery engine; common16 now executes actual SQLite and actual JetStream delivery adapters, not a fake A2A backend",
  },
];
