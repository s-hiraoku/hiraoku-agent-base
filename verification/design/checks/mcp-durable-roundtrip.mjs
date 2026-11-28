#!/usr/bin/env node
// HAB-owned finite synthetic-authority protocol/storage proof. No production configuration.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

assert(
  Number(process.versions.node.split(".")[0]) >= 24,
  "Node >= 24 required",
);

// Independent read-only connection: no migration, writes or host API can satisfy this gate.
function assertCommittedDelivery(
  path,
  expectedSender,
  messageId,
  expectedState,
  expectedBody,
) {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    const row = raw
      .prepare(
        "SELECT state, body, body_bytes, ack_receipt_id, acked_at FROM delivery_messages WHERE sender_id=? AND message_id=?",
      )
      .get(expectedSender, messageId);
    assert(row, "missing independently visible committed delivery row");
    assert.equal(row.state, expectedState, "committed delivery state differs");
    if (expectedBody === null) {
      assert.equal(row.body, null, "expected released body after ACK");
      assert.equal(row.body_bytes, 0, "expected zero body_bytes after ACK");
      assert(row.ack_receipt_id, "missing committed ack_receipt_id");
      assert(row.acked_at !== null, "missing committed acked_at");
    } else {
      assert(row.body, "missing independently visible committed body");
      assert.deepEqual(
        JSON.parse(row.body),
        { sender_id: expectedSender, message: expectedBody },
        "committed delivery body differs",
      );
      assert(row.body_bytes > 0, "expected positive body_bytes");
    }
  } finally {
    raw.close();
  }
}

function guardSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "hab-delivery-guard-")),
    path = join(scratch, "guard.sqlite");
  const db = new DatabaseSync(path);
  const body = { parts: [{ type: "text", text: "synthetic body" }] };
  const sender = "synthetic-sender",
    messageId = "synthetic-message";
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE delivery_messages(sender_id TEXT,message_id TEXT,state TEXT,body TEXT,body_bytes INTEGER,ack_receipt_id TEXT,acked_at INTEGER);",
    );
    const checkPending = () =>
      assertCommittedDelivery(path, sender, messageId, "pending", body);
    const checkAcked = () =>
      assertCommittedDelivery(path, sender, messageId, "acked", null);
    assert.throws(
      checkPending,
      /missing independently visible committed delivery row/,
    );
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "INSERT INTO delivery_messages VALUES(?,?,?,?,?,NULL,NULL)",
    ).run(
      sender,
      messageId,
      "pending",
      JSON.stringify({ sender_id: sender, message: body }),
      42,
    );
    assert.throws(
      checkPending,
      /missing independently visible committed delivery row/,
    );
    db.exec("COMMIT");
    checkPending();
    db.prepare("UPDATE delivery_messages SET body=?").run(
      JSON.stringify({
        sender_id: sender,
        message: { parts: [{ type: "text", text: "changed" }] },
      }),
    );
    assert.throws(checkPending, /committed delivery body differs/);
    db.prepare("UPDATE delivery_messages SET state='acked',body=NULL,body_bytes=0").run();
    assert.throws(checkAcked, /missing committed ack_receipt_id/);
    db.prepare(
      "UPDATE delivery_messages SET ack_receipt_id='ack-1',acked_at=1000",
    ).run();
    checkAcked();
    console.log(
      JSON.stringify({
        status: "pass",
        scope: "observer guard only; no HAB protocol behavior exercised",
        negativeControls: [
          "missing delivery row",
          "uncommitted delivery insert",
          "changed committed body",
          "acked without ack_receipt_id",
        ],
        committedDeliveryControl: "pass",
      }),
    );
  } finally {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--self-test") {
  guardSelfTest();
} else {
  assert(
    args.length === 2 && !args[0].startsWith("--"),
    "usage: node mcp-durable-roundtrip.mjs TARGET NEW_EVIDENCE_DIR | --self-test",
  );
  await roundtrip(resolve(args[0]), resolve(args[1]));
}

