/** Ephemeral synthetic demonstration only. Never loads production config or credentials. */
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { SQLiteHabRegistry } from "../src/hab/sqlite-registry.ts";
import { SQLiteEnrollmentJournal } from "../src/hab/sqlite-enrollment-journal.ts";
import { runHabEnrollment } from "../src/hab/enrollment.ts";
import { enrollmentTerminalUI } from "../src/hab/enrollment-terminal.ts";

const mode = process.argv[2];
if (
  process.argv.length !== 3 ||
  !["--simulate", "--interactive"].includes(mode)
) {
  process.stderr.write(
    "Usage: node scripts/hab-enrollment-demo.mjs --simulate | --interactive\n",
  );
  process.exitCode = 1;
} else if (
  mode === "--interactive" &&
  (!process.stdin.isTTY || !process.stdout.isTTY)
) {
  process.stderr.write("enrollment_demo_requires_terminal\n");
  process.exitCode = 1;
} else {
  const directory = mkdtempSync(join(tmpdir(), "hab-enrollment-demo-"));
  chmodSync(directory, 0o700);
  const management = Symbol("synthetic-management"),
    connection = Symbol("synthetic-connection");
  const options = {
    fingerprint_key: new Uint8Array(32).fill(17), // synthetic local digest key, never a service credential
    max_products: 3,
    max_agents: 3,
    max_bindings: 3,
    max_requests: 20,
    max_blocks: 3,
    max_audit_records: 20,
    max_context_ms: 60000,
    busy_timeout_ms: 100,
    allowed_kinds: ["question", "answer", "notice"],
  };
  const authority = {
    administrator: (context) =>
      context === management ? { actor_id: "demo-administrator" } : undefined,
    individual: (context) =>
      context === connection
        ? {
            principal: {
              issuer: "https://issuer.example/",
              audience: "https://relay.example/mcp",
              subject: "synthetic-owner",
              client_id: "synthetic-client",
              connection_id: "synthetic-bot-a",
            },
            expires_at: new Date(Date.now() + 30000).toISOString(),
          }
        : undefined,
  };
  let registry, journal, terminal;
  try {
    const open = () => {
      registry = new SQLiteHabRegistry(
        join(directory, "registry.sqlite"),
        options,
        authority,
      );
      registry.migrate();
      journal = new SQLiteEnrollmentJournal(
        join(directory, "enrollment.sqlite"),
        { max_sessions: 3, busy_timeout_ms: 100 },
      );
      journal.migrate();
    };
    open();
    for (const agent_name of ["grok-bot", "dot", "hermes"])
      registry.registerProduct(management, {
        request_id: `demo-product-${agent_name}`,
        agent_name,
      });
    process.stdout.write(
      "HAB登録デモ：一時DB・模擬認証のみ。実Botへは接続しません。終了時にデータを削除します。\n",
    );
    let ui;
    if (mode === "--interactive") {
      terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      ui = enrollmentTerminalUI({
        write: (text) => process.stdout.write(text),
        question: async (prompt) => {
          try {
            return await terminal.question(prompt, {
              signal: AbortSignal.timeout(60000),
            });
          } catch {
            return null;
          }
        },
      });
    } else {
      let address;
      ui = {
        product: async (page) =>
          page.products.find((p) => p.agent_name === "grok-bot").product_id,
        botName: async () => "research",
        confirm: async (proposal) => {
          address = proposal.address;
          process.stdout.write(`模擬確認: ${proposal.kind} ${address}\n`);
          return proposal.kind !== "activate";
        },
        operations: async () => ["submit", "status", "poll", "ack", "resolve"],
      };
    }
    const host = () => ({
      registry,
      journal,
      ui,
      managementContext: () => management,
      connection: async () => ({
        context: connection,
        label: "Synthetic local bot A",
      }),
    });
    let result = await runHabEnrollment(host(), "synthetic-demo");
    if (mode === "--simulate") {
      if (result.status !== "paused" || result.stage !== "bound") throw Error();
      process.stdout.write(
        "接続済み・送受信無効のまま中断し、DBを閉じて再開します。\n",
      );
      journal.close();
      journal = undefined;
      registry.close();
      registry = undefined;
      open();
      ui.confirm = async (proposal) => {
        process.stdout.write(
          `再開後の模擬確認: ${proposal.kind} ${proposal.address}\n`,
        );
        return true;
      };
      result = await runHabEnrollment(host(), "synthetic-demo");
    }
    if (result.status === "complete")
      process.stdout.write(
        `模擬登録完了: ${result.agent.address} / ${result.agent.state}\n実サービス接続・配送の検証結果ではありません。\n`,
      );
    else process.stdout.write(`模擬登録中断: ${result.stage}\n`);
  } catch {
    process.stderr.write("enrollment_demo_failed\n");
    process.exitCode = 1;
  } finally {
    terminal?.close();
    journal?.close();
    registry?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
