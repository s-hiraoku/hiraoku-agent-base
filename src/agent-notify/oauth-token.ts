/**
 * The notifier's own OAuth token, refreshed by the notifier itself.
 *
 * The notifier keeps its own grant in its own owner-only file, separate from the agent's
 * (such as Hermes' `mcp-tokens/hab.json`). Sharing the agent's file would make both sides
 * spend one rotating refresh token: the second use of a rotated refresh token is reuse, and
 * an issuer with reuse detection (Auth0) then revokes the whole family, the agent's too.
 * With its own grant the notifier keeps working while the agent is idle, and never writes a
 * file the agent reads.
 *
 * Several notifier processes share the file (`run`, and `action` / `decide` started by the
 * agent's screen), so a refresh happens only under a lock file next to it: the holder reads
 * the file again, refreshes only if it is still due, and replaces the file atomically.
 * Waiting processes then read the new token. Tokens are never printed or logged.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { z } from "zod";
import { MessagingError } from "../messaging/delivery-service.ts";
import { HAB_OAUTH_SCOPES } from "../host/mcp/oauth-resource.ts";

/** HAB checks every scope on each token; offline_access asks the issuer for a refresh token. */
export const NOTIFIER_OAUTH_SCOPE = [
  ...HAB_OAUTH_SCOPES,
  "offline_access",
].join(" ");

export interface OAuthTokenOptions {
  /** The notifier's own token file (created 0600; refused if group or other can read it). */
  file: string;
  token_endpoint: string;
  client_id: string;
  /** Sent as `resource` (RFC 8707), the HAB agent endpoint. */
  resource: string;
  /** Optional Auth0 `audience`, for a tenant that does not map `resource`. */
  audience?: string;
  /** Refresh this long before the access token expires. */
  refresh_before_ms?: number;
  /** One token request, connect to answer. */
  timeout_ms?: number;
  /** How long a process waits for another process's refresh. */
  lock_wait_ms?: number;
  /** A lock older than this was left by a process that died; it is removed. */
  lock_stale_ms?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const storedSchema = z.object({
  access_token: z.string().min(1).max(8192).optional(),
  refresh_token: z.string().min(1).max(8192).optional(),
  /** Epoch seconds. */
  expires_at: z.number().finite().optional(),
  scope: z.string().max(4096).optional(),
});
type Stored = z.infer<typeof storedSchema>;

const grantSchema = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z
    .string()
    .refine((type) => type.toLowerCase() === "bearer")
    .optional(),
  expires_in: z
    .number()
    .finite()
    .positive()
    .max(366 * 24 * 3600),
  refresh_token: z.string().min(1).max(8192).optional(),
  scope: z.string().max(4096).optional(),
});

const MAX_RESPONSE_BYTES = 64 * 1024;

/** Token endpoints are https; plain http only to a loopback address (local tests). */
export function validTokenUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function readStored(file: string): Stored | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new MessagingError("insecure_token_file");
    throw new MessagingError("token_unavailable");
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0)
      throw new MessagingError("insecure_token_file");
    const parsed = storedSchema.safeParse(JSON.parse(readFileSync(fd, "utf8")));
    if (!parsed.success) throw new MessagingError("token_unavailable");
    return parsed.data;
  } catch (error) {
    if (error instanceof MessagingError) throw error;
    throw new MessagingError("token_unavailable");
  } finally {
    closeSync(fd);
  }
}

