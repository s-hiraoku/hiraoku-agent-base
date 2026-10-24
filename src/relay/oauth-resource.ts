/** Fixed resource discovery only; no registration, login, token issuance or network IO. */
const validMcpPath = (path: string) =>
  /^\/(?:[A-Za-z0-9_-]+\/)*mcp$/.test(path) && path.length <= 200;
export const RELAY_OAUTH_SCOPES = Object.freeze([
  "relay:resolve",
  "relay:submit",
  "relay:status",
  "relay:poll",
  "relay:ack",
]);
export class RelayOAuthResource {
  readonly issuer: string;
  readonly resource: string;
  readonly metadataPath: string;
  readonly metadataURL: string;
  constructor(issuer: string, resource: string) {
    try {
      const i = new URL(issuer),
        r = new URL(resource);
      if (
        i.protocol !== "https:" ||
        i.href !== issuer ||
        i.pathname !== "/" ||
        i.port ||
        i.username ||
        i.password ||
        i.search ||
        i.hash ||
        !/^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.auth0\.com$/.test(i.hostname) ||
        r.protocol !== "https:" ||
        r.href !== resource ||
        r.username ||
        r.password ||
        r.search ||
        r.hash ||
        !validMcpPath(r.pathname)
      )
        throw Error();
      this.issuer = issuer;
      this.resource = resource;
      this.metadataPath = `/.well-known/oauth-protected-resource${r.pathname}`;
      this.metadataURL = r.origin + this.metadataPath;
    } catch {
      throw Error("invalid_relay_oauth_resource");
    }
    Object.freeze(this);
  }
  challenge() {
    return `Bearer resource_metadata="${this.metadataURL}", scope="${RELAY_OAUTH_SCOPES.join(" ")}"`;
  }
  response(path: string, method: string): Response | undefined {
    if (path !== this.metadataPath) return;
    return new Response(
      method === "GET"
        ? JSON.stringify({
            resource: this.resource,
            authorization_servers: [this.issuer],
            scopes_supported: RELAY_OAUTH_SCOPES,
            bearer_methods_supported: ["header"],
          })
        : null,
      {
        status: method === "GET" ? 200 : 405,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
