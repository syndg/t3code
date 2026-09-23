import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ForkUpdateState } from "@t3tools/contracts";
import {
  ForkUpdaterConfig,
  forkUpdaterPaths,
  writeForkUpdateState,
} from "@t3tools/shared/forkUpdater";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ForkUpdater from "./forkUpdater.ts";

const targetVersion = "9999.0.0-nightly.20990923.10";
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(ForkUpdaterConfig));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const available: ForkUpdateState = {
  status: "available",
  currentVersion: packageJson.version,
  targetVersion,
};

const makeHarness = Effect.fn("test.make_fork_updater_harness")(function* (
  options: {
    readonly initial?: ForkUpdateState;
    readonly running?: boolean;
    readonly runtimeVersion?: string;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-updater-test-" });
  const file = path.join(root, "updater.json");
  const paths = forkUpdaterPaths(root);
  yield* fs.writeFileString(
    file,
    encodeConfig({
      baseDir: root,
      repository: root,
      nodeBinary: "/usr/bin/node",
      codexBinary: "/usr/bin/codex",
    }),
  );
  const initial = options.initial;
  if (initial !== undefined) {
    yield* Effect.promise(() => writeForkUpdateState(paths.state, initial));
  }
  let running = options.running ?? false;
  const release = path.join(paths.releases, "active");
  yield* fs.makeDirectory(release, { recursive: true });
  yield* fs.symlink(release, paths.current);
  let checks = 0;
  const starts: ReadonlyArray<string>[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        if (input.command === "systemd-run") {
          starts.push(input.args);
          running = true;
        } else {
          expect(input.command).toBe("systemctl");
        }
        return {
          stdout:
            input.command === "systemctl"
              ? `LoadState=loaded\nActiveState=${running ? "active" : "inactive"}\n`
              : "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      checks++;
      const published = { draft: false, published_at: "2099-09-23T00:00:00Z" };
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          encodeJson([
            { ...published, tag_name: "v9999.0.0-preview.20990924.1" },
            { ...published, tag_name: "v9999.0.0-nightly.20990924.1", draft: true },
            { ...published, tag_name: "v9999.0.0-nightly.20990925.1", published_at: null },
            { ...published, tag_name: "v9999.0.0-nightly.20990923.9" },
            { ...published, tag_name: `v${targetVersion}` },
          ]),
        ),
      );
    }),
  );
  const updater = yield* ForkUpdater.make(options.runtimeVersion).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provide([
      ServerConfig.layerTest(root, root),
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { T3CODE_FORK_UPDATER_CONFIG: file },
        }),
      ),
    ]),
  );
  return {
    updater,
    starts,
    get checks() {
      return checks;
    },
    writeReceipt: (receipt: ForkUpdateState) =>
      Effect.promise(async () => {
        await writeForkUpdateState(paths.state, receipt);
        running = false;
      }),
  };
});

const awaitState = (
  updater: ForkUpdater.ForkUpdater["Service"],
  predicate: (state: ForkUpdateState) => boolean,
) =>
  updater.streamChanges.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.layer(NodeServices.layer)("fork updater", (it) => {
  it.effect("only publishes a notice at startup and on the twelve-hour schedule", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const first = yield* awaitState(harness.updater, (state) => state.status === "available");
      expect(first.targetVersion).toBe(targetVersion);
      expect(harness.checks).toBe(1);
      expect(harness.starts).toEqual([]);
      yield* TestClock.adjust("11 hours");
      expect(harness.checks).toBe(1);
      yield* TestClock.adjust("1 hour");
      yield* awaitState(harness.updater, (state) => state.checkedAt !== first.checkedAt);
      expect(harness.checks).toBe(2);
      expect(harness.starts).toEqual([]);
    }),
  );

  it.effect("rejects unadvertised targets and accepts only one concurrent update", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* awaitState(harness.updater, (state) => state.status === "available");
      const rejected = yield* harness.updater
        .start("9999.0.0-nightly.20990924.1")
        .pipe(Effect.flip);
      expect(rejected.reason).toContain("currently advertised");
      expect(harness.starts).toEqual([]);
      const results = yield* Effect.all(
        [
          harness.updater.start(targetVersion).pipe(Effect.exit),
          harness.updater.start(targetVersion).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.filter(Exit.isSuccess)).toHaveLength(1);
      expect(results.filter(Exit.isFailure)).toHaveLength(1);
      expect(harness.starts).toHaveLength(1);
      expect(yield* harness.updater.current).toMatchObject({ status: "updating", targetVersion });
    }),
  );

  it.effect("keeps the worker's failure visible across later release checks", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* awaitState(harness.updater, (state) => state.status === "available");
      yield* harness.updater.start(targetVersion);
      yield* harness.writeReceipt({
        ...available,
        status: "failed",
        message: "Build validation failed.",
      });
      yield* TestClock.adjust("5 seconds");
      const failure = yield* awaitState(harness.updater, (state) => state.status === "failed");
      expect(failure.message).toBe("Build validation failed.");
      yield* TestClock.adjust("12 hours");
      const checked = yield* awaitState(
        harness.updater,
        (state) => state.checkedAt !== failure.checkedAt,
      );
      expect(checked).toMatchObject({ status: "failed", message: "Build validation failed." });
      expect(harness.starts).toHaveLength(1);
    }),
  );

  it.effect("does not infer success when a restarted server finds an exited worker", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initial: { ...available, status: "updating" } });
      expect(yield* harness.updater.current).toMatchObject({ status: "failed", targetVersion });
      expect(harness.starts).toEqual([]);
    }),
  );

  it.effect("rejects a completed receipt that does not match the running server", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initial: { ...available, status: "updating" },
        running: true,
      });
      yield* harness.writeReceipt({
        ...available,
        status: "updated",
        currentVersion: targetVersion,
      });
      yield* TestClock.adjust("5 seconds");
      const failure = yield* awaitState(harness.updater, (state) => state.status === "failed");
      expect(failure.currentVersion).toBe(packageJson.version);
      expect(harness.starts).toEqual([]);
    }),
  );

  it.effect("replays the worker's verified completion to a returning subscriber", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initial: { ...available, status: "updating" },
        running: true,
        runtimeVersion: targetVersion,
      });
      const completed: ForkUpdateState = {
        status: "updated",
        currentVersion: targetVersion,
        targetVersion,
        message: "Updated and ready to refresh.",
      };
      yield* harness.writeReceipt(completed);
      yield* TestClock.adjust("5 seconds");
      yield* awaitState(harness.updater, (state) => state.status === "updated");
      const replay = yield* harness.updater.streamChanges.pipe(Stream.runHead);
      expect(Option.getOrThrow(replay)).toEqual(completed);
      expect(harness.starts).toEqual([]);
    }),
  );
});
