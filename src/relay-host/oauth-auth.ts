/** Pinned public-key OAuth boundary. No issuer discovery, grant, refresh or outbound IO. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  RegistryAuthority,
  IndividualPrincipal,
} from "../hab/registry.ts";
import type { RelayHttpVerifier } from "../relay/http.ts";
import {
  RelayOAuthResource,
  RELAY_OAUTH_SCOPES,
} from "../relay/oauth-resource.ts";
const claim = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\x00-\x1f\x7f]+$(?![\s\S])/);
const b64 = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const timestamp = z
  .string()
  .refine(
    (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
  );
// Operator binds this verified connection to a registry individual or authentication group.
// A shared owner/client proves a shared trust boundary, not which Bot selected an address.
const connection = z
  .strictObject({
    subject: claim,
    client_id: claim,
    connection_id: claim,
    issued_at: timestamp,
    expires_at: timestamp,
  })
  .refine(
    (v) =>
      Date.parse(v.expires_at) > Date.parse(v.issued_at) &&
      Date.parse(v.expires_at) - Date.parse(v.issued_at) <= 900000,
  );
const jwk = z.strictObject({
  kty: z.literal("RSA"),
  alg: z.literal("RS256"),
  use: z.literal("sig"),
  kid: claim,
  n: b64,
  e: b64,
});
const schema = z
  .strictObject({
    version: z.literal(1),
    enabled: z.boolean(),
    issuer: claim,
    resource: claim,
    keys: z.array(jwk).max(5),
    connections: z.array(connection).max(100),
  })
  .refine((value) => !value.enabled || value.keys.length > 0);
type Config = z.infer<typeof schema>;
/** Shared structural validation for the verifier and trusted operator management. */
export function parseRelayOAuthConfig(input: unknown): Config {
  const config = schema.parse(input);
  new RelayOAuthResource(config.issuer, config.resource);
  const kids = new Set<string>(),
    clients = new Set<string>(),
    connections = new Set<string>();
  for (const key of config.keys) {
    if (kids.has(key.kid)) throw Error("invalid_relay_oauth_config");
    kids.add(key.kid);
  }
  for (const connection of config.connections) {
    const client = JSON.stringify([connection.subject, connection.client_id]);
    if (clients.has(client) || connections.has(connection.connection_id))
      throw Error("invalid_relay_oauth_config");
    clients.add(client);
    connections.add(connection.connection_id);
  }
  return config;
}
function bytes(s: string) {
  const value = Buffer.from(s, "base64url");
  if (value.toString("base64url") !== s) throw Error();
  return value;
}
function jsonPart(s: string) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(s)));
}
const header = z.object({
  alg: z.literal("RS256"),
  kid: claim,
  typ: z.enum(["JWT", "at+jwt"]).optional(),
  crit: z.never().optional(),
  jku: z.never().optional(),
  jwk: z.never().optional(),
  x5u: z.never().optional(),
});
const claims = z.object({
  iss: claim,
  aud: claim,
  sub: claim,
  azp: claim.optional(),
  client_id: claim.optional(),
  scope: z.string().max(4096),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  nbf: z.number().int().nonnegative().optional(),
});
export class PinnedRelayOAuthAuthority {
  readonly #load: () => unknown;
  readonly #now: () => number;
  #last = -Infinity;
  #keysMaterial = "";
  #keys = new Map<string, CryptoKey>();
  readonly #contexts = new WeakMap<
    object,
    {
      material: string;
      principal: IndividualPrincipal;
      expires: number;
    }
  >();
  private constructor(load: () => unknown, now: () => number) {
    this.#load = load;
    this.#now = now;
  }
  static async create(load: () => unknown, now: () => number = Date.now) {
    if (typeof load !== "function" || typeof now !== "function")
      throw Error("invalid_relay_oauth_config");
    const auth = new PinnedRelayOAuthAuthority(load, now);
    try {
      await auth.#importKeys(auth.#current());
    } catch {
      throw Error("invalid_relay_oauth_config");
    }
    return auth;
  }
  #current() {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < this.#last) throw Error();
    this.#last = now;
    const config = parseRelayOAuthConfig(this.#load());
    return {
      config,
      now,
      material: createHash("sha256")
        .update(JSON.stringify(config))
        .digest("hex"),
    };
  }
  async #importKeys(snapshot: { config: Config; material: string }) {
    if (snapshot.material === this.#keysMaterial) return;
    const keys = new Map<string, CryptoKey>();
    for (const key of snapshot.config.keys) {
      bytes(key.n);
      bytes(key.e);
      const imported = await crypto.subtle.importKey(
        "jwk",
        key,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      if ((imported.algorithm as RsaHashedKeyAlgorithm).modulusLength < 2048)
        throw Error();
      keys.set(key.kid, imported);
    }
    // Never publish keys if config was changed while WebCrypto awaited.
    if (this.#current().material !== snapshot.material) throw Error();
    this.#keys = keys;
    this.#keysMaterial = snapshot.material;
  }
  get resource() {
    const { config } = this.#current();
    return new RelayOAuthResource(config.issuer, config.resource);
  }
  readonly verify: RelayHttpVerifier = async ({
    authorization,
    resource,
    signal,
  }) => {
    try {
      const snapshot = this.#current(),
        c = snapshot.config;
      if (
        !c.enabled ||
        signal.aborted ||
        resource !== c.resource ||
        authorization.length > 8192
      )
        return null;
      const match =
        /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$(?![\s\S])/.exec(
          authorization,
        );
      if (!match) return null;
      const h = header.parse(jsonPart(match[1])),
        value = claims.parse(jsonPart(match[2]));
      const clientId = value.azp ?? value.client_id;
      if (
        !clientId ||
        (value.azp && value.client_id && value.azp !== value.client_id) ||
        value.iss !== c.issuer ||
        value.aud !== resource
      )
        return null;
      const scopes = new Set(value.scope.split(" "));
      if (!RELAY_OAUTH_SCOPES.every((s) => scopes.has(s))) return null;
      const binding = c.connections.find(
        (x) => x.subject === value.sub && x.client_id === clientId,
      );
      if (!binding) return null;
      const issued = value.iat * 1000,
        expires = value.exp * 1000;
      if (
        !Number.isSafeInteger(issued) ||
        !Number.isSafeInteger(expires) ||
        issued > snapshot.now ||
        expires <= snapshot.now ||
        expires <= issued ||
        expires - issued > 900000 ||
        (value.nbf !== undefined && value.nbf * 1000 > snapshot.now) ||
        issued < Date.parse(binding.issued_at) ||
        expires > Date.parse(binding.expires_at)
      )
        return null;
      await this.#importKeys(snapshot);
      const key = this.#keys.get(h.kid);
      if (
        !key ||
        !(await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key,
          bytes(match[3]),
          new TextEncoder().encode(match[1] + "." + match[2]),
        ))
      )
        return null;
      const current = this.#current();
      if (
        signal.aborted ||
        current.material !== snapshot.material ||
        current.now >= expires
      )
        return null;
      const context = Object.freeze({});
      this.#contexts.set(context, {
        material: snapshot.material,
        expires,
        principal: {
          issuer: c.issuer,
          audience: resource,
          subject: value.sub,
          client_id: clientId,
          connection_id: binding.connection_id,
        },
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
        const saved = this.#contexts.get(context),
          current = this.#current();
        if (
          !saved ||
          !current.config.enabled ||
          saved.material !== current.material ||
          current.now >= saved.expires
        )
          return undefined;
        return {
          principal: { ...saved.principal },
          expires_at: new Date(
            Math.min(current.now + 1000, saved.expires),
          ).toISOString(),
        };
      } catch {
        return undefined;
      }
    },
  };
}
