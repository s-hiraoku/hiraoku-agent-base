/**
 * The tool input schema HAB publishes in tools/list. Some MCP clients (ChatGPT-style
 * connectors among them) reject a schema whose root is not a plain object with
 * `properties`, a JavaScript-only regular expression, or a `$schema` they do not know,
 * and then show "action discovery failed". So the published JSON Schema is the portable
 * subset: no `$schema`, a top-level union flattened into one object, and patterns without
 * lookarounds. Validation is unchanged: every call still goes through the strict zod schema.
 */
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod";

type Json = Record<string, unknown>;

/** `$(?![\s\S])` is how HAB says "end of input, no trailing newline" in JavaScript. */
const END_OF_INPUT = /\$\(\?!\[\\s\\S\]\)/g;

function portablePattern(pattern: string): string {
  return pattern.replace(END_OF_INPUT, "$");
}

function rewrite(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewrite);
  if (value === null || typeof value !== "object") return value;
  const out: Json = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema") continue;
    out[key] =
      key === "pattern" && typeof child === "string"
        ? portablePattern(child)
        : rewrite(child);
  }
  return out;
}

/**
 * One object holding every branch's fields. The field every branch fixes to a constant
 * (the discriminator, such as `action`) becomes an enum, and each other field says in its
 * description which values use it, since the flat schema can no longer say so itself.
 */
function flatten(root: Json): Json {
  const branches = (root.oneOf ?? root.anyOf) as Json[] | undefined;
  if (!Array.isArray(branches) || root.properties !== undefined) return root;
  const fieldsOf = (branch: Json) =>
    (branch.properties ?? {}) as Record<string, Json>;
  const requiredOf = (branch: Json) =>
    Array.isArray(branch.required) ? (branch.required as string[]) : [];
  const discriminator = Object.keys(fieldsOf(branches[0] ?? {})).find((name) =>
    branches.every((branch) => "const" in (fieldsOf(branch)[name] ?? {})),
  );
  const tagOf = (branch: Json) =>
    discriminator === undefined
      ? undefined
      : String(fieldsOf(branch)[discriminator]!.const);
  const properties: Json = {};
  const usedBy = new Map<string, { uses: string[]; needs: string[] }>();
  for (const branch of branches) {
    const tag = tagOf(branch);
    for (const [name, field] of Object.entries(fieldsOf(branch))) {
      properties[name] ??= field;
      if (name === discriminator || tag === undefined) continue;
      const entry = usedBy.get(name) ?? { uses: [], needs: [] };
      (requiredOf(branch).includes(name) ? entry.needs : entry.uses).push(tag);
      usedBy.set(name, entry);
    }
  }
  if (discriminator !== undefined) {
    const field = { ...(properties[discriminator] as Json) };
    delete field.const;
    properties[discriminator] = { ...field, enum: branches.map(tagOf) };
    for (const [name, { uses, needs }] of usedBy) {
      const notes = [
        needs.length
          ? `Required with ${discriminator} ${needs.join(", ")}.`
          : "",
        uses.length ? `Optional with ${discriminator} ${uses.join(", ")}.` : "",
      ].filter(Boolean);
      const field = properties[name] as Json;
      const before =
        typeof field.description === "string" ? field.description + " " : "";
      properties[name] = { ...field, description: before + notes.join(" ") };
    }
  }
  const required = branches
    .map(requiredOf)
    .reduce((all, own) => all.filter((name) => own.includes(name)));
  const rest = { ...root };
  delete rest.oneOf;
  delete rest.anyOf;
  return {
    ...rest,
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/** The portable JSON Schema for one zod input schema. */
export function portableInputJsonSchema(schema: z.ZodType): Json {
  const json = schema["~standard"].jsonSchema!.input({
    target: "draft-2020-12",
  }) as Json;
  return flatten(rewrite(json) as Json);
}

/** Wrap a zod schema: tools/list shows the portable JSON Schema, calls use zod. */
export function publishedInputSchema(
  schema: z.ZodType,
): StandardSchemaWithJSON {
  let json: Json | undefined;
  const standard = schema["~standard"];
  const listed = () => (json ??= portableInputJsonSchema(schema));
  return {
    "~standard": {
      version: 1,
      vendor: "hab",
      validate: (value: unknown) => standard.validate(value),
      jsonSchema: { input: listed, output: listed },
    },
  } as StandardSchemaWithJSON;
}
