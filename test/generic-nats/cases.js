import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TaskState } from "@a2a-js/sdk";
import { JetStreamRelay } from "../../packages/relay-nats/src/backend.ts";
import { gatePubAck } from "../../packages/relay-nats/test/fixture.js";
import {
  evidencePacket,
  packetMessage,
  canonical,
} from "../../src/generic-nats/protocol.ts";
import { NatsTextClient } from "../../src/generic-nats/client.ts";
import { Hub } from "../../src/sqlite.ts";
import { Adapter } from "../../src/adapter.ts";
import { Journal } from "../../src/journal.ts";
import { createTextTaskGate } from "../../src/generic-nats/task-gate.ts";
import {
  proof,
  call,
  a2aRequest,
  eventually,
  inboxAt,
  journalAt,
} from "./fixture.js";

const held = async (work) => {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof Error);
  }
};
const effectCount = (f, product) => {
  const db = new DatabaseSync(join(f.root, `${product}-external.sqlite`), {
    readOnly: true,
  });
  try {
    return Number(db.prepare("SELECT count(*) n FROM effects").get().n);
  } finally {
    db.close();
  }
};
const resultRow = (f, product) =>
  f
    .rows()
    .find(
      (row) =>
        row.sender_id === f.route(product).recipient &&
        row.kind === "generic_text_evidence",
    );
