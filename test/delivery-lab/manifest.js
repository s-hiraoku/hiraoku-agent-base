export const pendingBackends = [
  {
    id: "a2a",
    reason: "A2A adapter and persistent Task store are not implemented on main",
  },
  {
    id: "nats-jetstream",
    reason:
      "JetStream adapter, pinned server and consumer policy are not implemented on main",
  },
];

export const pendingMigrationRequirements = [
  "Rename API is absent from main; immutable-ID rename must be tested after integration",
  "Recovery-time and performance budgets require representative workload and operator acceptance",
];
