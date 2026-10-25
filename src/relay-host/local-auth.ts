/** Local opaque credentials only. No issuance, secret persistence, OAuth or IO on import. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RelayHttpVerifier } from "../relay/http.ts";
import type { RegistryAuthority } from "../hab/registry.ts";
const claim = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\x00-\x1f\x7f]+$(?![\s\S])/);
const timestamp = z.string().refine((value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
});
const credential = z
  .strictObject({
    sha256: z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),
    principal: z.strictObject({
      issuer: claim,
      audience: claim,
      subject: claim,
      client_id: claim,
      connection_id: claim,
    }),
    issued_at: timestamp,
    expires_at: timestamp,
  })
  .refine((value) => {
    const lifetime = Date.parse(value.expires_at) - Date.parse(value.issued_at);
    return lifetime > 0 && lifetime <= 900000;
  });
const schema = z.strictObject({
  version: z.literal(1),
  credentials: z.array(credential).max(100),
});
/** The private mapping format, shared with the operator CLI's read-only checks. */
export const localCredentialsSchema = schema;

/** Each verification and operation reloads trusted config, so removal and expiry fence in-flight contexts. */
export class LocalBearerAuthority {
  readonly #load: () => unknown;
  readonly #now: () => number;
  #last = -Infinity;
  readonly #contexts = new WeakMap<
    object,
    { digest: string; material: string; resource: string }
  >();
  constructor(load: () => unknown, now: () => number = Date.now) {
    if (typeof load !== "function" || typeof now !== "function")
      throw Error("invalid_local_authority");
    this.#load = load;
    this.#now = now;
    try {
      this.#current();
    } catch {
      throw Error("invalid_local_credentials");
    }
  }
  #current() {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < this.#last) throw Error();
    this.#last = now;
    const parsed = schema.parse(this.#load());
    const hashes = new Set(),
      connections = new Set();
    for (const record of parsed.credentials) {
      const binding = JSON.stringify(record.principal);
      if (hashes.has(record.sha256) || connections.has(binding)) throw Error();
      hashes.add(record.sha256);
      connections.add(binding);
    }
    return { now, records: parsed.credentials };
  }
  readonly verify: RelayHttpVerifier = ({
    authorization,
    resource,
    signal,
  }) => {
    try {
      if (signal.aborted) return null;
      const match = /^Bearer ([a-f0-9]{64})$(?![\s\S])/i.exec(authorization);
      if (!match) return null;
      const digest = createHash("sha256").update(match[1]).digest("hex");
      const { now, records } = this.#current();
      const record = records.find((value) => value.sha256 === digest);
      if (
        !record ||
        record.principal.audience !== resource ||
        now < Date.parse(record.issued_at) ||
        now >= Date.parse(record.expires_at)
      )
        return null;
      const context = Object.freeze({});
      this.#contexts.set(context, {
        digest,
        material: JSON.stringify(record),
        resource,
      });
      return context;
    } catch {
      return null;
    }
  };
  readonly authority: RegistryAuthority = {
    individual: (context) => {
      try {
        if (!context || typeof context !== "object") return undefined;
        const saved = this.#contexts.get(context);
        if (!saved) return undefined;
        const { now, records } = this.#current();
        const record = records.find((value) => value.sha256 === saved.digest);
        if (
          !record ||
          JSON.stringify(record) !== saved.material ||
          record.principal.audience !== saved.resource ||
          now < Date.parse(record.issued_at) ||
          now >= Date.parse(record.expires_at)
        )
          return undefined;
        return {
          principal: { ...record.principal },
          expires_at: new Date(
            Math.min(now + 1000, Date.parse(record.expires_at)),
          ).toISOString(),
        };
      } catch {
        return undefined;
      }
    },
  };
}