const deliver = async (f, product = "paper") => {
  await f.client.sendOnce();
  await f.recipients.get(product).recipient.receiveOnce();
};
const implementations = [
  [
    "actual JetStream carries two official A2A/MCP jobs with reversed and scoped results",
    async (t) => {
      const f = await proof(t),
        a = await f.entrance.a2a("paper"),
        b = await f.entrance.a2a("mirror"),
        m = await f.entrance.mcp("paper"),
        n = await f.entrance.mcp("mirror");
      const first = await a.client.sendMessage(
          a2aRequest(f.entrance.input("a2a-paper", "first")),
          a.options,
        ),
        second = await call(
          n,
          "text_submit",
          f.entrance.input("mcp-mirror", "second"),
        );
      const p = await f.prepare("paper"),
        q = await f.prepare("mirror");
      assert.equal(p.id, first.id);
      assert.equal(q.id, second.id);
      assert.equal(
        (await f.broker.manager.streams.info("HAB")).state.messages,
        0,
        "proxy preparation does not publish",
      );
      await f.client.sendOnce();
      await f.client.sendOnce();
      assert.equal(
        canonical((await f.witness(p.packet.requestId)).message),
        canonical(p.message),
      );
      assert.equal(
        canonical((await f.witness(q.packet.requestId)).message),
        canonical(q.message),
      );
      for (const product of ["paper", "mirror"]) {
        const item = f.recipients.get(product);
        await item.recipient.receiveOnce();
        assert.equal(item.inbox.inbox().length, 1);
        assert.equal(
          item.inbox.inbox()[0].message.recipient_id,
          f.route(product).recipient,
        );
        assert.equal(item.inbox.inbox()[0].receipt_confirmed, true);
        assert.equal(item.runtime.count(), 0);
      }
      assert.equal(
        (await call(m, "text_get", { id: p.id })).result,
        undefined,
        "save ACK is not Task completion",
      );
      assert.deepEqual(
        (await b.client.getTask({ id: q.id }, b.options)).artifacts,
        [],
      );
      for (const product of ["mirror", "paper"]) {
        const item = f.recipients.get(product);
        await item.recipient.executeOnce();
        await item.recipient.sendOnce();
        const row = resultRow(f, product);
        assert.ok(row);
        const body = await f.witness(row.message_id);
        assert.equal(
          body.message.body.parts[0].value.key,
          product === "paper" ? p.key : q.key,
        );
        assert.equal(
          body.message.in_reply_to.message_id,
          product === "paper" ? p.packet.requestId : q.packet.requestId,
        );
        await f.client.receiveOnce();
        await f.adapter(product).once();
      }
      const paper = await call(m, "text_get", { id: p.id }),
        mirror = await b.client.getTask({ id: q.id }, b.options);
      assert.equal(paper.result.text, "paper:first");
      assert.equal(paper.sourceMessageId, "a2a-paper");
      assert.equal(paper.contextId, "context-a2a-paper");
      assert.equal(mirror.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.equal(mirror.artifacts[0].parts[0].content.value, "mirror:SECOND");
      assert.equal(mirror.contextId, "context-mcp-mirror");
      assert.equal(
        (await n.callTool({ name: "text_get", arguments: { id: p.id } }))
          .isError,
        true,
      );
      assert.equal(effectCount(f, "paper"), 1);
      assert.equal(effectCount(f, "mirror"), 1);
    },
  ],
  [
    "lost real PubAck and committed submit response reuse the original request",
    async (t) => {
      const f = await proof(t),
        proxy = await gatePubAck(t, f.broker.options.server),
        backend = f.broker.track(
          await JetStreamRelay.open({
            ...f.broker.options,
            server: proxy.server,
            request_timeout_ms: 300,
          }),
        );
      const real = f.jetStreamTextPort(backend, "a", "a");
      let lost = true;
      await f.openClient({
        transport: {
          ...real,
          async submit(message) {
            const receipt = await real.submit(message);
            if (lost) {
              lost = false;
              throw Error("synthetic_submit_response_lost");
            }
            return receipt;
          },
        },
      });
      await f.submit("paper", "lost-publish");
      const request = await f.prepare();
      const sending = held(() => f.client.sendOnce());
      await proxy.gated;
      proxy.release(true);
      await sending;
      assert.equal(
        (await f.broker.manager.streams.info("HAB")).state.messages,
        1,
      );
      await f.client.sendOnce();
      assert.equal(
        f.rows().filter((row) => row.message_id === request.packet.requestId)
          .length,
        1,
      );
      assert.equal(
        canonical((await f.witness(request.packet.requestId)).message),
        canonical(request.message),
      );
      assert.equal(
        (await f.broker.manager.streams.info("HAB")).state.messages,
        1,
      );
      await f.recipients.get("paper").recipient.receiveOnce();
      await f.finish();
      assert.equal(effectCount(f, "paper"), 1);
    },
  ],
  [
    "lost application ACK before and after commit preserves one saved inbox body",
    async (t) => {
      const f = await proof(t);
      await f.submit("paper", "ack-after");
      await f.submit("mirror", "ack-before");
      const requests = [await f.prepare("paper"), await f.prepare("mirror")];
      await f.client.sendOnce();
      await f.client.sendOnce();
      for (const [i, product] of ["paper", "mirror"].entries()) {
        const real = f.transport(f.route(product).recipient);
        let lose = true;
        const item = await f.openRecipient(product, {
          transport: {
            ...real,
            async ack(input) {
              if (lose) {
                lose = false;
                if (i === 0) await real.ack(input);
                throw Error("synthetic_ack_response_lost");
              }
              return real.ack(input);
            },
          },
        });
        await assert.rejects(item.recipient.receiveOnce());
        assert.equal(item.inbox.inbox().length, 1);
        assert.equal(item.inbox.inbox()[0].receipt_confirmed, false);
        assert.equal(item.runtime.count(), 0);
        const reopened = await f.openRecipient(product);
        await eventually(async () => {
          await reopened.recipient.receiveOnce();
          return reopened.inbox.inbox()[0]?.receipt_confirmed;
        }, "receipt recovers after inbox reopen");
        assert.equal(reopened.inbox.inbox().length, 1);
        assert.equal(
          (await f.transport("a").status(requests[i].packet.requestId)).state,
          "acked",
        );
        await f.finish(product);
        assert.equal(reopened.runtime.count(), 1);
      }
    },
  ],
  [
    "owned receiver process crash after independent effect commit recovers by the same key",
    async (t) => {
      const f = await proof(t);
      await f.submit("paper", "process-crash");
      const request = await f.prepare();
      await f.client.sendOnce();
      const child = await f.spawnRecipient("paper", { crashAfterEffect: true });
      await child.command("receiveOnce");
      const executing = child.command("executeOnce").catch((error) => error);
      const marker = await child.effect;
      assert.equal(marker.key, request.key);
      assert.equal(effectCount(f, "paper"), 1);
      await child.kill("SIGKILL");
      await executing;
      const item = await f.openRecipient("paper");
      assert.equal(item.runtime.calls("create"), 1);
      await item.recipient.executeOnce();
      assert.ok(item.runtime.calls("lookup") >= 1);
      assert.equal(item.runtime.calls("create"), 1);
      t.diagnostic(
        JSON.stringify({
          event: "receiver_recovered",
          key: request.key,
          effects: item.runtime.count(),
          create_calls: item.runtime.calls("create"),
          lookup_calls: item.runtime.calls("lookup"),
        }),
      );
      await item.recipient.sendOnce();
      await f.client.receiveOnce();
      await f.adapter("paper").once();
      assert.equal(
        (await f.hub.get(f.entrance.paper.sender, { id: request.id })).state,
        "succeeded",
      );
      assert.equal(item.runtime.count(), 1);
    },
  ],
  [
    "actual broker SIGKILL preserves accepted work and a missing accepted store fails closed",
    async (t) => {
      const f = await proof(t);
      await f.submit("paper", "broker-crash");
      const request = await f.prepare();
      await f.client.sendOnce();
      await f.witness(request.packet.requestId);
      await f.broker.restart("SIGKILL");
      assert.equal(
        canonical((await f.witness(request.packet.requestId)).message),
        canonical(request.message),
      );
      await f.recipients.get("paper").recipient.receiveOnce();
      await f.finish();
      assert.equal(effectCount(f, "paper"), 1);
      await f.submit("mirror", "missing-store");
      await f.prepare("mirror");
      await f.client.sendOnce();
      await f.broker.close(f.broker.backend);
      await f.broker.manager.streams.delete("HAB");
      await assert.rejects(JetStreamRelay.open(f.broker.options), {
        code: "broker_store_missing",
      });
      await assert.rejects(f.broker.manager.streams.info("HAB"));
      assert.equal(effectCount(f, "mirror"), 0);
    },
  ],
  [
    "coordinator inbox and Task reopen recover a saved result after ACK uncertainty",
    async (t) => {
      const f = await proof(t);
      await f.submit("paper", "coordinator-reopen");
      const request = await f.prepare();
      await deliver(f);
      const item = f.recipients.get("paper");
      await item.recipient.executeOnce();
      await item.recipient.sendOnce();
      let lost = true;
      const real = f.transport("a");
      await f.openClient({
        transport: {
          ...real,
          async ack(input) {
            const receipt = await real.ack(input);
            if (lost) {
              lost = false;
              throw Error("synthetic_result_ack_lost");
            }
            return receipt;
          },
        },
      });
      await assert.rejects(f.client.receiveOnce());
      assert.equal(f.clientInbox.inbox().length, 1);
      assert.equal(f.clientInbox.inbox()[0].receipt_confirmed, false);
      await f.openClient();
      await f.entrance.restart();
      await eventually(async () => {
        await f.client.receiveOnce();
        return (
          (await f.client.runs("paper").get(request.task.run_id)).state ===
          "succeeded"
        );
      });
      await f.adapter("paper").once();
      const m = await f.entrance.mcp("paper");
      assert.equal(
        (await call(m, "text_get", { id: request.id })).result.text,
        "paper:hello",
      );
      assert.equal(item.runtime.count(), 1);
      assert.equal(item.runtime.calls("create"), 1);
    },
  ],
  [
    "two owned receiver processes compete without a duplicate external admission",
    async (t) => {
      const f = await proof(t);
      await f.submit("paper", "competing-processes");
      const request = await f.prepare();
      await f.client.sendOnce();
      const one = await f.spawnRecipient("paper"),
        two = await f.spawnRecipient("paper");
      await Promise.all([
        held(() => one.command("receiveOnce")),
        held(() => two.command("receiveOnce")),
      ]);
      await Promise.all([
        held(() => one.command("executeOnce")),
        held(() => two.command("executeOnce")),
      ]);
      assert.equal(effectCount(f, "paper"), 1);
      await held(() => one.command("sendOnce"));
      await held(() => two.command("sendOnce"));
      await f.client.receiveOnce();
      await f.adapter("paper").once();
      assert.equal(
        (await f.hub.get(f.entrance.paper.sender, { id: request.id })).state,
        "succeeded",
      );
      const db = new DatabaseSync(join(f.root, "paper-external.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(
          db.prepare("SELECT count(*) n FROM calls WHERE kind='create'").get()
            .n,
          1,
        );
      } finally {
        db.close();
      }
      await one.kill();
      await two.kill();
    },
  ],
  [
    "revocation before execution and epoch changes across an effect withhold authority",
    async (t) => {
      const f = await proof(t);
      await f.submit("paper", "revoked-origin");
      const request = await f.prepare();
      await deliver(f);
      const auth = f.hub.authorization;
      for (const subject of [
        f.entrance.paper.sender.subject,
        f.entrance.paper.worker.subject,
        f.route("paper").binding.recipientOwner,
      ]) {
        await auth.setStopped(
          { kind: "subject", id: subject },
          true,
          await auth.epoch(),
          "synthetic-fixture",
        );
        await assert.rejects(f.recipients.get("paper").recipient.executeOnce());
        assert.equal(effectCount(f, "paper"), 0);
        assert.equal(resultRow(f, "paper"), undefined);
        await auth.setStopped(
          { kind: "subject", id: subject },
          false,
          await auth.epoch(),
          "synthetic-fixture",
        );
      }
      const item = f.recipients.get("paper");
      item.runtime.options.afterEffect = async () => {
        await auth.setStopped(
          { kind: "subject", id: "unrelated-synthetic-subject" },
          true,
          await auth.epoch(),
          "synthetic-fixture",
        );
      };
      await assert.rejects(
        item.recipient.executeOnce(),
        /text_authorization_changed/,
      );
      assert.equal(effectCount(f, "paper"), 1);
      assert.equal(item.recipient.inspect(request.key).run.state, "succeeded");
      await held(() => item.recipient.sendOnce());
      assert.equal(resultRow(f, "paper"), undefined);
      f.state.revoked = true;
      await assert.rejects(f.client.runs("paper").get(request.task.run_id));
      f.state.revoked = false;
      assert.equal(
        (await f.client.runs("paper").get(request.task.run_id)).state,
        "running",
      );
    },
  ],
  [
    "original delivery expiry stops new execution while a known result remains durable",
    async (t) => {
      const f = await proof(t);
      await f.submit("paper", "ttl-known");
      const request = await f.prepare();
      await deliver(f);
      await f.finish();
      const before = await f.client.runs("paper").get(request.task.run_id);
      assert.equal(before.state, "succeeded");
      await f.submit("mirror", "ttl-held");
      const other = await f.prepare("mirror");
      await deliver(f, "mirror");
      const first = f.recipients.get("mirror").inbox.inbox()[0]
        .message.first_sent_at;
      f.state.now = other.packet.acceptedAt + 3600000;
      await held(() => f.recipients.get("mirror").recipient.executeOnce());
      assert.equal(effectCount(f, "mirror"), 0);
      assert.equal(
        f.recipients.get("mirror").recipient.inspect(other.key).execute
          .acceptedAt,
        Date.parse(first),
      );
      await f.openClient();
      assert.deepEqual(
        await f.client.runs("paper").get(request.task.run_id),
        before,
      );
      f.state.now = Date.now() - 3600000 + 1000;
      const m = await f.entrance.mcp("paper");
      await call(m, "text_submit", {
        ...f.entrance.input("broker-absolute-expiry"),
        workDeadline: f.state.now + 7200000,
      });
      const expiring = await f.prepare("paper");
      assert.ok(
        expiring.task.text_request.input.workDeadline >
          Date.parse(expiring.message.expires_at),
      );
      await f.client.sendOnce();
      await f.witness(expiring.packet.requestId);
      await delay(
        Math.max(0, Date.parse(expiring.message.expires_at) - Date.now() + 30),
      );
      await f.broker.backend.maintain("admin");
      assert.equal(
        (await f.transport("a").status(expiring.packet.requestId)).state,
        "expired",
      );
      assert.equal(
        (await f.transport("a").submit(expiring.message)).state,
        "expired",
      );
      f.state.now = Date.now();
      await f.recipients.get("paper").recipient.receiveOnce();
      await f.recipients.get("paper").recipient.executeOnce();
      assert.equal(effectCount(f, "paper"), 1);
      assert.equal(effectCount(f, "mirror"), 0);
      assert.equal(
        f.rows().filter((row) => row.message_id === expiring.packet.requestId)
          .length,
        1,
      );
      t.diagnostic(
        JSON.stringify({
          event: "absolute_delivery_expired",
          key: expiring.key,
          first_sent_at: expiring.message.first_sent_at,
          expires_at: expiring.message.expires_at,
          work_deadline: expiring.task.text_request.input.workDeadline,
        }),
      );
    },
  ],
  [
    "an independently restored pre-prepare Task cannot refresh original delivery time",
    async (t) => {
      const f = await proof(t);
      const m = await f.entrance.mcp("paper"),
        input = {
          ...f.entrance.input("restore-preprepare"),
          workDeadline: f.state.now + 7200000,
        };
      const job = await call(m, "text_submit", input);
      const path = join(f.root, "restored-tasks.sqlite");
      await backup(f.hub.sqlite.db, path);
      const restored = new Hub(path, () => f.state.now + 3600001),
        inbox = inboxAt(join(f.root, "restored-inbox.sqlite"), "a"),
        journal = journalAt(
          join(f.root, "restored-journal.sqlite"),
          "restore-coordinator",
        ),
        adapterJournal = new Journal(join(f.root, "restored-adapter.sqlite"));
      const gate = createTextTaskGate(
          restored,
          () => f.entrance.paper.worker,
          () => f.state.now + 3600001,
        ),
        client = new NatsTextClient({
          routes: f.routes,
          transport: f.transport("a"),
          inbox,
          journal,
          gate,
          now: () => f.state.now + 3600001,
        });
      try {
        await held(() =>
          new Adapter(
            restored,
            f.entrance.paper.worker,
            client.runs("paper"),
            adapterJournal,
            { now: () => f.state.now + 3600001 },
          ).once(),
        );
        await held(() => client.sendOnce());
        const task = await restored.get(f.entrance.paper.sender, {
          id: job.id,
        });
        assert.equal(task.text_request.acceptedAt, job.acceptedAt);
        assert.equal(f.rows().length, 0);
        assert.equal(effectCount(f, "paper"), 0);
      } finally {
        await client.close();
        adapterJournal.close();
        journal.close();
        inbox.close();
        restored.close();
      }
    },
  ],
  [
    "changed request content and authenticated wrong-peer evidence cannot complete a Task",
    async (t) => {
      const f = await proof(t);
      await f.submit("paper", "forged-evidence");
      const request = await f.prepare();
      await f.client.sendOnce();
      const altered = structuredClone(request.message);
      altered.body.parts[0].value.input.content.text = "changed";
      await assert.rejects(f.transport("a").submit(altered));
      const forged = evidencePacket(request.packet, "outcome", {
        id: "forged-external-run",
        state: "succeeded",
        text: "must never publish",
      });
      await assert.rejects(
        f
          .transport("c")
          .submit(packetMessage(forged, f.route("paper"), f.state.now)),
        { code: "invalid_reference" },
      );
      await f.submit("mirror", "forger-owned-parent");
      const own = await f.prepare("mirror");
      await f.client.sendOnce();
      const attack = packetMessage(forged, f.route("paper"), f.state.now);
      attack.thread_id = own.message.thread_id;
      attack.in_reply_to = { sender_id: "a", message_id: own.packet.requestId };
      await f.transport("c").submit(attack);
      await assert.rejects(f.client.receiveOnce(), /foreign_text_packet/);
      assert.equal(
        (await f.client.runs("paper").get(request.task.run_id)).state,
        "running",
      );
      assert.equal(
        (await f.hub.get(f.entrance.paper.sender, { id: request.id })).state,
        "running",
      );
      assert.equal(effectCount(f, "paper"), 0);
      await f.recipients.get("paper").recipient.receiveOnce();
      await f.finish();
      assert.equal(
        (await f.hub.get(f.entrance.paper.sender, { id: request.id })).result,
        "paper:hello",
      );
    },
  ],
  [
    "a local save failure sends no ACK and an unverified runtime performs no effect",
    async (t) => {
      const f = await proof(t);
      await f.submit("paper", "save-failure");
      const request = await f.prepare();
      await f.client.sendOnce();
      let acknowledgments = 0;
      const real = f.transport("b");
      const broken = {
        save() {
          throw Error("synthetic_write_failure");
        },
        claimAck() {
          return null;
        },
        confirmAck() {},
        rejectAck() {},
        inbox() {
          return [];
        },
      };
      const item = await f.openRecipient("paper", {
        inbox: broken,
        transport: {
          ...real,
          ack(input) {
            acknowledgments++;
            return real.ack(input);
          },
        },
      });
      await assert.rejects(item.recipient.receiveOnce());
      assert.equal(acknowledgments, 0);
      assert.notEqual(
        (await f.transport("a").status(request.packet.requestId)).state,
        "acked",
      );
      assert.equal(item.runtime.count(), 0);
      const healthy = await f.openRecipient("paper");
      await eventually(async () => {
        await healthy.recipient.receiveOnce();
        return healthy.inbox.inbox().length;
      });
      healthy.runtime.durableIdempotency = false;
      await held(() => healthy.recipient.executeOnce());
      assert.equal(healthy.runtime.count(), 0);
      assert.equal(resultRow(f, "paper"), undefined);
    },
  ],
  [
    "unknown admission and a corrupted reopened record remain held without another create",
    async (t) => {
      const f = await proof(t);
      await f.submit("paper", "unknown-hold");
      await f.prepare();
      await deliver(f);
      const item = f.recipients.get("paper");
      let calls = 0;
      item.runtime.createText = async () => {
        calls++;
        throw Error("external_result_unknown");
      };
      item.runtime.lookupText = undefined;
      await held(() => item.recipient.executeOnce());
      await held(() => item.recipient.executeOnce());
      assert.equal(calls, 1);
      assert.equal(effectCount(f, "paper"), 0);
      await item.close();
      f.recipients.delete("paper");
      const db = new DatabaseSync(join(f.root, "paper-journal.sqlite"));
      try {
        assert.ok(
          db.prepare("SELECT count(*) n FROM generic_nats_records").get().n > 0,
        );
        db.exec("UPDATE generic_nats_records SET data='{}'");
      } finally {
        db.close();
      }
      const reopened = await f.openRecipient("paper");
      await assert.rejects(reopened.recipient.executeOnce());
      assert.equal(reopened.runtime.count(), 0);
      assert.equal(reopened.runtime.calls("create"), 0);
      assert.equal(resultRow(f, "paper"), undefined);
    },
  ],
  [
    "the maximum valid 32KiB escaped text roundtrips on the real broker and oversize is rejected",
    async (t) => {
      const f = await proof(t, { runtime: { paper: { echo: true } } }),
        m = await f.entrance.mcp("paper"),
        text = "\u0001".repeat(32768);
      assert.equal(Buffer.byteLength(text), 32768);
      const job = await call(
          m,
          "text_submit",
          f.entrance.input("max-text", text),
        ),
        request = await f.prepare();
      await f.client.sendOnce();
      const body = await f.witness(request.packet.requestId);
      assert.equal(body.message.body.parts[0].value.input.content.text, text);
      assert.ok(Buffer.byteLength(canonical(body)) > 196608);
      await f.recipients.get("paper").recipient.receiveOnce();
      const item = f.recipients.get("paper");
      await item.recipient.executeOnce();
      await item.recipient.sendOnce();
      const reply = await f.witness(resultRow(f, "paper").message_id);
      assert.equal(reply.message.body.parts[0].value.run.text, text);
      await f.client.receiveOnce();
      await f.adapter("paper").once();
      assert.equal(
        (await call(m, "text_get", { id: job.id })).result.text,
        text,
      );
      await assert.rejects(
        m.callTool({
          name: "text_submit",
          arguments: f.entrance.input("oversize", text + "a"),
        }),
      );
      assert.equal(item.runtime.count(), 1);
    },
  ],
];
export const genericNatsImplementations = implementations;
