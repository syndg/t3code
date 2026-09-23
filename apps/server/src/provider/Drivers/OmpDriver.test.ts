// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OmpDriver } from "./OmpDriver.ts";

const instanceId = ProviderInstanceId.make("omp-test");
const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-omp-driver-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
);

it.layer(layer)("OmpDriver", (it) => {
  it.effect(
    "discovers ACP models and generates a thread title through the configured executable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-bin-" });
        const binaryPath = NodePath.join(directory, "omp");
        yield* fs.writeFileString(
          binaryPath,
          `#!/bin/sh\nexec '${process.execPath}' '${mockAgentPath}' "$@"\n`,
        );
        yield* fs.chmod(binaryPath, 0o755);
        const instance = yield* OmpDriver.create({
          instanceId,
          displayName: undefined,
          enabled: true,
          environment: [
            {
              name: "T3_ACP_PROMPT_RESPONSE_TEXT",
              value: '{"title":"OMP title"}',
              sensitive: false,
            },
          ],
          config: { ...OmpDriver.defaultConfig(), binaryPath },
        });
        const snapshot = yield* instance.snapshot.refresh;
        expect(snapshot.status).toBe("ready");
        expect(snapshot.models.map((model) => model.slug)).toContain("default");
        expect(snapshot.supportsTextGeneration).toBe(true);
        const title = yield* instance.textGeneration.generateThreadTitle({
          cwd: directory,
          message: "Add OMP as a provider",
          modelSelection: { instanceId, model: "default", options: [] },
        });
        expect(title.title).toBe("OMP title");
      }).pipe(Effect.scoped),
  );
});
