import { hostAdminStatus } from "../host/admin.ts";
import {
  diagnose,
  hostAdminDoctor,
  summarizeDiagnosis,
  type Check,
} from "../host/doctor.ts";

const receiveModes = new Set(["hook", "poll", "on_request"]);
const timestamp =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function visibleCheck(check: Check, fields: readonly string[]) {
  const evidence: Record<string, number | string> = {};
  for (const field of fields) {
    const value = check.evidence[field];
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      evidence[field] = value;
    } else if (
      typeof value === "string" &&
      (field === "mode"
        ? receiveModes.has(value)
        : timestamp.test(value) && Number.isFinite(Date.parse(value)))
    ) {
      evidence[field] = value;
    }
  }
  return {
    state: check.state,
    reason: check.reason,
    next_action: check.next_action,
    evidence,
  };
}

export function dashboardAddresses(configPath: string, now = Date.now()) {
  const status = hostAdminStatus(configPath, now);
  return {
    addresses: status.addresses.map((entry) => ({
      ...summarizeDiagnosis(diagnose(status, entry.address, now)),
      registry_state: entry.state,
    })),
  };
}

export function dashboardDiagnosis(configPath: string, address: string) {
  const diagnosis = hostAdminDoctor(configPath, address);
  const { registration, receive, reading, session } = diagnosis.checks;
  return {
    address: diagnosis.address,
    checks: {
      registration: visibleCheck(registration, [
        "active_bindings",
        "operations",
        "pending_connections",
        "approved_until",
      ]),
      receive: visibleCheck(receive, [
        "mode",
        "interval_ms",
        "last_inbox_read_at",
        "last_rang_at",
        "last_status",
      ]),
      reading: visibleCheck(reading, [
        "unread",
        "oldest_unread_at",
        "last_inbox_read_at",
        "last_accepted_ring_at",
      ]),
      session: visibleCheck(session, ["absent_since"]),
    },
  };
}