/** Writes a new owner-only file beside the old one, then renames it into place. */
function writeStored(file: string, value: Stored) {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(
    temp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const bytes = Buffer.from(JSON.stringify(value) + "\n", "utf8");
    for (let done = 0; done < bytes.length;)
      done += writeSync(fd, bytes, done, bytes.length - done);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temp);
    throw new MessagingError("token_write_failed", {
      reason: (error as Error).message,
    });
  }
  closeSync(fd);
  try {
    renameSync(temp, file);
  } catch {
    unlinkSync(temp);
    throw new MessagingError("token_write_failed");
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The `exp` of a JWT, in ms; undefined for an opaque token. Read only, never verified. */
export function jwtExpiry(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

export class OAuthTokenFile {
  readonly #o: Required<Omit<OAuthTokenOptions, "audience" | "fetch" | "now">> &
    Pick<OAuthTokenOptions, "audience">;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  constructor(options: OAuthTokenOptions) {
    if (!validTokenUrl(options.token_endpoint))
      throw new MessagingError("invalid_request");
    this.#o = {
      refresh_before_ms: 60_000,
      timeout_ms: 15_000,
      lock_wait_ms: 20_000,
      lock_stale_ms: 60_000,
      ...options,
    };
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  #expiry(stored: Stored): number | undefined {
    if (stored.expires_at !== undefined) return stored.expires_at * 1000;
    return stored.access_token ? jwtExpiry(stored.access_token) : undefined;
  }

  #fresh(
    stored: Stored | undefined,
  ): stored is Stored & { access_token: string } {
    if (!stored?.access_token) return false;
    const expiry = this.#expiry(stored);
    return (
      expiry === undefined || expiry > this.#now() + this.#o.refresh_before_ms
    );
  }

  /** The current `Bearer …` value, refreshing first when it is due. */
  async authorization(): Promise<string> {
    const stored = readStored(this.#o.file);
    if (this.#fresh(stored)) return `Bearer ${stored.access_token}`;
    if (!stored) throw new MessagingError("token_login_required");
    if (!stored.refresh_token) return this.#stillValid(stored);
    return this.#locked(async () => {
      // Another process may have refreshed while this one waited.
      const current = readStored(this.#o.file);
      if (this.#fresh(current)) return `Bearer ${current.access_token}`;
      if (!current?.refresh_token) return this.#stillValid(current);
      const grant = await this.#request({
        grant_type: "refresh_token",
        refresh_token: current.refresh_token,
      });
      // An issuer that does not rotate omits refresh_token: keep the one just used.
      this.#save(grant, current.refresh_token);
      return `Bearer ${grant.access_token}`;
    });
  }

  /** Without a refresh token the access token is used until it expires, then a login is due. */
  #stillValid(stored: Stored | undefined): string {
    const expiry = stored ? this.#expiry(stored) : undefined;
    if (stored?.access_token && (expiry === undefined || expiry > this.#now()))
      return `Bearer ${stored.access_token}`;
    throw new MessagingError("token_login_required");
  }

  /** Why a call cannot be made now, or undefined. Refreshes as a side effect. */
  async problem(): Promise<string | undefined> {
    try {
      await this.authorization();
      return undefined;
    } catch (error) {
      return error instanceof MessagingError ? error.code : "token_unavailable";
    }
  }

  /** Creates the token file's folder (0700) on first use, before anything is issued. */
  prepare() {
    try {
      mkdirSync(dirname(this.#o.file), { recursive: true, mode: 0o700 });
    } catch {
      throw new MessagingError("token_unavailable");
    }
  }

  /** Exchanges an authorization code (the `login` command) and stores the grant. */
  async exchangeCode(code: string, verifier: string, redirectUri: string) {
    const grant = await this.#request({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    await this.#locked(async () => this.#save(grant, undefined));
    return { has_refresh_token: grant.refresh_token !== undefined };
  }

  #save(
    grant: z.infer<typeof grantSchema>,
    previousRefresh: string | undefined,
  ) {
    const refresh = grant.refresh_token ?? previousRefresh;
    writeStored(this.#o.file, {
      access_token: grant.access_token,
      ...(refresh ? { refresh_token: refresh } : {}),
      expires_at: Math.floor(this.#now() / 1000 + grant.expires_in),
      ...(grant.scope !== undefined ? { scope: grant.scope } : {}),
    });
  }

  async #request(params: Record<string, string>) {
    const body = new URLSearchParams({
      ...params,
      client_id: this.#o.client_id,
      resource: this.#o.resource,
      ...(this.#o.audience ? { audience: this.#o.audience } : {}),
    });
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(this.#o.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.#o.timeout_ms),
      });
      text = await response.text();
    } catch {
      throw new MessagingError("token_refresh_failed");
    }
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES)
      throw new MessagingError("token_refresh_failed");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MessagingError("token_refresh_failed");
    }
    if (!response.ok) {
      const error = (json as { error?: unknown } | null)?.error;
      // The grant is gone (revoked, expired, reused): only a new login brings it back.
      if (
        (response.status === 400 || response.status === 401) &&
        (error === "invalid_grant" || error === "unauthorized_client")
      )
        throw new MessagingError("token_login_required", { reason: error });
      throw new MessagingError("token_refresh_failed");
    }
    const grant = grantSchema.safeParse(json);
    if (!grant.success) throw new MessagingError("token_refresh_failed");
    return grant.data;
  }

  /**
   * Runs `work` while holding `<file>.lock`, created with O_EXCL so one process holds it.
   * The lock names its holder by a random nonce, and the holder removes only its own lock.
   */
  async #locked<T>(work: () => Promise<T>): Promise<T> {
    const lock = `${this.#o.file}.lock`;
    const owner = `${process.pid} ${randomBytes(12).toString("hex")}\n`;
    const deadline = this.#now() + this.#o.lock_wait_ms;
    for (;;) {
      if (createExclusive(lock, owner)) break;
      this.#reclaimStale(lock);
      if (this.#now() >= deadline)
        throw new MessagingError("token_refresh_busy");
      await sleep(100);
    }
    try {
      return await work();
    } finally {
      try {
        if (readFileSync(lock, "utf8") === owner) unlinkSync(lock);
      } catch {
        // Already gone.
      }
    }
  }

  /**
   * Removes a lock left by a process that died while holding it. A token request ends within
   * timeout_ms, far below lock_stale_ms, so only an old lock is stale. Reclaiming happens
   * under a second lock and re-checks the age there, so two processes never both see the
   * same stale lock and then delete the new holder's lock.
   */
  #reclaimStale(lock: string) {
    const stale = (path: string, age: number) => {
      try {
        return Date.now() - statSync(path).mtimeMs > age;
      } catch {
        return false;
      }
    };
    if (!stale(lock, this.#o.lock_stale_ms)) return;
    const guard = `${lock}.reclaim`;
    // The guard is held for a stat and an unlink; one older than lock_stale_ms is a crash.
    if (stale(guard, this.#o.lock_stale_ms)) {
      try {
        unlinkSync(guard);
      } catch {
        // Removed meanwhile.
      }
    }
    const mark = `${process.pid} ${randomBytes(12).toString("hex")}\n`;
    if (!createExclusive(guard, mark)) return;
    try {
      if (stale(lock, this.#o.lock_stale_ms)) unlinkSync(lock);
    } catch {
      // Removed by its holder meanwhile.
    } finally {
      try {
        if (readFileSync(guard, "utf8") === mark) unlinkSync(guard);
      } catch {
        // Already gone.
      }
    }
  }
}

/** Creates `path` 0600 with `text` if it does not exist; false if it already does. */
function createExclusive(path: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new MessagingError("token_unavailable");
  }
  try {
    writeSync(fd, text);
  } catch {
    closeSync(fd);
    unlinkSync(path);
    throw new MessagingError("token_unavailable");
  }
  closeSync(fd);
  return true;
}

export interface LoginOptions {
  authorization_endpoint: string;
  /** A loopback URL registered for the client, such as http://127.0.0.1:8765/callback. */
  redirect_uri: string;
  client_id: string;
  resource: string;
  audience?: string;
  scope?: string;
  /** How long to wait for the browser to come back. */
  timeout_ms?: number;
}

/** Only a loopback redirect: the code must not leave this machine. */
export function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.port !== "" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

const pageHtml = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>hab-notify</title><p>${text}</p>`;

/**
 * Authorization code + PKCE (S256) through a loopback callback. `open` receives the URL the
 * user opens in a browser (it carries no secret). Resolves once the code is exchanged and
 * the grant is stored.
 */
export async function login(
  token: OAuthTokenFile,
  options: LoginOptions,
  open: (url: string) => void,
): Promise<{ has_refresh_token: boolean }> {
  if (
    !validTokenUrl(options.authorization_endpoint) ||
    !validRedirectUri(options.redirect_uri)
  )
    throw new MessagingError("invalid_request");
  // Before the browser is sent anywhere: a code must never be issued with nowhere to keep it.
  token.prepare();
  const redirect = new URL(options.redirect_uri);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const authorize = new URL(options.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: options.client_id,
    redirect_uri: options.redirect_uri,
    scope: options.scope ?? NOTIFIER_OAUTH_SCOPE,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: options.resource,
    ...(options.audience ? { audience: options.audience } : {}),
  }))
    authorize.searchParams.set(key, value);

  return new Promise((resolve, reject) => {
    let settled = false;
    // The single-use code goes to the token endpoint once, even if the browser reloads.
    let claimed = false;
    const finish = (
      error: Error | undefined,
      value?: { has_refresh_token: boolean },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(value!);
    };
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", redirect.origin);
      if (request.method !== "GET" || url.pathname !== redirect.pathname) {
        response.writeHead(404).end();
        return;
      }
      const reply = (status: number, text: string) =>
        response
          .writeHead(status, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          })
          .end(pageHtml(text));
      // A request without our state is not the browser coming back from this login.
      if (url.searchParams.get("state") !== state) {
        reply(400, "このログインの応答ではありません。");
        return;
      }
      if (claimed) {
        reply(409, "このログインはすでに処理しています。");
        return;
      }
      claimed = true;
      const code = url.searchParams.get("code");
      if (url.searchParams.get("error") || !code) {
        reply(400, "ログインできませんでした。ターミナルを確認してください。");
        finish(new MessagingError("login_denied"));
        return;
      }
      token.exchangeCode(code, verifier, options.redirect_uri).then(
        (result) => {
          reply(200, "ログインしました。このタブは閉じてかまいません。");
          finish(undefined, result);
        },
        (error: Error) => {
          reply(
            500,
            "ログインを完了できませんでした。ターミナルを確認してください。",
          );
          finish(error);
        },
      );
    });
    const timer = setTimeout(
      () => finish(new MessagingError("login_timeout")),
      options.timeout_ms ?? 300_000,
    );
    server.once("error", () =>
      finish(new MessagingError("login_port_unavailable")),
    );
    server.listen(
      Number(redirect.port),
      redirect.hostname.replace(/^\[|\]$/g, ""),
      () => open(authorize.href),
    );
  });
}
