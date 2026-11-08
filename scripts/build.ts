import { build } from "esbuild";
await build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: "dist/worker.js",
  external: ["node:*"],
  target: "es2022",
});
