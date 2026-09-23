import {
  ServerSelfUpdateError,
  type ForkUpdateState,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import { cliReleaseIndexPageUrl } from "@t3tools/shared/cliRelease";
import {
  FORK_UPDATE_UNIT,
  forkUpdaterPaths,
  isForkNightlyVersion,
  readForkUpdaterConfig,
  readForkUpdateState,
  writeForkUpdateState,
} from "@t3tools/shared/forkUpdater";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

export const configPath = Config.String("T3CODE_FORK_UPDATER_CONFIG").pipe(Config.option);

export class ForkUpdater extends Context.Service<
  ForkUpdater,
  {
    readonly enabled: boolean;
    readonly current: Effect.Effect<ForkUpdateState | undefined>;
    readonly streamChanges: Stream.Stream<ForkUpdateState>;
    readonly start: (
      targetVersion: string,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
  }
>()("t3/cloud/forkUpdater") {}

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    published_at: Schema.NullOr(Schema.String),
  }),
);
const decodeReleaseIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseIndex));
const fail = (reason: string, cause?: unknown) => new ServerSelfUpdateError({ reason, cause });

export const make = Effect.fn("cloud.fork_updater.make")(function* (
  currentVersion = packageJson.version,
) {
  const configuredPath = yield* configPath;
  if (Option.isNone(configuredPath)) {
    return ForkUpdater.of({
      enabled: false,
      current: Effect.succeed(undefined),
      streamChanges: Stream.empty,
      start: () => Effect.fail(fail("Source-built fork updates are not configured.")),
    });
  }
  const fs = yield* FileSystem.FileSystem;

  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const file = path.resolve(configuredPath.value);
  // Invalid opt-in configuration must fail closed, never fall back to stock artifacts.
  const config = yield* Effect.tryPromise(() => readForkUpdaterConfig(file)).pipe(Effect.orDie);
  if (config.baseDir !== (yield* fs.realPath(serverConfig.baseDir).pipe(Effect.orDie))) {
    return yield* Effect.die(
      "Fork updater baseDir must match this server's isolated home directory.",
    );
  }
  const paths = forkUpdaterPaths(config.baseDir);
  // Transient user services do not inherit this server's environment. Carry
  // only public build settings and credential-location paths, never API keys.
  const environmentArgs: string[] = [];
  for (const name of [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "T3CODE_CLERK_PUBLISHABLE_KEY",
    "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
    "T3CODE_CLERK_JWT_TEMPLATE",
    "T3CODE_RELAY_URL",
  ]) {
    const value = yield* Config.String(name).pipe(Config.option);
    if (Option.isSome(value)) environmentArgs.push(`--setenv=${name}=${value.value}`);
  }
  const runner = yield* ProcessRunner.ProcessRunner;
  const http = yield* HttpClient.HttpClient;
  const lock = yield* Semaphore.make(1);
  const persisted = yield* Effect.tryPromise(() => readForkUpdateState(paths.state)).pipe(
    Effect.orDie,
  );
  const initial: ForkUpdateState =
    persisted?.status === "updated" && persisted.targetVersion !== currentVersion
      ? {
          ...persisted,
          status: "failed",
          currentVersion,
          message: "The running fork does not match the last completed update.",
        }
      : (persisted ?? { status: "idle", currentVersion });
  const state = yield* SubscriptionRef.make<ForkUpdateState>(initial);
  const save = Effect.fn("cloud.fork_updater.save")(function* (next: ForkUpdateState) {
    yield* Effect.tryPromise({
      try: () => writeForkUpdateState(paths.state, next),
      catch: (cause) => fail("Could not save fork update status.", cause),
    });
    yield* SubscriptionRef.set(state, next);
  });
  const workerRunning = Effect.fn("cloud.fork_updater.worker_running")(function* () {
    const result = yield* runner
      .run({
        command: "systemctl",
        args: ["--user", "show", `${FORK_UPDATE_UNIT}.service`, "--property=LoadState,ActiveState"],
        timeout: "10 seconds",
      })
      .pipe(Effect.mapError((cause) => fail("Could not inspect the fork update worker.", cause)));
    if (result.stdout.includes("LoadState=not-found")) return false;
    if (result.code !== 0) {
      return yield* fail("Could not inspect the fork update worker.", result.stderr);
    }
    const active = /^ActiveState=(.+)$/m.exec(result.stdout)?.[1];
    if (active === undefined)
      return yield* fail("The fork update worker returned no service state.");
    return active !== "inactive" && active !== "failed";
  });
  const readState = Effect.tryPromise({
    try: () => readForkUpdateState(paths.state),
    catch: (cause) => fail("Could not read fork update status.", cause),
  });
  const reconcile = Effect.fn("cloud.fork_updater.reconcile")(function* () {
    const previous = yield* SubscriptionRef.get(state);
    if (previous.status !== "updating") return;
    let next = (yield* readState) ?? previous;
    if (next.status === "updating" && !(yield* workerRunning())) {
      // The worker can write its final receipt while systemctl answers. Read once
      // more before recording an interrupted run; process exit alone is not success.
      next = (yield* readState) ?? next;
      if (next.status === "updating") {
        return yield* save({
          ...next,
          status: "failed",
          message:
            "The update worker stopped without confirming deployment. See fork-updater/job.log.",
        });
      }
    }
    if (next.status === "updated" && next.targetVersion !== currentVersion) {
      return yield* save({
        ...next,
        status: "failed",
        currentVersion,
        message: "The running fork does not match the completed update.",
      });
    }
    if (
      previous.status !== next.status ||
      previous.currentVersion !== next.currentVersion ||
      previous.targetVersion !== next.targetVersion ||
      previous.checkedAt !== next.checkedAt ||
      previous.message !== next.message
    )
      yield* SubscriptionRef.set(state, next);
  });
  const check = Effect.fn("cloud.fork_updater.check")(function* () {
    const previous = yield* SubscriptionRef.get(state);
    if (previous.status === "updating") return;
    let newest: string | undefined;
    for (let page = 1; page <= 10; page++) {
      const releases = yield* http
        .execute(
          HttpClientRequest.get(cliReleaseIndexPageUrl(page)).pipe(
            HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
          Effect.flatMap(decodeReleaseIndex),
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) => fail("Could not check published upstream nightlies.", cause)),
        );
      for (const release of releases) {
        if (release.draft || release.published_at === null || !release.tag_name.startsWith("v"))
          continue;
        const version = release.tag_name.slice(1);
        if (!isForkNightlyVersion(version)) continue;
        if (newest === undefined || compareSemverVersions(version, newest) > 0) newest = version;
      }
      if (newest !== undefined || releases.length < 100) break;
    }
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (newest !== undefined && compareSemverVersions(newest, currentVersion) > 0) {
      if (previous.targetVersion === newest && previous.status === "failed") {
        return yield* save({ ...previous, currentVersion, checkedAt });
      }
      return yield* save({ status: "available", currentVersion, targetVersion: newest, checkedAt });
    }
    if (previous.status === "failed" || previous.status === "updated") {
      return yield* save({ ...previous, currentVersion, checkedAt });
    }
    yield* save({ status: "idle", currentVersion, checkedAt });
  });
  const logFailure = (error: ServerSelfUpdateError) =>
    Effect.logWarning(error.reason, { cause: error.cause });

  // Owned by the server scope, not by any WebSocket or client subscription.
  yield* lock.withPermit(reconcile()).pipe(Effect.catch(logFailure));
  yield* lock
    .withPermit(check())
    .pipe(Effect.catch(logFailure), Effect.repeat(Schedule.spaced("12 hours")), Effect.forkScoped);
  yield* Effect.gen(function* () {
    while (true) {
      yield* SubscriptionRef.changes(state).pipe(
        Stream.filter((value) => value.status === "updating"),
        Stream.runHead,
      );
      yield* Effect.sleep("5 seconds");
      yield* lock.withPermit(reconcile()).pipe(Effect.catch(logFailure));
    }
  }).pipe(Effect.forkScoped);

  const start = Effect.fn("cloud.fork_updater.start")(
    function* (targetVersion: string) {
      const previous = yield* SubscriptionRef.get(state);
      if (previous.status === "updating" || (yield* workerRunning())) {
        return yield* fail("A fork update is already in progress.");
      }
      if (
        (previous.status !== "available" && previous.status !== "failed") ||
        targetVersion !== previous.targetVersion ||
        !isForkNightlyVersion(targetVersion) ||
        compareSemverVersions(targetVersion, currentVersion) <= 0
      ) {
        return yield* fail("Only the currently advertised newer nightly can be installed.");
      }
      const release = yield* fs
        .realPath(paths.current)
        .pipe(
          Effect.mapError((cause) =>
            fail("The fork deployment must be bootstrapped before updating.", cause),
          ),
        );
      yield* save({
        ...previous,
        status: "updating",
        message: "Starting the source-built fork update.",
      });
      yield* runner
        .run({
          command: "systemd-run",
          args: [
            "--user",
            "--collect",
            `--unit=${FORK_UPDATE_UNIT}`,
            "--property=Type=exec",
            ...environmentArgs,
            config.nodeBinary,
            path.join(release, "scripts/fork-updater.ts"),
            "--config",
            file,
            "--version",
            targetVersion,
          ],
          timeout: "15 seconds",
        })
        .pipe(
          Effect.mapError((cause) => fail("Could not start the fork update worker.", cause)),
          Effect.flatMap((result) =>
            result.code === 0
              ? Effect.void
              : Effect.fail(fail("Could not start the fork update worker.", result.stderr)),
          ),
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (!(yield* workerRunning())) {
                yield* save({ ...previous, status: "failed", message: error.reason });
              }
              return yield* error;
            }),
          ),
        );
      return { targetVersion, method: "respawn" as const };
    },
    lock.withPermit,
    Effect.uninterruptible,
  );

  return ForkUpdater.of({
    enabled: true,
    current: SubscriptionRef.get(state),
    streamChanges: SubscriptionRef.changes(state),
    start,
  });
});

export const layer = Layer.effect(ForkUpdater, make()).pipe(Layer.provide(ProcessRunner.layer));
