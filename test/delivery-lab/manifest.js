export const pendingBackends = [
  {
    id: "nats-jetstream",
    reason:
      "JetStream adapter, pinned server and consumer policy are not implemented on main",
  },
];

export const pendingMigrationRequirements = [
  "A2A fixed connectivity preview does not prove generic six-direction body/parts or foreign mailbox/ACK scope",
  "Rename API is absent from main; immutable-ID rename must be tested after integration",
  "Recovery-time and performance budgets require representative workload and operator acceptance",
];
