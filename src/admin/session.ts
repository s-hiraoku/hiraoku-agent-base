import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sessionPath = "/session";
const sessionLifetimeMs = 15 * 60_000;
type Role = "viewer" | "operator";

function randomSecret() {
  return randomBytes(32).toString("base64url");
}

function matches(expected: string, received: string | null | undefined) {
  if (!received || received.length !== expected.length) return false;
  const actual = Buffer.from(received);
  const reference = Buffer.from(expected);
  return (
    actual.length === reference.length && timingSafeEqual(reference, actual)
  );
}

function launcherHtml(origin: string, proof: string) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; form-action ${origin}">
  <title>HAB を開く</title>
</head>
<body>
  <form method="post" action="${origin}${sessionPath}">
    <input type="hidden" name="launch" value="${proof}">
    <button type="submit">HAB を開く</button>
  </form>
</body>
</html>`;
}

export class DashboardSession {
  readonly role: Role;
  #launcher?: { directory: string; path: string; origin: string };
  #launchProof = randomSecret();
  #active?: { authorization: string; expiresAt: number };

  constructor(role: Role) {
    this.role = role;
  }

  writeLauncher(origin: string) {
    const directory = mkdtempSync(join(tmpdir(), "hab-dashboard-"));
    const path = join(directory, "open-dashboard.html");
    this.#launcher = { directory, path, origin };
    writeFileSync(path, launcherHtml(origin, this.#launchProof), {
      flag: "wx",
      mode: 0o600,
    });
    return path;
  }

  exchange(proof: string | null) {
    if (!this.#launcher || !matches(this.#launchProof, proof)) return;
    const { directory, path, origin } = this.#launcher;
    const nextProof = randomSecret();
    const temporaryPath = join(directory, ".open-dashboard.next.html");
    try {
      writeFileSync(temporaryPath, launcherHtml(origin, nextProof), {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, path);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
    this.#launchProof = nextProof;
    const bearer = randomSecret();
    this.#active = {
      authorization: "Bearer " + bearer,
      expiresAt: performance.now() + sessionLifetimeMs,
    };
    return bearer;
  }

  authorized(authorization: string | undefined) {
    return (
      this.#active !== undefined &&
      performance.now() < this.#active.expiresAt &&
      matches(this.#active.authorization, authorization)
    );
  }

  close() {
    this.#active = undefined;
    if (this.#launcher)
      rmSync(this.#launcher.directory, { recursive: true, force: true });
    this.#launcher = undefined;
  }
}
