import { z } from "zod";
import { OAuthResource } from "./oauth.ts";

export const WORKER_IDENTITY_SCOPES = Object.freeze([
  "hub:get",
  "hub:claim",
  "hub:heartbeat",
  "hub:complete",
]);
const settings = z
  .object({
    version: z.literal(1),
    mode: z.literal("verify-worker-identity"),
    oauth: z.object({ issuer: z.string(), resource: z.string() }).strict(),
    workerClientId: z.string().min(1).max(200),
  })
  .strict();
const headerSchema = z
  .object({
    alg: z.literal("RS256"),
    kid: z.string().min(1).max(200),
    typ: z.literal("JWT").optional(),
  })
  .strict();
const decode = (text: string) =>
  Uint8Array.from(
    atob(
      text
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(text.length / 4) * 4, "="),
    ),
    (c) => c.charCodeAt(0),
  );
const json = (part: string) =>
  JSON.parse(new TextDecoder().decode(decode(part)));

export function workerIdentitySettings(input: unknown) {
  const config = settings.parse(input);
  new OAuthResource({ ...config.oauth, userScopes: ["hub:get"] });
  return config;
}

/** Local operator inspection only. Returns no Principal, writes no registry,
 * creates no listener/DB/key/worker and never authenticates a Hub caller.
 * Subject is read only AFTER cryptographic verification; no @clients guessing.
 */
export async function inspectWorkerIdentity(
  input: unknown,
  authorization: string,
  dependencies: { fetch?: typeof fetch; now?: () => number } = {},
) {
  try {
    const config = workerIdentitySettings(input);
    const resource = new OAuthResource({
      ...config.oauth,
      userScopes: ["hub:get"],
    });
    if (
      authorization.length > 16384 ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
        authorization,
      )
    )
      throw Error();
    const [head, body, signature] = authorization.slice(7).split(".");
    const header = headerSchema.parse(json(head));
    const response = await (dependencies.fetch ?? fetch)(resource.jwksURL, {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
      headers: { Accept: "application/json" },
    });
    if (
      !response.ok ||
      !response.body ||
      (response.url && response.url !== resource.jwksURL)
    )
      throw Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 65536) throw Error();
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const jwks = z
      .object({
        keys: z
          .array(
            z
              .object({
                kty: z.literal("RSA"),
                kid: z.string().min(1).max(200),
                n: z
                  .string()
                  .regex(/^[A-Za-z0-9_-]+$/)
                  .max(1400),
                e: z.literal("AQAB"),
                alg: z.literal("RS256"),
                use: z.literal("sig").optional(),
                key_ops: z.array(z.literal("verify")).optional(),
              })
              .passthrough(),
          )
          .min(1)
          .max(20),
      })
      .parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (
      new Set(jwks.keys.map((k) => k.kid)).size !== jwks.keys.length ||
      jwks.keys.some((k) =>
        ["d", "p", "q", "dp", "dq", "qi"].some((name) => name in k),
      )
    )
      throw Error();
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) throw Error();
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      (key.algorithm as RsaHashedKeyAlgorithm).modulusLength < 2048 ||
      !(await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        decode(signature),
        new TextEncoder().encode(`${head}.${body}`),
      ))
    )
      throw Error();
    const claims = z
      .object({
        iss: z.literal(resource.issuer),
        aud: z.union([z.string(), z.array(z.string())]),
        sub: z.string().min(1).max(200),
        azp: z.string().optional(),
        client_id: z.string().optional(),
        iat: z.number().int(),
        exp: z.number().int(),
        nbf: z.number().int().optional(),
        gty: z.literal("client-credentials"),
        scope: z.string().max(500),
      })
      .passthrough()
      .parse(json(body));
    const now = () => Math.floor((dependencies.now ?? Date.now)() / 1000);
    const scopes = claims.scope.split(" ");
    if (
      !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(
        resource.resource,
      ) ||
      claims.iat > now() ||
      claims.exp <= now() ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 600 ||
      (claims.nbf ?? now()) > now() ||
      !(claims.azp || claims.client_id) ||
      [claims.azp, claims.client_id].some(
        (value) => value !== undefined && value !== config.workerClientId,
      ) ||
      scopes.length !== WORKER_IDENTITY_SCOPES.length ||
      !WORKER_IDENTITY_SCOPES.every((scope) => scopes.includes(scope)) ||
      ["cnf", "act", "authorization_details"].some((name) => name in claims)
    )
      throw Error();
    return Object.freeze({
      kind: "verified_worker_candidate" as const,
      issuer: resource.issuer,
      resource: resource.resource,
      subject: claims.sub,
      clientId: config.workerClientId,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      scopes: WORKER_IDENTITY_SCOPES,
      enrolled: false as const,
    });
  } catch {
    throw Error("worker_identity_rejected");
  }
}