async function roundtrip(target, out) {
  assert(!existsSync(out), "refuse to overwrite previous evidence");
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const run = join(out, "scaffold");
  const logPath = join(out, "stack.log"),
    tracePath = join(out, "trace.jsonl");
  writeFileSync(logPath, "");
  writeFileSync(tracePath, "");
  const trace = (event, value) =>
    appendFileSync(
      tracePath,
      JSON.stringify({ at: new Date().toISOString(), event, value }) + "\n",
    );
  const controller = new AbortController();
  const interrupted = () => controller.abort(Error("verification interrupted"));
  process.on("SIGTERM", interrupted);
  process.on("SIGINT", interrupted);
  let child,
    childResult,
    childError,
    exited,
    log = "",
    result,
    failure;
  const cleanup = {
    ownedPid: null,
    exitObserved: false,
    gracefulExit: false,
    forcedTermination: false,
    storesRemoved: false,
    errors: [],
  };
  try {
    const load = (name) => import(pathToFileURL(join(target, name)).href);
    const { HabMcpClient } = await load("src/hab/mcp-client.ts");
    controller.signal.throwIfAborted();
    child = spawn(
      process.execPath,
      [join(target, ".claude/skills/verify-hab/scripts/stack.mjs"), run, "0"],
      { cwd: target, stdio: ["ignore", "pipe", "pipe"] },
    );
    cleanup.ownedPid = child.pid ?? null;
    exited = new Promise((done) => {
      child.on("error", (error) => {
        childError = error;
      });
      child.once("close", (code, signal) => {
        childResult = { code, signal, error: childError?.message ?? null };
        done(childResult);
      });
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (bytes) => {
        log = (log + bytes.toString()).slice(-262144);
        appendFileSync(logPath, bytes);
      });
    const deadline = Date.now() + 10000;
    while (!log.includes("HAB_VERIFY_READY ")) {
      controller.signal.throwIfAborted();
      assert(
        !childError &&
          !childResult &&
          child.exitCode === null &&
          child.signalCode === null,
        "owned scaffold exited before ready",
      );
      assert(Date.now() < deadline, "scaffold readiness timeout");
      await delay(20);
    }
    const state = JSON.parse(
      readFileSync(join(run, "instance/state.json"), "utf8"),
    );
    assert.equal(state.pid, child.pid);
    assert.equal(
      Number(readFileSync(join(run, "instance/stack.pid"), "utf8").trim()),
      child.pid,
    );
    const url = new URL(state.url);
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/mcp");
    assert.equal(Number(url.port), state.port);
    assert.equal(state.delivery_url, `${state.url}/delivery`);
    assert(
      Number.isInteger(state.port) && state.port > 0 && state.port < 65536,
    );
    const unauth = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
    });
    assert.equal(unauth.status, 401);
    await unauth.body?.cancel();
    trace("doctor", {
      node: process.version,
      ownedPid: child.pid,
      url: state.url,
      unauthenticatedStatus: unauth.status,
    });
    const limits = {
      envelope_bytes: 32768,
      text_bytes: 16000,
      data_bytes: 16000,
      parts: 8,
      json_depth: 20,
      json_nodes: 1000,
    };
    const deliveryDbPath = join(run, "instance/delivery.sqlite");
    const tracedFetch = async (address, init) => {
      const body = JSON.parse(init.body);
      trace("request", body); // Authorization headers are deliberately absent.
      const response = await fetch(address, {
        ...init,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(3000),
          ...(init.signal ? [init.signal] : []),
        ]),
      });
      trace("response", {
        status: response.status,
        body: await response.clone().text(),
      });
      return response;
    };
    const makeClient = (agent) =>
      new HabMcpClient({
        limits,
        policy: {
          resource_url: state.delivery_url,
          agent_id: state.agents[agent].agent_id,
          max_request_bytes: 65536,
          max_response_bytes: 131072,
          timeout_ms: 2500,
          max_active_requests: 1,
          max_sse_events: 16,
          max_sse_lines: 128,
          max_json_depth: 64,
          max_json_nodes: 10000,
        },
        authorization: () => `Bearer ${state.agents[agent].token}`,
        fetch: tracedFetch,
      });
    let rpcId = 100;
    const callAgentTool = async (agent, name, args) => {
      const response = await tracedFetch(state.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${state.agents[agent].token}`,
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": name,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++rpcId,
          method: "tools/call",
          params: {
            name,
            arguments: args,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      assert.equal(response.status, 200);
      const parsed = await response.json();
      assert.equal(parsed.error, undefined);
      assert.equal(Boolean(parsed.result?.isError), false);
      return parsed.result.structuredContent;
    };

    // 1. Low-level /mcp/delivery roundtrip with independent SQLite verification.
    const sender = makeClient("a");
    const receiver = makeClient("b");
    const resolution = await sender.resolve(state.agents.b.address);
    assert.equal(resolution.recipient_id, state.agents.b.agent_id);
    const at = Date.now() - 100;
    const message = {
      version: 1,
      message_id: `rm1.${at}.${randomBytes(16).toString("hex")}`,
      recipient_id: resolution.recipient_id,
      kind: "question",
      body: {
        parts: [
          {
            type: "text",
            text: "Synthetic durable communication; do not execute.",
          },
        ],
      },
      thread_id: `proof-${at}`,
      in_reply_to: null,
      first_sent_at: new Date(at).toISOString(),
      expires_at: new Date(at + 3600000).toISOString(),
    };
    const first = await sender.submit(message),
      replay = await sender.submit(message);
    assert.equal(first.receipt_id, replay.receipt_id);
    trace("same_id_replay", {
      sameReceipt: true,
      messageId: message.message_id,
    });
    assertCommittedDelivery(
      deliveryDbPath,
      state.agents.a.agent_id,
      message.message_id,
      "pending",
      message,
    );
    trace("independent_committed_delivery", {
      messageId: message.message_id,
      state: "pending",
      committedBody: true,
      observerReadOnly: true,
    });
    const delivered = await receiver.poll();
    assert.ok(delivered);
    assert.deepEqual(delivered.message, {
      ...message,
      sender_id: state.agents.a.agent_id,
    });
    const ackReq = {
      sender_id: state.agents.a.agent_id,
      message_id: message.message_id,
      generation: delivered.generation,
      lease_token: delivered.lease_token,
      request_id: `proof-ack-${at}`,
    };
    const acked = await receiver.ack(ackReq);
    const ackReplay = await receiver.ack(ackReq);
    assert.deepEqual(ackReplay, acked);
    assertCommittedDelivery(
      deliveryDbPath,
      state.agents.a.agent_id,
      message.message_id,
      "acked",
      null,
    );
    trace("independent_acked_delivery", {
      messageId: message.message_id,
      requestId: ackReq.request_id,
      state: "acked",
      bodyReleased: true,
      observerReadOnly: true,
    });
    assert.equal((await sender.status(message.message_id)).state, "acked");
    assert.equal(await receiver.poll(), null);

    // 2. Mail-style /mcp agent roundtrip (ADR-020).
    const mailText = "Synthetic mail-style roundtrip; do not execute.";
    const sentMail = await callAgentTool("a", "hab_send", {
      to: state.agents.b.address,
      text: mailText,
      kind: "question",
    });
    assert.equal(sentMail.state, "pending");
    const inboxRead = await callAgentTool("b", "hab_inbox", { limit: 10 });
    assert.equal(inboxRead.messages.length, 1);
    assert.equal(inboxRead.messages[0].message_id, sentMail.message_id);
    assert.equal(inboxRead.messages[0].text, mailText);
    assert.equal(inboxRead.messages[0].presentation.body_untrusted, true);
    const reread = await callAgentTool("b", "hab_inbox", {
      message_id: sentMail.message_id,
    });
    assert.equal(reread.messages.length, 1);
    assert.equal(reread.messages[0].text, mailText);
    const mailStatus = await callAgentTool("a", "hab_status", {
      message_id: sentMail.message_id,
    });
    assert.equal(mailStatus.state, "acked");
    assert.equal(mailStatus.reply_state, "waiting");
    trace("mail_style_roundtrip", {
      messageId: sentMail.message_id,
      untrustedMarked: true,
      rereadRetained: true,
      acked: true,
    });

    result = {
      evidence:
        "real loopback MCP /mcp/delivery (resolve/submit/replay/poll/ACK/replay/status) and mail-style /mcp (send/inbox/reread/status), with independent read-only SQLite commit verification",
      syntheticAuthority: true,
      sameIdReplay: true,
      independentCommittedDelivery: true,
      independentAckedDelivery: true,
      mailStyleRoundtrip: true,
      node: process.version,
      limits:
        "Synthetic verification scaffold, not native products, production OAuth, model/tool execution or approval. No kill-9, power-loss, physical-media or general Task-absence proof.",
    };
  } catch (error) {
    failure = {
      name: error?.name ?? "Error",
      message: String(error?.message ?? error),
    };
    trace("failure", failure);
  } finally {
    if (child) {
      if (!childResult && child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      let exit =
        childResult ??
        (await Promise.race([exited, delay(5000, null, { ref: false })]));
      if (!exit) {
        cleanup.forcedTermination = true;
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        exit =
          childResult ??
          (await Promise.race([exited, delay(2000, null, { ref: false })]));
      }
      cleanup.exitObserved = !!exit;
      cleanup.exit = exit ?? null;
      cleanup.gracefulExit =
        !!exit &&
        exit.code === 0 &&
        !cleanup.forcedTermination &&
        log.includes("HAB_VERIFY_STOPPED");
    } else {
      cleanup.exitObserved = true;
      cleanup.noChildStarted = true;
    }
    if (cleanup.exitObserved && cleanup.errors.length === 0) {
      try {
        rmSync(join(run, "instance"), { recursive: true, force: true });
        cleanup.storesRemoved = true;
      } catch (error) {
        cleanup.errors.push(`remove disposable stores: ${error.message}`);
      }
    }
    cleanup.evidenceRetained = [logPath, tracePath].every(existsSync);
    writeFileSync(
      join(out, "cleanup.json"),
      JSON.stringify(cleanup, null, 2) + "\n",
    );
    process.off("SIGTERM", interrupted);
    process.off("SIGINT", interrupted);
  }
  const clean =
    cleanup.gracefulExit &&
    cleanup.storesRemoved &&
    cleanup.evidenceRetained &&
    cleanup.errors.length === 0;
  const proof = {
    status: !failure && result && clean ? "pass" : "fail",
    ...result,
    failure: failure ?? null,
    cleanup: "see cleanup.json; uncertain stop retains synthetic stores",
  };
  writeFileSync(join(out, "proof.json"), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
  if (proof.status !== "pass") process.exitCode = 1;
}
