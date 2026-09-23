// @effect-diagnostics nodeBuiltinImport:off - Standalone Vercel build entrypoint.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

const version = JSON.parse(await NodeFSP.readFile("apps/web/package.json", "utf8"))
  .version as string;
const commit = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const env = {
  ...process.env,
  APP_VERSION: version,
  T3CODE_WEB_ASSET_BASE: process.env.VERCEL_URL
    ? `/__build/${process.env.VERCEL_URL.replace(/\.vercel\.app$/, "")}/`
    : "/",
  VITE_HOSTED_APP_CHANNEL: "nightly",
  VITE_HOSTED_APP_URL: "https://t3.syndg.dev",
};
NodeChildProcess.execFileSync(
  "node_modules/.bin/vp",
  ["run", "--filter", "@t3tools/web", "build"],
  { env, stdio: "inherit" },
);
NodeChildProcess.execFileSync(
  process.execPath,
  ["scripts/apply-web-brand-assets.ts", "nightly", "apps/web/dist"],
  { env, stdio: "inherit" },
);
await NodeFSP.writeFile("apps/web/dist/fork-build.json", JSON.stringify({ version, commit }));
