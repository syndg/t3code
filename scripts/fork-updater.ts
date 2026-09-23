#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalTimers:off - The standalone worker owns Node processes and filesystem transactions without an Effect runtime.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import {
  FORK_UPDATE_PORT,
  FORK_UPDATE_SERVICE,
  FORK_UPSTREAM_RELEASES,
  FORK_UPSTREAM_REPOSITORY,
  forkUpdaterPaths,
  isForkNightlyVersion,
  readForkUpdaterConfig,
  writeForkUpdateState,
  type ForkUpdaterConfig,
} from "@t3tools/shared/forkUpdater";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { loadRepoEnv } from "./lib/public-config.ts";

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 256 * 1024;
const DESCRIPTOR_URL = `http://127.0.0.1:${FORK_UPDATE_PORT}/.well-known/t3/environment`;
const Version = Schema.Struct({ version: Schema.String });
const decodeVersion = Schema.decodeUnknownSync(Schema.fromJsonString(Version));
const Descriptor = Schema.Struct({ serverVersion: Schema.String, environmentId: Schema.String });
const decodeDescriptor = Schema.decodeUnknownSync(Descriptor);
const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
});
const decodeRelease = Schema.decodeUnknownSync(Release);
const decodePreflight = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.Literal("ready"),
      version: Schema.String,
      launcherProtocol: Schema.Literal(3),
    }),
  ),
);

type CommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  timeout?: number;
};
type CommandResult = { code: number; stdout: string; stderr: string };
type RunCommand = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

function commandRunner(log: (text: string) => void): RunCommand {
  return (command, args, options) => {
    const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
    log(`\n$ ${command} ${args[0] ?? ""}\n`);
    const child = NodeChildProcess.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      },
      options.timeout ?? 30 * 60_000,
    );
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-MAX_COMMAND_OUTPUT);
      log(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_COMMAND_OUTPUT);
      log(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut || (code !== 0 && !options.allowFailure)) {
        reject(
          new Error(
            `${NodePath.basename(command)} ${args[0] ?? ""} ${timedOut ? "timed out" : `failed (${code})`}: ${stderr.slice(-4000)}`,
          ),
        );
      } else {
        resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
    return promise;
  };
}

function boundedLog(file: string): (text: string) => void {
  NodeFS.writeFileSync(file, "", { mode: 0o600 });
  let size = 0;
  return (text) => {
    const bytes = Buffer.from(text);
    if (size + bytes.length > MAX_LOG_BYTES) {
      const previous = NodeFS.readFileSync(file);
      const retained = previous.subarray(-MAX_LOG_BYTES / 2);
      NodeFS.writeFileSync(file, retained);
      size = retained.length;
    }
    const bounded = bytes.subarray(-MAX_LOG_BYTES / 2);
    NodeFS.appendFileSync(file, bounded);
    size += bounded.length;
  };
}

export function forkCodexEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/API_?KEY|API_?TOKEN|^OPENAI_|^AZURE_OPENAI_|^CODEX_API_|^T3CODE_|^T3_SERVICE_|^VITE_|^NODE_OPTIONS$|^GIT_|^DBUS_SESSION_BUS_ADDRESS$|^XDG_RUNTIME_DIR$/i.test(
          key,
        ),
    ),
  );
}

export function assertPublishedForkNightly(value: unknown, version: string): void {
  if (!isForkNightlyVersion(version)) throw new Error("An exact nightly version is required.");
  const release = decodeRelease(value);
  if (release.draft || release.published_at === null || release.tag_name !== `v${version}`) {
    throw new Error(`v${version} is not a published upstream nightly release.`);
  }
}

