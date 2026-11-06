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

// Independent read-only connection: no migration, writes or receiver API can satisfy this gate.
function assertCommittedBeforeAck(path, request, expectedSender, message) {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(request.sender_id, expectedSender);
    assert.equal(request.message_id, message.message_id);
    const row = raw
      .prepare(
        "SELECT body,receipt_confirmed FROM relay_inbox WHERE sender_id=? AND message_id=?",
      )
      .get(expectedSender, message.message_id);
    assert(row, "ACK before independently visible committed inbox body");
    assert.deepEqual(
      JSON.parse(row.body),
      message,
      "committed inbox body differs",
    );
    assert.equal(
      row.receipt_confirmed,
      0,
      "ACK gate expected an unconfirmed receipt",
    );
    const ack = raw
      .prepare(
        "SELECT request,state FROM relay_receiver_acks WHERE request_id=? AND sender_id=? AND message_id=?",
      )
      .get(request.request_id, expectedSender, message.message_id);
    assert(ack, "ACK before independently visible original request journal");
    assert.equal(ack.state, "pending");
    assert.deepEqual(
      JSON.parse(ack.request),
      request,
      "outgoing ACK differs from durable original request",
    );
  } finally {
    raw.close();
  }
}

function guardSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "hab-pre-ack-")),
    path = join(scratch, "guard.sqlite");
  const db = new DatabaseSync(path);
  const message = { message_id: "synthetic-message", body: "synthetic body" };
  const request = {
    sender_id: "synthetic-sender",
    message_id: message.message_id,
    request_id: "original-request",
  };
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE relay_inbox(sender_id TEXT,message_id TEXT,body TEXT,receipt_confirmed INTEGER); CREATE TABLE relay_receiver_acks(request_id TEXT,sender_id TEXT,message_id TEXT,request TEXT,state TEXT);",
    );
    const check = () =>
      assertCommittedBeforeAck(path, request, request.sender_id, message);
    assert.throws(
      check,
      /ACK before independently visible committed inbox body/,
    );
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO relay_inbox VALUES(?,?,?,0)").run(
      request.sender_id,
      message.message_id,
      JSON.stringify(message),
    );
    assert.throws(
      check,
      /ACK before independently visible committed inbox body/,
    );
    db.exec("COMMIT");
    assert.throws(
      check,
      /ACK before independently visible original request journal/,
    );
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO relay_receiver_acks VALUES(?,?,?,?,?)").run(
      request.request_id,
      request.sender_id,
      message.message_id,
      JSON.stringify(request),
      "pending",
    );
    assert.throws(
      check,
      /ACK before independently visible original request journal/,
    );
    db.exec("ROLLBACK");
    db.prepare("INSERT INTO relay_receiver_acks VALUES(?,?,?,?,?)").run(
      request.request_id,
      request.sender_id,
      message.message_id,
      JSON.stringify({ ...request, request_id: "wrong-request" }),
      "pending",
    );
    assert.throws(check, /outgoing ACK differs/);
    db.prepare("UPDATE relay_receiver_acks SET request=?").run(
      JSON.stringify(request),
    );
    check();
    db.prepare("UPDATE relay_inbox SET body=?").run(
      JSON.stringify({ ...message, body: "changed" }),
    );
    assert.throws(check, /committed inbox body differs/);
    console.log(
      JSON.stringify({
        status: "pass",
        scope: "observer guard only; no HAB protocol behavior exercised",
        negativeControls: [
          "ACK before save",
          "uncommitted save",
          "missing journal",
          "uncommitted journal",
          "changed original ACK",
          "changed body",
        ],
        committedOriginalRequestControl: "pass",
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
  const run = join(out, "scaffold"),
    inboxPath = join(out, "receiver.sqlite");
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
    inbox,
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
    const { SQLiteInbox } = await load("src/relay/sqlite-inbox.ts");
    const { DurableReceiver } = await load("src/relay/receiver.ts");
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
    const makeClient = (agent, beforeAck) =>
      new HabMcpClient({
        limits,
        policy: {
          resource_url: state.url,
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
        fetch: async (address, init) => {
          const body = JSON.parse(init.body);
          trace("request", body); // Authorization headers are deliberately absent.
          if (body.params?.name === "relay_ack" && beforeAck)
            beforeAck(body.params.arguments);
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
        },
      });
    const sender = makeClient("a");
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
    const options = {
      agent_id: state.agents.b.agent_id,
      fingerprint_key: new Uint8Array(32).fill(91),
      limits,
      max_records: 10,
      max_body_bytes: 100000,
      max_ack_records: 30,
      ack_retry_ms: 86400000,
      retry_base_ms: 1,
      retry_cap_ms: 10,
      max_attempts: 3,
    };
    inbox = new SQLiteInbox(inboxPath, options);
    inbox.migrate();
    let observed = 0;
    const receiverClient = makeClient("b", (request) => {
      try {
        assertCommittedBeforeAck(
          inboxPath,
          request,
          state.agents.a.agent_id,
          message,
        );
      } catch (error) {
        trace("independent_pre_ack_rejected", { message: error.message });
        throw error;
      }
      observed++;
      trace("independent_pre_ack_read", {
        messageId: message.message_id,
        requestId: request.request_id,
        committedBody: true,
        originalPendingAck: true,
        receiptConfirmed: false,
        observerReadOnly: true,
      });
    });
    const receiver = new DurableReceiver(inbox, receiverClient);
    // JetStream publishes accepted messages on the pump's next cycle, so a poll right after submit can be empty.
    const receiveDeadline = Date.now() + 5000;
    await receiver.receiveOnce();
    while (
      observed === 0 &&
      receiver.inbox().length === 0 &&
      Date.now() < receiveDeadline
    ) {
      await delay(25);
      await receiver.receiveOnce();
    }
    assert.equal(observed, 1);
    const readEntry = () =>
      inbox.withEntry(state.agents.a.agent_id, message.message_id, (entry) =>
        structuredClone(entry),
      );
    assert.deepEqual(readEntry().message, message);
    assert.equal(readEntry().receipt_confirmed, true);
    inbox.close();
    inbox = undefined;
    inbox = new SQLiteInbox(inboxPath, options);
    inbox.migrate();
    assert.deepEqual(readEntry().message, message);
    assert.equal(readEntry().receipt_confirmed, true);
    trace("receiver_clean_reopen", {
      body: "unchanged",
      receiptConfirmed: true,
      keyedIntegrityRead: true,
    });
    const status = await sender.status(message.message_id);
    assert.equal(status.state, "acked");
    assert.equal(await receiverClient.poll(), null);
    result = {
      evidence:
        "real loopback MCP resolve/submit/poll/ACK/status, independent read-only committed inbox + original ACK journal BEFORE network ACK",
      syntheticAuthority: true,
      sameIdReplay: true,
      receiverCleanReopen: true,
      node: process.version,
      limits:
        "Synthetic verification scaffold, not native products, production OAuth, model/tool execution or approval. Orderly receiver-store reopen only; no server restart, kill-9, power-loss, physical-media, lost-response or general Task-absence proof.",
    };
  } catch (error) {
    failure = {
      name: error?.name ?? "Error",
      message: String(error?.message ?? error),
    };
    trace("failure", failure);
  } finally {
    try {
      inbox?.close();
    } catch (error) {
      cleanup.errors.push(`receiver close: ${error.message}`);
    }
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
        for (const path of [inboxPath, `${inboxPath}-wal`, `${inboxPath}-shm`])
          rmSync(path, { force: true });
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
