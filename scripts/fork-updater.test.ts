// @effect-diagnostics nodeBuiltinImport:off - Exercises the worker's real filesystem and Git boundaries.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  forkUpdaterPaths,
  isForkNightlyVersion,
  readForkUpdateState,
  writeForkUpdateState,
} from "@t3tools/shared/forkUpdater";
import {
  activateForkBuild,
  assertForkAncestry,
  assertForkService,
  assertPublishedForkNightly,
  forkCodexEnvironment,
} from "./fork-updater.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

async function deploymentFixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fork-updater-test-"));
  temporary.push(root);
  const previous = NodePath.join(root, "previous");
  const candidate = NodePath.join(root, "candidate");
  const current = NodePath.join(root, "current");
  await NodeFSP.mkdir(previous);
  await NodeFSP.mkdir(candidate);
  await NodeFSP.writeFile(NodePath.join(previous, "build"), "working fork");
  await NodeFSP.symlink(previous, current);
  return { root, previous, candidate, current };
}

describe("fork activation", () => {
  it("leaves the active build and service alone when validation fails", async () => {
    const fixture = await deploymentFixture();
    let restarts = 0;
    await expect(
      activateForkBuild({
        ...fixture,
        validate: async () => {
          throw new Error("OMP regression");
        },
        beforeSwitch: async () => {},
        restart: async () => {
          restarts++;
        },
        ready: async () => {},
      }),
    ).rejects.toThrow("OMP regression");
    expect(await NodeFSP.realpath(fixture.current)).toBe(fixture.previous);
    expect(await NodeFSP.readFile(NodePath.join(fixture.current, "build"), "utf8")).toBe(
      "working fork",
    );
    expect(restarts).toBe(0);
  });

  it("switches only after validation and checks readiness after restarting", async () => {
    const fixture = await deploymentFixture();
    const events: string[] = [];
    await activateForkBuild({
      ...fixture,
      validate: async () => {
        expect(await NodeFSP.realpath(fixture.current)).toBe(fixture.previous);
        events.push("validated");
      },
      beforeSwitch: async () => {
        events.push("service verified");
      },
      restart: async () => {
        expect(await NodeFSP.realpath(fixture.current)).toBe(fixture.candidate);
        events.push("restart");
      },
      ready: async (directory) => {
        expect(directory).toBe(fixture.candidate);
        expect(events.at(-1)).toBe("restart");
        events.push("ready");
      },
    });
    expect(events).toEqual(["validated", "service verified", "restart", "ready"]);
    expect(await NodeFSP.realpath(fixture.current)).toBe(fixture.candidate);
    expect(await NodeFSP.readFile(NodePath.join(fixture.previous, "build"), "utf8")).toBe(
      "working fork",
    );
  });

  it.each(["restart", "readiness"])(
    "restores and verifies the previous build after failed %s",
    async (failure) => {
      const fixture = await deploymentFixture();
      const restarted: string[] = [];
      const verified: string[] = [];
      await expect(
        activateForkBuild({
          ...fixture,
          validate: async () => {},
          beforeSwitch: async () => {},
          restart: async () => {
            const selected = await NodeFSP.realpath(fixture.current);
            restarted.push(selected);
            if (failure === "restart" && selected === fixture.candidate)
              throw new Error("restart failed");
          },
          ready: async (directory) => {
            if (directory === fixture.candidate) throw new Error("wrong version");
            verified.push(directory);
          },
        }),
      ).rejects.toThrow("previous fork build was restored");
      expect(await NodeFSP.realpath(fixture.current)).toBe(fixture.previous);
      expect(restarted).toEqual([fixture.candidate, fixture.previous]);
      expect(verified).toEqual([fixture.previous]);
    },
  );

  it("does not report a successful rollback when the previous build also fails", async () => {
    const fixture = await deploymentFixture();
    await expect(
      activateForkBuild({
        ...fixture,
        validate: async () => {},
        beforeSwitch: async () => {},
        restart: async () => {
          throw new Error("service failed");
        },
        ready: async () => {},
      }),
    ).rejects.toThrow("Activation and rollback failed");
    expect(await NodeFSP.realpath(fixture.current)).toBe(fixture.previous);
  });
});

it("requires both the fork source and exact nightly ancestry in a real git worktree", async () => {
  const fixture = await deploymentFixture();
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Updater test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Updater test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    }).trim();
  git("init", "--initial-branch=main");
  git("commit", "--allow-empty", "-m", "base");
  git("branch", "nightly");
  git("commit", "--allow-empty", "-m", "OMP fork");
  const fork = git("rev-parse", "HEAD");
  git("checkout", "nightly");
  git("commit", "--allow-empty", "-m", "published nightly");
  const nightly = git("rev-parse", "HEAD");
  git("checkout", "main");
  await expect(assertForkAncestry(fixture.root, fork, nightly)).rejects.toThrow("must descend");
  git("merge", "--no-ff", "nightly", "-m", "merge nightly");
  await assertForkAncestry(fixture.root, fork, nightly);
  git("checkout", "nightly");
  await expect(assertForkAncestry(fixture.root, fork, nightly)).rejects.toThrow("must descend");
});

