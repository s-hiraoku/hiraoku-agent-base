/** Delivery backends the lab names but cannot run yet. None: SQLite is the only backend (ADR-018). */
export const pendingBackends = [];

export const pendingMigrationRequirements = [
  "A2A fixed connectivity preview does not prove generic six-direction body/parts or foreign mailbox/ACK scope",
  "Rename API is absent from main; immutable-ID rename must be tested after integration",
  "Recovery-time and performance budgets require representative workload and operator acceptance",
];
