import { OMP_DEFAULT_MODEL, OmpSettings, ProviderDriverKind } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as AcpSchema from "effect-acp/schema";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeOmpCommandCatalog } from "./OmpCommandCatalog.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER = ProviderDriverKind.make("omp");
const decodeSettings = Schema.decodeSync(OmpSettings);
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

function thinkingLabel(name: string): string {
  if (name !== name.toLowerCase()) return name;
  if (name === "xhigh") return "X-High";
  return name.replace(
    /(^|-)([a-z])/g,
    (_, separator: string, letter: string) => `${separator}${letter.toUpperCase()}`,
  );
}

export type OmpDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ServerConfig
  | ServerSettingsService;

export function ompModelsFromConfigOptions(options: ReadonlyArray<AcpSchema.SessionConfigOption>) {
  const config = options.find((option) => option.id === "model" || option.category === "model");
  if (config?.type !== "select") return [];
  const thinking = options.find((option) => option.id === "thinking");
  const thinkingOptions =
    thinking?.type === "select"
      ? thinking.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options))
      : [];
  const capabilities =
    thinkingOptions.length > 0
      ? createModelCapabilities({
          optionDescriptors: [
            {
              id: "thinking",
              label: "Thinking",
              type: "select",
              options: thinkingOptions.map((entry) => ({
                id: entry.value,
                label: thinkingLabel(entry.name || entry.value),
              })),
              ...(thinking?.type === "select" ? { currentValue: thinking.currentValue } : {}),
            },
          ],
        })
      : EMPTY_CAPABILITIES;
  return config.options
    .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
    .map((entry) => ({
      slug: entry.value,
      name: entry.name || entry.value,
      isCustom: false,
      ...(entry.value === config.currentValue
        ? { isDefault: true, aliases: [OMP_DEFAULT_MODEL] }
        : {}),
      capabilities,
    }));
}

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Oh My Pi", supportsMultipleInstances: true },
  configSchema: OmpSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const settings = { ...config, enabled } satisfies OmpSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const makeRuntime = (
        sessionCwd: string,
        resumeSessionId?: string,
        approvalMode?: string,
        mcpServers?: ReadonlyArray<AcpSchema.McpServer>,
      ) =>
        AcpSessionRuntime.make({
          spawn: {
            command: settings.binaryPath,
            args: ["acp", ...(approvalMode ? [`--approval-mode=${approvalMode}`] : [])],
            cwd: sessionCwd,
            env: processEnv,
          },
          cwd: sessionCwd,
          ...(resumeSessionId ? { resumeSessionId, resumeMethod: "load" as const } : {}),
          authMethodId: "agent",
          clientInfo: { name: "t3-code", version: "0.0.0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          mcpServers: mcpServers ?? [],
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

      const buildSnapshot = (input: {
        installed: boolean;
        version: string | null;
        status: "ready" | "warning" | "error";
        message?: string;
        models?: ReturnType<typeof ompModelsFromConfigOptions>;
      }) =>
        Effect.map(DateTime.now, (now) =>
          stampIdentity({
            ...buildServerProvider({
              presentation: {
                displayName: "Oh My Pi",
                supportsConversationRollback: false,
                showInteractionModeToggle: false,
              },
              enabled,
              checkedAt: DateTime.formatIso(now),
              models: providerModelsFromSettings(
                input.models ?? [],
                settings.customModels,
                EMPTY_CAPABILITIES,
              ),
              slashCommands: [{ name: "compact", description: "Compact the OMP conversation" }],
              probe: {
                installed: input.installed,
                version: input.version,
                status: input.status,
                auth: {
                  status: input.status === "ready" ? "authenticated" : "unknown",
                  type: "local",
                  label: "OMP credentials",
                },
                ...(input.message ? { message: input.message } : {}),
              },
            } satisfies Parameters<typeof buildServerProvider>[0]),
            supportsTextGeneration: input.status === "ready",
          }),
        );

      const checkProvider = Effect.gen(function* () {
        if (!enabled)
          return yield* buildSnapshot({
            installed: false,
            version: null,
            status: "warning",
            message: "Oh My Pi is disabled in T3 Code settings.",
          });
        const result = yield* Effect.gen(function* () {
          const probeCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-probe-" });
          const runtime = yield* makeRuntime(probeCwd);
          const started = yield* runtime.start();
          return {
            version: started.initializeResult.agentInfo?.version ?? null,
            models: ompModelsFromConfigOptions(started.sessionSetupResult.configOptions ?? []),
          };
        }).pipe(Effect.scoped, Effect.timeoutOption("30 seconds"), Effect.result);
        if (result._tag === "Success" && result.success._tag === "Some") {
          const { version, models } = result.success.value;
          return yield* buildSnapshot({
            installed: true,
            version,
            models,
            status: models.length > 0 ? "ready" : "warning",
            ...(models.length === 0
              ? {
                  message:
                    "OMP has no available models. Configure a model in the OMP CLI, then refresh this provider.",
                }
              : {}),
          });
        }
        return yield* buildSnapshot({
          installed: false,
          version: null,
          status: "error",
          message: "OMP ACP could not start. Check its binary path and local model credentials.",
        });
      });

      const managedSnapshot = yield* makeManagedServerProvider({
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null }),
          ),
        getSettings: Effect.succeed(settings),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot: () =>
          buildSnapshot({
            installed: false,
            version: null,
            status: "warning",
            message: enabled
              ? "Checking OMP availability."
              : "Oh My Pi is disabled in T3 Code settings.",
          }),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: `Could not initialize OMP provider: ${cause.message}`,
              cause,
            }),
        ),
      );
      const { snapshot, onAvailableCommands, snapshotForCwd, skillNamesForCwd } =
        yield* makeOmpCommandCatalog(managedSnapshot);
      const adapter = yield* makeOmpAdapter({
        instanceId,
        enabled,
        makeRuntime,
        onAvailableCommands,
        skillNamesForCwd,
      });
      const textGeneration = yield* makeOmpTextGeneration((textCwd) => makeRuntime(textCwd));
      const probeWorkspace = (cwd: string) =>
        Effect.gen(function* () {
          const known = yield* snapshot.getSnapshot;
          if (known.workspaceSnapshots?.some((entry) => entry.cwd === cwd)) {
            return yield* snapshotForCwd(cwd);
          }
          yield* Effect.gen(function* () {
            const runtime = yield* makeRuntime(cwd);
            const commandsReady = yield* Deferred.make<void>();
            yield* Stream.runForEach(runtime.getEvents(), (event) =>
              event._tag === "AvailableCommandsUpdated"
                ? onAvailableCommands(event.availableCommands, cwd).pipe(
                    Effect.andThen(Deferred.succeed(commandsReady, undefined)),
                    Effect.asVoid,
                  )
                : event._tag === "EventStreamBarrier"
                  ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
                  : Effect.void,
            ).pipe(Effect.forkScoped);
            yield* runtime.start();
            yield* Deferred.await(commandsReady);
            yield* runtime.drainEvents;
          }).pipe(Effect.scoped, Effect.timeout("15 seconds"));
          return yield* snapshotForCwd(cwd);
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER,
                instanceId,
                detail: `Could not discover OMP commands for '${cwd}': ${cause.message}`,
                cause,
              }),
          ),
        );
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd: (cwd) => (enabled ? probeWorkspace(cwd) : snapshot.getSnapshot),
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