it("accepts only the exact published nightly, never a draft, preview, or mutable channel", () => {
  const version = "0.0.43-nightly.20260923.1234";
  const release = { tag_name: `v${version}`, draft: false, published_at: "2026-09-23T00:00:00Z" };
  assertPublishedForkNightly(release, version);
  expect(isForkNightlyVersion("nightly")).toBe(false);
  expect(isForkNightlyVersion("0.0.43-preview.20260923.1234")).toBe(false);
  expect(isForkNightlyVersion(`${version}/../../current`)).toBe(false);
  expect(isForkNightlyVersion("00.0.43-nightly.20260923.1234")).toBe(false);
  expect(() => assertPublishedForkNightly({ ...release, draft: true }, version)).toThrow(
    "not a published",
  );
  expect(() => assertPublishedForkNightly({ ...release, published_at: null }, version)).toThrow(
    "not a published",
  );
  expect(() =>
    assertPublishedForkNightly({ ...release, tag_name: "v0.0.43-nightly.20260922.1233" }, version),
  ).toThrow("not a published");
});

it("rejects service configurations that could restart the original server or bypass current", () => {
  const config = {
    repository: "/work/fork",
    baseDir: "/home/test/.t3-omp",
    nodeBinary: "/usr/bin/node",
    codexBinary: "/usr/bin/codex",
  };
  const entry = `${forkUpdaterPaths(config.baseDir).current}/apps/server/dist/bin.mjs`;
  const properties = `ExecStart={ path=${config.nodeBinary} ; argv[]=${config.nodeBinary} ${entry} serve --mode web --host 127.0.0.1 --port 3774 --base-dir ${config.baseDir} --no-browser ; ignore_errors=no ; }\nActiveState=active\nEnvironment=PATH=/usr/bin\n`;
  assertForkService(config, properties);
  expect(() => assertForkService(config, properties.replace("--port 3774", "--port 3773"))).toThrow(
    "isolated",
  );
  expect(() =>
    assertForkService(
      config,
      properties.replace(`--base-dir ${config.baseDir}`, "--base-dir /home/test/.t3"),
    ),
  ).toThrow("isolated");
  expect(() =>
    assertForkService(config, properties.replace(entry, "/work/fork/apps/server/dist/bin.mjs")),
  ).toThrow("isolated");
  expect(() =>
    assertForkService(config, `${properties}EnvironmentFiles=/tmp/overrides.env\n`),
  ).toThrow("environment files");
  expect(() =>
    assertForkService(
      config,
      properties.replace(
        "Environment=PATH=",
        "Environment=NODE_OPTIONS=--require=/tmp/override.js PATH=",
      ),
    ),
  ).toThrow("runtime overrides");
});

it("removes API billing and live-service overrides without selecting another Codex model or home", () => {
  expect(
    forkCodexEnvironment({
      HOME: "/home/test",
      CODEX_HOME: "/home/test/.codex",
      PATH: "/usr/bin",
      OPENAI_API_KEY: "secret",
      ANTHROPIC_API_KEY: "secret",
      CODEX_API_KEY: "secret",
      T3CODE_HOME: "/home/test/.t3",
      NODE_OPTIONS: "--require=override.js",
      DBUS_SESSION_BUS_ADDRESS: "session-bus",
    }),
  ).toEqual({ HOME: "/home/test", CODEX_HOME: "/home/test/.codex", PATH: "/usr/bin" });
});

it("publishes state atomically for concurrent readers", async () => {
  const fixture = await deploymentFixture();
  const file = NodePath.join(fixture.root, "state.json");
  const updating = {
    status: "updating",
    currentVersion: "0.0.42",
    targetVersion: "0.0.43-nightly.20260923.1234",
  } as const;
  await writeForkUpdateState(file, updating);
  const observations = await Promise.all(
    Array.from({ length: 20 }, async (_, index) => {
      if (index % 2 === 0)
        await writeForkUpdateState(file, { ...updating, message: `stage ${index}` });
      return readForkUpdateState(file);
    }),
  );
  expect(
    observations.every(
      (state) => state?.status === "updating" && state.targetVersion === updating.targetVersion,
    ),
  ).toBe(true);
  expect((await NodeFSP.readdir(fixture.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
