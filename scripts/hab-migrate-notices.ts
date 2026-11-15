/** Explicit offline copy migration only. No live service/configuration changes. */
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  inspectNoticeMigration,
  migrateNoticesOffline,
} from "../src/agent-notify/migrate-notices.ts";
const planSchema = z.strictObject({
  source: z.string().min(1),
  destination_directory: z.string().min(1),
  expected_source_target: z.string().min(1),
  expected_source_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  destination_binding: z.strictObject({
    product: z.string().min(1),
    connection_id: z.string().min(1),
    recipient_id: z.string().min(1),
    session_id: z.string().min(1),
    profile: z.string().min(1).optional(),
  }),
});
const attestationSchema = z.strictObject({
  notifiers_stopped_and_source_will_not_restart: z.literal(true),
  old_connection_recipient_and_existing_session_verified: z.literal(true),
});
const safeErrors = new Set([
  "invalid_migration_usage",
  "invalid_agent_binding",
  "migration_source_not_private",
  "migration_symlink_path",
  "migration_source_binding_mismatch",
  "migration_source_corrupt",
  "migration_unsettled_decisions_reconcile_first",
  "migration_source_wal_requires_offline_checkpoint",
  "migration_source_journal_requires_offline_recovery",
  "migration_source_replaced",
  "migration_operator_attestation_required",
  "migration_reviewed_fingerprint_required",
  "migration_destination_parent_not_private",
  "migration_destination_exists",
  "migration_source_changed",
  "migration_copy_mismatch",
  "migration_decisions_changed",
]);
try {
  const [action, planFile, attestFile, ...extra] = process.argv.slice(2);
  if (
    !planFile ||
    extra.length ||
    !["inspect", "migrate"].includes(action ?? "") ||
    (action === "migrate" ? !attestFile : !!attestFile)
  )
    throw new Error("invalid_migration_usage");
  const plan = planSchema.parse(JSON.parse(readFileSync(planFile, "utf8")));
  const result =
    action === "inspect"
      ? inspectNoticeMigration(plan)
      : migrateNoticesOffline(
          plan,
          attestationSchema.parse(
            JSON.parse(readFileSync(attestFile!, "utf8")),
          ),
        );
  console.log(JSON.stringify(result));
} catch (error) {
  // Do not echo malformed plans or private message data.
  console.error(
    JSON.stringify({
      error:
        error instanceof z.ZodError
          ? "invalid_migration_plan_or_attestation"
          : error instanceof Error && safeErrors.has(error.message)
            ? error.message
            : "migration_failed",
    }),
  );
  process.exitCode = 1;
}
