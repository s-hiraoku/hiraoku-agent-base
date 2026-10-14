import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { z } from "zod";
import {
  InventoryInspector,
  inventoryPolicySchema,
  type InventoryPolicy,
} from "./inventory-inspector.ts";

const reviewedSchema = inventoryPolicySchema.omit({
  credentialSHA256: true,
  manifestSHA256: true,
  credential: true,
  store: true,
  evidenceStore: true,
});
const runtimeSchema = inventoryPolicySchema.pick({
  credential: true,
  store: true,
  evidenceStore: true,
});
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const markerMetadata = { dev: 0, ino: 0, size: 65, mtimeMs: 0, ctimeMs: 0 };

/** Pure, private launch preparation from reviewed pins. Never scans/refreshes pins,
 * writes files, generates credentials, starts a process or probes sockets/models.
 * Fingerprint is SHA256 of the future runtime-only API Bearer, not the Bearer itself.
 */
export class InventoryLaunchPlan {
  #reviewed: z.infer<typeof reviewedSchema>;
  #fingerprint: string;
  #manifestBytes: string;
  #scopeBytes: string;
  constructor(reviewed: unknown, fingerprint: string) {
    try {
      this.#reviewed = reviewedSchema.parse(structuredClone(reviewed));
      this.#fingerprint = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(fingerprint);
      const p = this.#reviewed;
      // Exact contract of serve_inventory.py, not arbitrary API/launcher selection.
      if (
        p.endpoint !== "http://127.0.0.1:8645/" ||
        p.manifestPath !== join(p.profileRoot, "inventory-manifest.json") ||
        p.storeRelativePath !== "runs_idempotency.db" ||
        basename(p.wrapperPath) !== "serve_inventory.py" ||
        !p.profileRoot.endsWith("/.hermes/profiles/hub-inventory-once")
      )
        throw Error();
      this.#scopeBytes = `${this.#fingerprint}\n`;
      this.#manifestBytes = `${JSON.stringify({
        contract: "hermes-agent-inventory-v1",
        endpoint: p.endpoint,
        profileRoot: p.profileRoot,
        sourceRoot: p.sourceRoot,
        dependencyRoot: p.dependencyRoot,
        pythonIsolation: p.pythonIsolation,
        wrapperPath: p.wrapperPath,
        pythonPath: p.pythonPath,
        model: "gpt-6.1-sol",
        provider: "openai-codex",
        tools: ["hub_shift_log_inventory"],
        maxIterations: 3,
        maxTokens: 256,
        runBudgetSeconds: 60,
        concurrency: 1,
        evidencePath: join(p.profileRoot, "inventory-evidence.sqlite"),
        runStorePath: join(p.profileRoot, p.storeRelativePath),
        memory: false,
        history: false,
        fallback: false,
        startup: "manual-one-shot",
        maxTasks: 1,
        apiKeyDigest: this.#fingerprint,
        sourceCommit: p.sourceCommit,
        codeTrees: p.codeTrees,
      })}\n`;
      // Structural closure check only. The fake metadata is never returned as policy/evidence.
      new InventoryInspector(
        this.policy({
          credential: markerMetadata,
          store: { dev: 0, ino: 0 },
          evidenceStore: { dev: 0, ino: 0 },
        }),
      );
    } catch {
      throw Error("inventory_launch_plan_rejected");
    }
  }
  artifacts() {
    return Object.freeze({
      manifestPath: this.#reviewed.manifestPath,
      manifestBytes: this.#manifestBytes,
      manifestSHA256: digest(this.#manifestBytes),
      scopePath: join(this.#reviewed.profileRoot, "credential.scope"),
      scopeBytes: this.#scopeBytes,
      scopeSHA256: digest(this.#scopeBytes),
    });
  }
  /** Metadata must be observed after private artifacts/stores exist. No credential read.
   * The returned pins must still pass fresh InventoryInspector.inspect after real startup.
   */
  policy(runtimeMetadata: unknown): InventoryPolicy {
    try {
      const metadata = runtimeSchema.parse(structuredClone(runtimeMetadata));
      if (metadata.credential.size !== 65) throw Error();
      const policy = inventoryPolicySchema.parse({
        ...this.#reviewed,
        ...metadata,
        credentialSHA256: digest(this.#scopeBytes),
        manifestSHA256: digest(this.#manifestBytes),
      });
      new InventoryInspector(policy);
      return policy;
    } catch {
      throw Error("inventory_runtime_metadata_rejected");
    }
  }
  async inspectPreparation(): Promise<void> {
    // Structural placeholders are never persisted or returned as live evidence.
    const inspector = new InventoryInspector(
      this.policy({
        credential: markerMetadata,
        store: { dev: 0, ino: 0 },
        evidenceStore: { dev: 0, ino: 0 },
      }),
    );
    await inspector.inspectPreparation();
  }
  /** Sensitive return value for a trusted local child factory only. Do not serialize/log.
   * No ambient env, shell, argv secret, default spawn or worker activation.
   */
  launch(apiKey: string) {
    if (!/^[a-f0-9]{64}$/.test(apiKey) || digest(apiKey) !== this.#fingerprint)
      throw Error("inventory_runtime_key_binding_rejected");
    return {
      executable: this.#reviewed.pythonPath,
      args: ["-I", "-S", this.#reviewed.wrapperPath],
      cwd: join(this.#reviewed.profileRoot, "empty-workdir"),
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONDONTWRITEBYTECODE: "1",
        API_SERVER_KEY: apiKey,
        HUB_INVENTORY_MANIFEST_SHA256: digest(this.#manifestBytes),
      },
    };
  }
}