export function assertForkService(config: ForkUpdaterConfig, properties: string): void {
  const entry = NodePath.join(forkUpdaterPaths(config.baseDir).current, "apps/server/dist/bin.mjs");
  const argv = `${config.nodeBinary} ${entry} serve --mode web --host 127.0.0.1 --port ${FORK_UPDATE_PORT} --base-dir ${config.baseDir} --no-browser`;
  const executable = properties.split("\n").find((line) => line.startsWith("ExecStart="));
  if (
    !executable?.startsWith(
      `ExecStart={ path=${config.nodeBinary} ; argv[]=${argv} ; ignore_errors=no ;`,
    )
  ) {
    throw new Error(
      `${FORK_UPDATE_SERVICE} must run the fork-updater/current server with the isolated base directory and port ${FORK_UPDATE_PORT}.`,
    );
  }
  if (!/^ActiveState=active$/m.test(properties) || /^EnvironmentFiles=.+$/m.test(properties)) {
    throw new Error(
      "The fork service must be active and must not load unverified environment files.",
    );
  }
  // These can override CLI paths or transfer control to the stock self-updater.
  const environment =
    properties
      .split("\n")
      .find((line) => line.startsWith("Environment="))
      ?.slice("Environment=".length) ?? "";
  if (
    /(?:^|[\s"])(?:NODE_OPTIONS|T3_SERVICE_[A-Z_]+|T3CODE_(?:HOME|BASE_DIR|PORT|MODE|DEV_AUTH_TOKEN))=/.test(
      environment,
    )
  ) {
    throw new Error(
      "The fork service contains runtime overrides incompatible with isolated updates.",
    );
  }
}

async function replaceCurrent(current: string, destination: string): Promise<void> {
  const temporary = `${current}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.symlink(destination, temporary);
    await NodeFSP.rename(temporary, current);
    const directory = await NodeFSP.open(NodePath.dirname(current), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

/** Validation never changes current. Activation failures restore and verify the previous build. */
export async function activateForkBuild(input: {
  current: string;
  candidate: string;
  validate: () => Promise<void>;
  beforeSwitch: () => Promise<void>;
  restart: () => Promise<void>;
  ready: (directory: string) => Promise<void>;
}): Promise<void> {
  const previous = await NodeFSP.realpath(input.current);
  await input.validate();
  await input.beforeSwitch();
  if ((await NodeFSP.realpath(input.current)) !== previous) {
    throw new Error("The active build changed while the update was being prepared.");
  }
  try {
    await replaceCurrent(input.current, input.candidate);
    await input.restart();
    await input.ready(input.candidate);
  } catch (activationError) {
    try {
      await replaceCurrent(input.current, previous);
      await input.restart();
      await input.ready(previous);
    } catch (rollbackError) {
      throw new AggregateError(
        [activationError, rollbackError],
        "Activation and rollback failed; inspect the fork service and job.log.",
        { cause: rollbackError },
      );
    }
    throw new Error("Activation failed; the previous fork build was restored.", {
      cause: activationError,
    });
  }
}

export async function assertForkAncestry(
  directory: string,
  source: string,
  target: string,
): Promise<void> {
  const run = commandRunner(() => {});
  for (const revision of [source, target]) {
    const result = await run("git", ["merge-base", "--is-ancestor", revision, "HEAD"], {
      cwd: directory,
      allowFailure: true,
    });
    if (result.code !== 0) throw new Error(`Validated HEAD must descend from ${revision}.`);
  }
  const unresolved = await run("git", ["ls-files", "--unmerged"], { cwd: directory });
  if (unresolved.stdout) throw new Error("The fork still has unresolved merge conflicts.");
}

export async function assertStagedForkDiff(directory: string, upstreamCommit: string): Promise<void> {
  const run = commandRunner(() => {});
  const unresolved = await run("git", ["ls-files", "--unmerged"], { cwd: directory });
  if (unresolved.stdout) throw new Error("Codex left unresolved merge conflicts.");
  // The merge stages upstream files too. Check only the fork's delta so an
  // unchanged upstream patch containing intentional whitespace cannot block it.
  const diff = await run("git", ["diff", "--cached", upstreamCommit, "--check"], {
    cwd: directory,
    allowFailure: true,
  });
  if (diff.code !== 0)
    throw new Error(`The fork delta has conflict markers or whitespace errors: ${diff.stdout}`);
}

async function fetchDescriptor(url = DESCRIPTOR_URL) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error(`Fork readiness returned HTTP ${response.status}.`);
  return decodeDescriptor(await response.json());
}

/** Boots the built server and runs migrations only against the disposable database snapshot. */
export async function smokeCandidateFork(input: {
  nodeBinary: string;
  candidate: string;
  validationHome: string;
  version: string;
  env: NodeJS.ProcessEnv;
  log: (text: string) => void;
}): Promise<void> {
  const reservation = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a validation port.");
  const child = NodeChildProcess.spawn(
    input.nodeBinary,
    [
      NodePath.join(input.candidate, "apps/server/dist/bin.mjs"),
      "serve",
      "--mode",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      String(address.port),
      "--base-dir",
      input.validationHome,
      "--no-browser",
    ],
    {
      cwd: input.candidate,
      env: { ...forkCodexEnvironment(input.env), T3CODE_HOME: input.validationHome },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const completion = Promise.withResolvers<void>();
  let exited = false;
  let startupError: unknown;
  child.once("error", (error) => {
    startupError = error;
  });
  child.once("close", () => {
    exited = true;
    completion.resolve();
  });
  child.stdout.setEncoding("utf8").on("data", input.log);
  child.stderr.setEncoding("utf8").on("data", input.log);
  try {
    const deadline = Date.now() + 60_000;
    let lastProbeError: unknown;
    while (Date.now() < deadline) {
      if (startupError || exited)
        throw new Error("The staged server exited before readiness.", { cause: startupError });
      try {
        const descriptor = await fetchDescriptor(
          `http://127.0.0.1:${address.port}/.well-known/t3/environment`,
        );
        if (descriptor.serverVersion !== input.version) {
          throw new Error(
            `Staged server reported ${descriptor.serverVersion}, expected ${input.version}.`,
          );
        }
        if (exited) throw new Error("The staged server exited during its readiness probe.");
        return;
      } catch (error) {
        lastProbeError = error;
      }
      await NodeTimersPromises.setTimeout(250);
    }
    throw new Error("The staged server did not become ready on the copied database.", {
      cause: lastProbeError,
    });
  } finally {
    if (!exited && child.pid) {
      const signal = (value: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, value);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      signal("SIGTERM");
      await Promise.race([
        completion.promise,
        NodeTimersPromises.setTimeout(10_000, undefined, { ref: false }),
      ]);
      if (!exited) signal("SIGKILL");
    }
    await completion.promise;
  }
}

