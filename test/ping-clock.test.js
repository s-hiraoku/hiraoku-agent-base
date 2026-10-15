import assert from "node:assert/strict";
import { test } from "node:test";
import { Hub } from "../src/sqlite.ts";
import { PingService } from "../src/ping.ts";
import { routes, dots } from "./ping-suite.js";

for (const ttl of [1000, 60000, 300000])
  test(`changing database clock preserves ping TTL ${ttl} and idempotent retry`, async () => {
    let tick = 1000000;
    const hub = new Hub(":memory:", () => tick++);
    const service = new PingService(hub, routes);
    try {
      const input = {
        request_key: "changing-clock",
        payload: "ping",
        ttl_ms: ttl,
      };
      const first = await service.submit(dots, input);
      const row = hub.sqlite.db
        .prepare("SELECT created,expires,at FROM diagnostic_pings WHERE id=?")
        .get(first.id);
      assert.equal(row.expires - row.created, input.ttl_ms);
      assert.equal(row.at, row.created);
      assert.equal(first.state, "pending");
      const duplicate = await service.submit(dots, input);
      assert.equal(duplicate.id, first.id);
      assert.equal(duplicate.correlation_id, first.correlation_id);
      assert.equal(
        hub.sqlite.db.prepare("SELECT count(*) n FROM diagnostic_pings").get()
          .n,
        1,
      );
      await assert.rejects(
        service.submit(dots, {
          ...input,
          ttl_ms: ttl === 1000 ? 1001 : ttl - 1,
        }),
        /ping_idempotency_conflict/,
      );
    } finally {
      hub.close();
    }
  });
