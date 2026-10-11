import {
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Hub } from "./sqlite.ts";
import { createRuntime } from "./runtime.ts";
import { OAuthResource, ApprovedSubjects } from "./oauth.ts";
import { RESPONSE } from "./types.ts";
export const READBACK_FIXTURE_ID = "11111111-1111-4111-8111-111111111111";
export const READBACK_FIXTURE_ACTOR = "synthetic-readback-fixture-v1";
export const READBACK_FIXTURE_KEY = "synthetic-positive-get-v1";
const configSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("auth0"),
    enabled: z.literal(true),
    oauth: z
      .object({
        issuer: z.string(),
        resource: z.string(),
        scopes: z.tuple([z.literal("hub:get")]),
      })
      .strict(),
    subjects: z.tuple([
      z
        .object({
          subject: z.string().min(1).max(200),
          clientId: z.string().min(1).max(200),
          kind: z.literal("user"),
          operations: z.tuple([z.literal("get")]),
        })
        .strict(),
    ]),
  })
  .strict();
/** Manual, exclusive new-DB fixture. No submit/claim/worker/Run/model/outbox.
 * Terminal state is synthetic; actor and absent run_id preserve that provenance.
 * Never an MCP tool and never permitted to seed an existing DB.
 */
export function prepareReadbackFixture(directory: string, input: unknown) {
  const config = configSchema.parse(input);
  new OAuthResource({
    issuer: config.oauth.issuer,
    resource: config.oauth.resource,
    userScopes: ["hub:get"],
  });
  new ApprovedSubjects(config.subjects, { enabled: true });
  const root = resolve(directory);
  const stat = lstatSync(root);
  if (
    realpathSync(root) !== root ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw Error("readback_private_directory_required");
  const database = join(root, "readback-hub.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      lstatSync(database + suffix);
      throw Error("readback_existing_artifact_rejected");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  closeSync(openSync(database, "wx", 0o600));
  const hub = new Hub(database);
  try {
    chmodSync(database, 0o600);
    createRuntime(hub, config);
    hub.sqlite.db
      .prepare(
        "INSERT INTO tasks(id,owner,destination,request_key,task_type,state,execution_open,fence,result,actor,at,mutation) VALUES(?,?,'hermes',?,'connectivity_check','succeeded',0,0,?,?,hub_now(),?)",
      )
      .run(
        READBACK_FIXTURE_ID,
        config.subjects[0].subject,
        READBACK_FIXTURE_KEY,
        RESPONSE,
        READBACK_FIXTURE_ACTOR,
        READBACK_FIXTURE_ACTOR,
      );
    return Object.freeze({
      id: READBACK_FIXTURE_ID,
      state: "succeeded",
      result: RESPONSE,
      synthetic: true,
      database,
    });
  } finally {
    hub.close();
  }
}