async function waitForFork(
  config: ForkUpdaterConfig,
  directory: string,
  environmentId: string,
  run: RunCommand,
): Promise<void> {
  const expectedVersion = decodeVersion(
    await NodeFSP.readFile(NodePath.join(directory, "apps/server/package.json"), "utf8"),
  ).version;
  let cause: unknown;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const status = await run(
        "systemctl",
        ["--user", "show", FORK_UPDATE_SERVICE, "--property=ActiveState,MainPID"],
        { cwd: directory, timeout: 10_000 },
      );
      const pid = /^MainPID=(\d+)$/m.exec(status.stdout)?.[1];
      if (!status.stdout.includes("ActiveState=active") || !pid || pid === "0")
        throw new Error("Fork service is not running.");
      const argv = (await NodeFSP.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      const expectedEntry = NodePath.join(
        forkUpdaterPaths(config.baseDir).current,
        "apps/server/dist/bin.mjs",
      );
      if (
        argv[0] !== config.nodeBinary ||
        argv[1] !== expectedEntry ||
        (await NodeFSP.realpath(forkUpdaterPaths(config.baseDir).current)) !== directory
      ) {
        throw new Error("Fork service is not running the selected build.");
      }
      const descriptor = await fetchDescriptor();
      if (
        descriptor.environmentId !== environmentId ||
        descriptor.serverVersion !== expectedVersion
      ) {
        throw new Error("Fork readiness reported the wrong environment or version.");
      }
      return;
    } catch (error) {
      cause = error;
    }
    await NodeTimersPromises.setTimeout(1000);
  }
  throw new Error("The fork did not become ready within 60 probes.", { cause });
}

