/**
 * Product recipes (plan 4): how one product connects to HAB, kept as data so the setup
 * guide, the operator CLI and a later `onboard` read the same facts. A recipe holds only
 * public setup text: never a key, token, Webhook URL or anyone's address.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseHabAddress } from "../hab/registry.ts";
import { HostAdminError } from "./admin.ts";

export const RECIPE_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "config",
  "products",
);

const text = z.string().min(1).max(4000);
/** Placeholders the CLI fills in, written exactly as the setup guide writes them. */
const placeholder = z.enum([
  "address",
  "agent_name",
  "allowed",
  "conversation",
]);

const recipeSchema = z.strictObject({
  version: z.literal(1),
  product: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  label: z.string().min(1).max(64),
  /** The section of docs/connections/agent-setup.md this recipe follows. */
  setup_heading: z.string().min(1).max(128),
  receive: z.strictObject({
    mode: z.enum(["hook", "poll", "on_request"]),
    interval_ms: z.number().int().min(60_000).max(86_400_000).optional(),
    /** What wakes the product: its own MCP Events subscription, an operator doorbell, … */
    via: z.enum([
      "mcp_events",
      "operator_doorbell",
      "notifier_wake",
      "scheduled_task",
      "when_asked",
    ]),
  }),
  auth0_app: z.enum(["regular_web", "public"]),
  product_steps: z.array(text).min(1).max(12),
  agent_prompt: text.nullable(),
  operator_steps: z.array(text).min(1).max(12),
  /** What a working connection shows: doctor checks that read ok, and test-message stages. */
  expect: z.strictObject({
    doctor_ok: z.array(z.enum(["registration", "receive", "reading"])).min(1),
    stages: z.array(z.enum(["accepted", "rang", "read", "replied"])).min(1),
  }),
  placeholders: z.record(z.string().regex(/^<[^<>]{1,32}>$/), placeholder),
});
export type ProductRecipe = z.infer<typeof recipeSchema>;

/** Parse one recipe; the mode and interval must agree as `hab:admin receive` requires. */
export function parseRecipe(input: unknown): ProductRecipe {
  const parsed = recipeSchema.safeParse(input);
  if (!parsed.success) throw new HostAdminError("invalid_recipe");
  const recipe = parsed.data;
  const poll = recipe.receive.mode === "poll";
  if (poll !== (recipe.receive.interval_ms !== undefined))
    throw new HostAdminError("invalid_recipe");
  return recipe;
}

export function listRecipes(directory = RECIPE_DIRECTORY): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

export function loadRecipe(
  product: string,
  directory = RECIPE_DIRECTORY,
): ProductRecipe {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(product))
    throw new HostAdminError("unknown_product");
  if (!listRecipes(directory).includes(product))
    throw new HostAdminError("unknown_product");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(directory, `${product}.json`), "utf8"));
  } catch {
    throw new HostAdminError("invalid_recipe");
  }
  const recipe = parseRecipe(raw);
  if (recipe.product !== product) throw new HostAdminError("invalid_recipe");
  return recipe;
}

export interface RecipeValues {
  address?: string;
  allowed?: string;
  conversation?: string;
}

/**
 * The recipe with its placeholders filled where a value was given. The agent name is
 * taken from the address. Unfilled placeholders stay as written, for the operator.
 */
export function fillRecipe(recipe: ProductRecipe, values: RecipeValues = {}) {
  let agentName: string | undefined;
  if (values.address !== undefined) {
    try {
      agentName = parseHabAddress(values.address).agent_name;
    } catch {
      throw new HostAdminError("invalid_address");
    }
  }
  const known: Record<string, string | undefined> = {
    address: values.address,
    agent_name: agentName,
    allowed: values.allowed,
    conversation: values.conversation,
  };
  const fill = (value: string) =>
    Object.entries(recipe.placeholders).reduce(
      (out, [mark, name]) =>
        known[name] === undefined ? out : out.split(mark).join(known[name]!),
      value,
    );
  return {
    ...recipe,
    product_steps: recipe.product_steps.map(fill),
    agent_prompt:
      recipe.agent_prompt === null ? null : fill(recipe.agent_prompt),
    operator_steps: recipe.operator_steps.map(fill),
    unfilled: Object.keys(recipe.placeholders).filter(
      (mark) =>
        known[recipe.placeholders[mark]] === undefined &&
        [
          ...recipe.product_steps,
          recipe.agent_prompt ?? "",
          ...recipe.operator_steps,
        ].some((value) => value.includes(mark)),
    ),
  };
}
