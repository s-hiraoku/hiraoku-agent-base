import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fillRecipe,
  listRecipes,
  loadRecipe,
  parseRecipe,
} from "../src/host/product-recipes.ts";
import { main as runHabAdmin } from "../scripts/hab-admin.ts";

const guide = readFileSync("docs/connections/agent-setup.md", "utf8");
const PRODUCTS = ["antigravity", "claude-ai", "dots", "grok", "hermes", "muse"];

test("the six products have a recipe that follows its section of the setup guide", () => {
  assert.deepEqual(listRecipes(), PRODUCTS);
  for (const product of PRODUCTS) {
    const recipe = loadRecipe(product);
    assert.equal(recipe.product, product);
    assert.ok(
      guide.includes(`\n## ${recipe.setup_heading}\n`),
      `${product}: heading "${recipe.setup_heading}" is in the guide`,
    );
    // The text for the product's AI is the guide's, word for word.
    if (recipe.agent_prompt !== null)
      assert.ok(
        guide.includes(recipe.agent_prompt),
        `${product}: agent prompt matches the guide`,
      );
  }
});

test("a recipe's receive mode, operator steps and expected stages agree", () => {
  for (const product of PRODUCTS) {
    const { receive, operator_steps, expect } = loadRecipe(product);
    const steps = operator_steps.join("\n");
    assert.match(
      steps,
      new RegExp(`hab:admin receive .*--mode ${receive.mode}`),
      `${product}: sets its receive mode`,
    );
    assert.equal(
      steps.includes("hab:admin doorbell add"),
      ["operator_doorbell", "notifier_wake"].includes(receive.via),
      `${product}: a doorbell only where the operator rings it`,
    );
    assert.equal(expect.stages[0], "accepted");
    if (receive.mode === "on_request")
      assert.deepEqual(
        expect.stages,
        ["accepted"],
        `${product}: read only when asked`,
      );
    if (receive.mode !== "hook")
      assert.ok(
        !expect.stages.includes("rang"),
        `${product}: no doorbell to ring`,
      );
    assert.match(steps, /hab:admin doctor --address/);
  }
});

test("a recipe that adds a doorbell turns MCP events on first, as its guide section does", () => {
  for (const product of PRODUCTS) {
    const recipe = loadRecipe(product);
    const steps = recipe.operator_steps;
    const doorbell = steps.findIndex((s) =>
      s.includes("hab:admin doorbell add"),
    );
    if (doorbell === -1) continue;
    // `doorbell add` answers events_not_configured on a host without ingress.events.
    const events = steps.findIndex((s) =>
      s.includes("ingress.events があること"),
    );
    assert.ok(
      events !== -1 && events < doorbell,
      `${product}: events before doorbell`,
    );
    assert.doesNotMatch(
      steps[doorbell],
      /(^|。)\s*host の再起動は要らない/,
      `${product}: "no restart" only once events are on`,
    );
    assert.match(
      steps[doorbell],
      /ingress\.events が有効なら、host の再起動は要らない/,
    );
    const section = guide
      .split(`\n## ${recipe.setup_heading}\n`)[1]
      .split("\n## ")[0];
    if (section.includes("hab:admin doorbell add"))
      assert.ok(
        section.indexOf("ingress.events") <
          section.indexOf("hab:admin doorbell add"),
        `${product}: the guide turns events on before the doorbell`,
      );
  }
});

test("recipes hold no secret, token, Webhook URL or real address", () => {
  const allowedUrls = new Set([
    "https://<HAB の公開入口>/hab/mcp",
    "https://claude.ai/api/mcp/auth_callback",
    "https://antigravity.google/oauth-callback",
    "http://127.0.0.1:<wake のポート>/wake",
  ]);
  for (const product of PRODUCTS) {
    const raw = readFileSync(`config/products/${product}.json`, "utf8");
    assert.doesNotMatch(raw, /whsec_|Bearer\s|eyJ[A-Za-z0-9_-]{10,}/, product);
    for (const url of raw.match(/https?:\/\/(?:<[^<>]*>|[^\s"、。）<])+/g) ??
      [])
      assert.ok(allowedUrls.has(url), `${product}: unexpected URL ${url}`);
    assert.doesNotMatch(
      raw,
      /[a-z0-9-]+@[a-z0-9-]+\.hab/,
      `${product}: addresses stay placeholders`,
    );
  }
});

test("filling a recipe puts in the address, its product name and the allowed sender", () => {
  const filled = fillRecipe(loadRecipe("hermes"), {
    address: "hermes-hab@hermes.hab",
    allowed: "stallone@dot.hab",
  });
  assert.match(filled.agent_prompt, /アドレスは hermes-hab@hermes\.hab、/);
  assert.match(
    filled.agent_prompt,
    /自動で受け付ける相手は stallone@dot\.hab だけ/,
  );
  assert.ok(
    filled.operator_steps.some((s) =>
      s.includes("receive --agent-name hermes --mode hook"),
    ),
  );
  // What was not given stays as the guide writes it, and is listed.
  assert.deepEqual(filled.unfilled, ["<会話>"]);
  assert.match(filled.agent_prompt, /Hermes Desktop の <会話> です/);
  assert.throws(() => fillRecipe(loadRecipe("grok"), { address: "nope" }), {
    code: "invalid_address",
  });
});

test("a malformed recipe or an unknown product is refused", () => {
  const good = loadRecipe("muse");
  assert.throws(
    () =>
      parseRecipe({
        ...good,
        receive: { mode: "poll", via: "scheduled_task" },
      }),
    { code: "invalid_recipe" },
  );
  assert.throws(
    () =>
      parseRecipe({
        ...good,
        receive: { mode: "hook", interval_ms: 900000, via: "mcp_events" },
      }),
    { code: "invalid_recipe" },
  );
  assert.throws(() => parseRecipe({ ...good, token: "x" }), {
    code: "invalid_recipe",
  });
  for (const name of ["nobody", "../config", "Dots"])
    assert.throws(() => loadRecipe(name), { code: "unknown_product" });
});

test("hab:admin recipe lists the products and prints one filled in", () => {
  const config = "/nonexistent/service.local.json";
  assert.deepEqual(
    runHabAdmin(["--config", config, "recipe"]).products.map((p) => [
      p.product,
      p.receive,
    ]),
    [
      ["antigravity", "hook"],
      ["claude-ai", "on_request"],
      ["dots", "hook"],
      ["grok", "hook"],
      ["hermes", "hook"],
      ["muse", "poll"],
    ],
  );
  const grok = runHabAdmin([
    "--config",
    config,
    "recipe",
    "--product",
    "grok",
    "--address",
    "grok-bot@grok.hab",
  ]);
  assert.ok(
    grok.operator_steps.some((s) =>
      s.includes("doorbell add --address grok-bot@grok.hab"),
    ),
  );
  assert.throws(
    () => runHabAdmin(["--config", config, "recipe", "--address", "a@b.hab"]),
    { code: "usage" },
  );
  assert.throws(
    () => runHabAdmin(["--config", config, "recipe", "--product", "nobody"]),
    { code: "unknown_product" },
  );
});