export async function runForkUpdater(config: ForkUpdaterConfig, version: string): Promise<void> {
  if (!isForkNightlyVersion(version)) throw new Error("An exact nightly version is required.");
  const paths = forkUpdaterPaths(config.baseDir);
  const quietRun = commandRunner(() => {});
  const verifyService = async (run: RunCommand) => {
    const properties = await run(
      "systemctl",
      [
        "--user",
        "show",
        "--all",
        FORK_UPDATE_SERVICE,
        "--property=ExecStart,Environment,EnvironmentFiles,ActiveState",
      ],
      { cwd: config.repository, timeout: 10_000 },
    );
    assertForkService(config, `${properties.stdout}\n`);
  };
  // Nothing is created, built, or deployed before the live service boundary is checked.
  await verifyService(quietRun);
  if (!(await NodeFSP.lstat(paths.current)).isSymbolicLink())
    throw new Error("The active fork build must be a symlink.");
  const previous = await NodeFSP.realpath(paths.current);
  const releases = await NodeFSP.realpath(paths.releases);
  if (!previous.startsWith(`${releases}${NodePath.sep}`))
    throw new Error("The active build must be inside fork-updater/releases.");
  const currentVersion = decodeVersion(
    await NodeFSP.readFile(NodePath.join(previous, "apps/server/package.json"), "utf8"),
  ).version;
  const state = async (status: "updating" | "failed" | "updated", message: string) =>
    writeForkUpdateState(paths.state, {
      status,
      currentVersion: status === "updated" ? version : currentVersion,
      targetVersion: version,
      checkedAt: new Date().toISOString(),
      message,
    });
  const log = boundedLog(paths.log);
  const run = commandRunner(log);
  try {
    await state("updating", "Checking the nightly release and fork source.");
    if (compareSemverVersions(version, currentVersion) <= 0)
      throw new Error("The target nightly must be newer than the active build.");
    const active = await fetchDescriptor();
    if (active.serverVersion !== currentVersion)
      throw new Error(
        "The running fork differs from the active build; restart it before updating.",
      );
    const releaseResponse = await fetch(`${FORK_UPSTREAM_RELEASES}/tags/v${version}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "t3-omp-fork-updater" },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!releaseResponse.ok)
      throw new Error(`Nightly release lookup returned HTTP ${releaseResponse.status}.`);
    assertPublishedForkNightly(await releaseResponse.json(), version);
    const commonDir = (
      await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: config.repository,
      })
    ).stdout;
    const activeCommonDir = (
      await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: previous,
      })
    ).stdout;
    if ((await NodeFSP.realpath(commonDir)) !== (await NodeFSP.realpath(activeCommonDir))) {
      throw new Error("The active build and configured source must share the same Git repository.");
    }
    if ((await run("git", ["status", "--porcelain"], { cwd: previous })).stdout) {
      throw new Error("The active release source has uncommitted changes.");
    }
    const source = (await run("git", ["rev-parse", "HEAD"], { cwd: previous })).stdout;
    for (const required of [
      "scripts/fork-updater.ts",
      "packages/shared/src/forkUpdater.ts",
      "apps/server/src/provider/Drivers/OmpDriver.ts",
      "apps/server/src/provider/Layers/OmpAdapter.ts",
    ]) {
      await run("git", ["cat-file", "-e", `${source}:${required}`], { cwd: config.repository });
    }
    const env = forkCodexEnvironment(process.env);
    env.PATH = `${NodePath.dirname(config.nodeBinary)}:${env.PATH ?? "/usr/bin:/bin"}`;
    const login = await run(config.codexBinary, ["login", "status"], {
      cwd: config.repository,
      env,
      timeout: 30_000,
    });
    if (!/logged in using chatgpt/i.test(`${login.stdout}\n${login.stderr}`))
      throw new Error(
        "Codex must be logged in with the existing ChatGPT subscription, not an API key.",
      );
    const candidate = await NodeFSP.mkdtemp(NodePath.join(releases, `${version}-`));
    await run("git", ["worktree", "add", "--detach", candidate, source], {
      cwd: config.repository,
    });
    const git = (args: readonly string[], allowFailure = false) =>
      run("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: candidate,
        env,
        allowFailure,
      });
    await git(["fetch", "--no-tags", FORK_UPSTREAM_REPOSITORY, `refs/tags/v${version}`]);
    const target = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).stdout;
    const merge = await git(["merge", "--no-ff", "--no-commit", target], true);
    if (merge.code !== 0 && !(await git(["ls-files", "--unmerged"])).stdout)
      throw new Error(`Git could not merge the nightly: ${merge.stderr}`);
    await state("updating", "Codex is merging the nightly while preserving OMP support.");
    await run(
      config.codexBinary,
      [
        "exec",
        "--model",
        "gpt-6-astra",
        "-c",
        'model_reasoning_effort="medium"',
        "--sandbox",
        "workspace-write",
        "--color",
        "never",
        "-c",
        'approval_policy="never"',
        "-c",
        'forced_login_method="chatgpt"',
        "-c",
        "sandbox_workspace_write.writable_roots=[]",
        "-c",
        "sandbox_workspace_write.network_access=false",
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "-c",
        "sandbox_workspace_write.exclude_slash_tmp=true",
        "-C",
        candidate,
        `Update this T3 Code fork to published upstream nightly v${version} (commit ${target}). A merge from fork commit ${source} is already staged, possibly conflicted. Resolve conflicts and adapt code as needed. Preserve every fork change, particularly OMP provider contracts, settings, driver/adapter, focused tests, and the complete nightly fork updater/server/client UI. Inspect the fork diff against upstream so nothing is silently lost. Only edit this checkout. Do not commit, fetch, change branches, modify other checkouts, access live T3 data, deploy, switch symlinks, invoke systemctl/systemd-run, run validation/build/test/format/lint commands, or change Codex configuration. Do not weaken tests or validation gates. The parent worker owns validation and activation. Leave the merged source ready for its deterministic checks.`,
      ],
      { cwd: candidate, env, timeout: 60 * 60_000 },
    );
    await git(["add", "--all"]);
    await assertStagedForkDiff(candidate, target);
    await git([
      "commit",
      "--allow-empty",
      "-m",
      `Merge upstream nightly v${version} into OMP fork`,
    ]);
    await assertForkAncestry(candidate, source, target);
    await activateForkBuild({
      current: paths.current,
      candidate,
      validate: async () => {
        await state("updating", "Installing dependencies and validating the OMP fork.");
        const sourceVp = NodePath.join(config.repository, "node_modules/.bin/vp");
        const publicEnv = loadRepoEnv({ repoRoot: config.repository });
        const buildEnv: NodeJS.ProcessEnv = {
          ...env,
          CI: "1",
          npm_config_engine_strict: "false",
          APP_VERSION: version,
          // This build is served by the fork itself. A hosted channel makes the
          // client skip its same-origin primary environment and appear empty.
          VITE_HOSTED_APP_CHANNEL: "",
          T3CODE_HOME: NodePath.join(candidate, ".t3-validation"),
          ...Object.fromEntries(
            Object.entries(publicEnv).filter(([key]) =>
              /^(?:T3CODE_CLERK_(?:PUBLISHABLE_KEY|CLI_OAUTH_CLIENT_ID|JWT_TEMPLATE)|T3CODE_RELAY_URL)$/.test(
                key,
              ),
            ),
          ),
        };
        await run(sourceVp, ["install", "--frozen-lockfile"], { cwd: candidate, env: buildEnv });
        const vp = NodePath.join(candidate, "node_modules/.bin/vp");
        await run(config.nodeBinary, ["scripts/update-release-package-versions.ts", version], {
          cwd: candidate,
          env: buildEnv,
        });
        await git(["add", "--all"]);
        await git(["commit", "--allow-empty", "-m", `Stamp OMP fork nightly ${version}`]);
        const validatedHead = (await git(["rev-parse", "HEAD"])).stdout;
        for (const required of [
          "scripts/fork-updater.ts",
          "packages/shared/src/forkUpdater.ts",
          "apps/server/src/provider/Drivers/OmpDriver.ts",
          "apps/server/src/provider/Layers/OmpAdapter.ts",
          "apps/server/src/provider/Drivers/OmpDriver.test.ts",
          "apps/server/src/provider/Layers/OmpAdapter.test.ts",
          "scripts/fork-updater.test.ts",
        ]) {
          await NodeFSP.access(NodePath.join(candidate, required));
        }
        await run(
          vp,
          [
            "test",
            "run",
            "apps/server/src/provider/Drivers/OmpDriver.test.ts",
            "apps/server/src/provider/Layers/OmpAdapter.test.ts",
            "scripts/fork-updater.test.ts",
            "apps/server/src/cloud/forkUpdater.test.ts",
            "apps/server/src/cloud/selfUpdate.test.ts",
            "packages/client-runtime/src/rpc/session.test.ts",
            "apps/web/src/components/sidebar/SidebarForkUpdateNotice.test.tsx",
          ],
          { cwd: candidate, env: buildEnv },
        );
        await run(
          vp,
          [
            "run",
            "--filter",
            "@t3tools/contracts",
            "--filter",
            "@t3tools/shared",
            "--filter",
            "@t3tools/client-runtime",
            "--filter",
            "@t3tools/scripts",
            "--filter",
            "@t3tools/web",
            "--filter",
            "t3",
            "typecheck",
          ],
          { cwd: candidate, env: buildEnv },
        );
        await state("updating", "Building the nightly web client and server.");
        await run(vp, ["run", "--filter", "t3", "build"], { cwd: candidate, env: buildEnv });
        for (const output of ["apps/web/dist", "apps/server/dist/client"]) {
          await run(config.nodeBinary, ["scripts/apply-web-brand-assets.ts", "nightly", output], {
            cwd: candidate,
            env: buildEnv,
          });
        }
        await NodeFSP.access(NodePath.join(candidate, "apps/server/dist/client/index.html"));
        const entry = NodePath.join(candidate, "apps/server/dist/bin.mjs");
        const validationHome = NodePath.join(candidate, ".t3-validation");
        await NodeFSP.rm(validationHome, { recursive: true, force: true });
        const database = NodePath.join(validationHome, "userdata", "state.sqlite");
        await NodeFSP.mkdir(NodePath.dirname(database), { recursive: true, mode: 0o700 });
        const sourceDb = new NodeSqlite.DatabaseSync(
          NodePath.join(config.baseDir, "userdata/state.sqlite"),
          { readOnly: true },
        );
        try {
          sourceDb.prepare("VACUUM INTO ?").run(database);
        } finally {
          sourceDb.close();
        }
        try {
          const preflight = await run(
            config.nodeBinary,
            [entry, "__service-preflight", "--database-path", database, "--launcher-protocol", "3"],
            { cwd: candidate, env: buildEnv, timeout: 60_000 },
          );
          const result = decodePreflight(preflight.stdout);
          if (result.version !== version)
            throw new Error("The built server preflight reported the wrong version.");
          await state("updating", "Testing startup and database migrations on an isolated copy.");
          await smokeCandidateFork({
            nodeBinary: config.nodeBinary,
            candidate,
            validationHome,
            version,
            env: buildEnv,
            log,
          });
        } finally {
          await NodeFSP.rm(validationHome, { recursive: true, force: true });
        }
        await assertForkAncestry(candidate, source, target);
        if (
          (await git(["rev-parse", "HEAD"])).stdout !== validatedHead ||
          (await git(["status", "--porcelain"])).stdout
        ) {
          throw new Error(
            "Validation changed the committed source; refusing to activate an unvalidated build.",
          );
        }
      },
      beforeSwitch: async () => {
        await verifyService(run);
        await state("updating", "Validation passed. Activating the nightly fork build.");
      },
      restart: async () => {
        await run("systemctl", ["--user", "restart", FORK_UPDATE_SERVICE], {
          cwd: config.repository,
          timeout: 60_000,
        });
      },
      ready: (directory) => waitForFork(config, directory, active.environmentId, run),
    });
    await state("updated", "The fork is running the new nightly. Refresh to use it.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`\nFAILED: ${message}\n`);
    await state("failed", message.slice(0, 2000));
    throw error;
  }
}

if (import.meta.main) {
  try {
    const { values } = NodeUtil.parseArgs({
      options: { config: { type: "string" }, version: { type: "string" } },
      strict: true,
    });
    if (!values.config || !values.version)
      throw new Error(
        "Usage: node scripts/fork-updater.ts --config <file> --version <exact-nightly-version>",
      );
    await runForkUpdater(await readForkUpdaterConfig(values.config), values.version);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
