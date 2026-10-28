import { PinnedRelayOAuthAuthority } from "../src/relay-host/oauth-auth.ts";
import { RELAY_OAUTH_SCOPES } from "../src/relay/oauth-resource.ts";
export const issuer = "https://synthetic-tenant.jp.auth0.com/";
export const resource = "https://relay.example/hab/mcp";
const keys = crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
export async function oauthFixture(realtime = false) {
  const pair = await keys,
    publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const start = Math.floor(Date.now() / 1000) * 1000;
  let now = start;
  const record = {
    subject: "synthetic-owner",
    client_id: "synthetic-public-client",
    connection_id: "verified-connection",
    issued_at: new Date(start).toISOString(),
    expires_at: new Date(start + 900000).toISOString(),
  };
  let config = {
    version: 1,
    enabled: true,
    issuer,
    resource,
    keys: [
      {
        kty: "RSA",
        alg: "RS256",
        use: "sig",
        kid: "synthetic-key",
        n: publicKey.n,
        e: publicKey.e,
      },
    ],
    connections: [record],
  };
  const auth = await PinnedRelayOAuthAuthority.create(
    () => config,
    () => (realtime ? Date.now() : now),
  );
  const token = async (patch = {}, headerPatch = {}, key = pair.privateKey) => {
    const h = Buffer.from(
      JSON.stringify({
        alg: "RS256",
        kid: "synthetic-key",
        typ: "JWT",
        ...headerPatch,
      }),
    ).toString("base64url");
    const p = Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: resource,
        sub: record.subject,
        azp: record.client_id,
        iat: start / 1000,
        exp: start / 1000 + 600,
        scope: RELAY_OAUTH_SCOPES.join(" "),
        ...patch,
      }),
    ).toString("base64url");
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(h + "." + p),
    );
    return h + "." + p + "." + Buffer.from(sig).toString("base64url");
  };
  const verify = (jwt, patch = {}) =>
    auth.verify({
      authorization: "Bearer " + jwt,
      resource,
      signal: new AbortController().signal,
      ...patch,
    });
  return {
    auth,
    record,
    start,
    token,
    verify,
    getConfig: () => config,
    setConfig: (value) => {
      config = value;
    },
    setNow: (value) => {
      now = value;
    },
  };
}

export async function persistentOAuthFixture(realtime = false) {
  const f = await oauthFixture(realtime);
  const { issued_at, subject, client_id, connection_id } = f.record;
  const participation = {
    subject,
    client_id,
    connection_id,
    approved_at: issued_at,
    approved_until: new Date(f.start + 30 * 86400000).toISOString(),
    state: "active",
  };
  f.setConfig({
    ...f.getConfig(),
    version: 2,
    mode: "persistent",
    max_access_token_lifetime_seconds: 600,
    connections: [participation],
  });
  return { ...f, participation };
}
