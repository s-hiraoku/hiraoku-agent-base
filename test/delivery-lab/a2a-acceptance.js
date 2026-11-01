import source from "./a2a-source-pin.json" with { type: "json" };
import producerCases from "./a2a-producer-cases.json" with { type: "json" };

export const nativeCases = [
  "A01 native ingress and delivery ACK leave execution unstarted",
  "A02 replay preserves original intent and changed input conflicts",
  "A03 independent durable inbox is readable before the outgoing real ACK",
  "A04 committed ACK response loss preserves retry identity across restart",
  "A05 precommit ACK loss and stale lease recover one durable inbox",
  "A06 competing real Relay consumers exclude one another after native ingress",
  "A07 only explicit acceptance submits one engine Task across restart",
  "A08 confirmed durable result and closed evidence release one stable Artifact",
  "A09 private native Card and Task projections enforce current owner group",
  "A10 unknown expiry refuses execution and known RPC success survives expired lease",
];

export const a2aAcceptance = {
  scope: "fixed-connectivity-route-over-sqlite-relay",
  source,
  groups: [
    {
      id: "a2a-producer",
      files: [
        "test/a2a-adapter.test.js",
        "test/a2a-sdk-store.test.js",
        "test/a2a-hab-unit-route.test.js",
        "test/a2a-hab-unit.test.js",
        "test/a2a-submission-receipts.test.js",
        "test/a2a-relay-e2e.test.js",
      ],
      cases: producerCases,
    },
    {
      id: "a2a-relay-acceptance",
      files: ["test/delivery-lab/a2a-native.test.js"],
      cases: nativeCases,
    },
  ],
  reclassified: [
    [
      "D01",
      "outside_fixed_route",
      ["A01"],
      "Six directions and arbitrary UTF-8 bodies/parts are not proven by the fixed connectivity route.",
    ],
    [
      "D02",
      "native_counterpart",
      ["A02"],
      "Native Task identity is distinct from the delivery receipt and arbitrary-envelope engine contract.",
    ],
    [
      "D03",
      "cross_layer_counterpart",
      ["A03"],
      "Independent committed storage observation is at the actual downstream Relay ACK boundary.",
    ],
    [
      "D04",
      "cross_layer_counterpart",
      ["A04"],
      "Native-origin Relay ACK retry is observed; there is no A2A ACK API.",
    ],
    [
      "D05",
      "cross_layer_counterpart",
      ["A05"],
      "Only the private fixture lease is expired; no OS clock or power-fault claim.",
    ],
    [
      "D06",
      "cross_layer_counterpart",
      ["A06"],
      "Real Relay consumer exclusion after native ingress is not an A2A polling capability.",
    ],
    [
      "D07",
      "partial_native_counterpart",
      ["A09"],
      "Native Card/Task/result privacy does not replace foreign raw mailbox/status/ACK authorization.",
    ],
    [
      "D08",
      "scoped_restart_counterpart",
      ["A04", "A05", "A07", "A10"],
      "Scoped store/HTTP reopen does not prove arbitrary transport disconnect or native polling semantics.",
    ],
  ].map(([contract_id, relationship, case_ids, limitation]) => ({
    contract_id,
    relationship,
    case_ids,
    limitation,
    disposition: "reclassified-from-engine-placeholder-not-a-generic-pass",
  })),
};
