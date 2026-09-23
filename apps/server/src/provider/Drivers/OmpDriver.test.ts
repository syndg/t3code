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
import { rewriteOmpSkillMentions } from "./OmpCommandCatalog.ts";
import { OmpDriver, ompModelsFromConfigOptions } from "./OmpDriver.ts";

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

  it.effect("discovers native commands and skills before a workspace turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-catalog-" });
      const other = NodePath.join(directory, "other");
      yield* fs.makeDirectory(other);
      const binaryPath = NodePath.join(directory, "omp");
      const otherUpdates = JSON.stringify([
        {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "security", description: "Security check" },
            { name: "skill:explain", description: "Explain the code" },
          ],
        },
      ]);
      yield* fs.writeFileString(
        binaryPath,
        `#!/bin/sh\nif [ "$(pwd)" = '${other}' ]; then export T3_ACP_DELAYED_STARTUP_UPDATES='${otherUpdates}'; fi\nexec '${process.execPath}' '${mockAgentPath}' "$@"\n`,
      );
      yield* fs.chmod(binaryPath, 0o755);
      const instance = yield* OmpDriver.create({
        instanceId,
        displayName: undefined,
        enabled: true,
        environment: [
          {
            name: "T3_ACP_DELAYED_STARTUP_UPDATES",
            value: JSON.stringify([
              {
                sessionUpdate: "available_commands_update",
                availableCommands: [
                  { name: "plan", description: "Create a plan", input: { hint: "task" } },
                  { name: "skill:review", description: "Review the code" },
                  { name: "compact", description: "Provider compact" },
                ],
              },
            ]),
            sensitive: false,
          },
        ],
        config: { ...OmpDriver.defaultConfig(), binaryPath },
      });
      yield* instance.snapshot.refresh;
      const workspace = yield* instance.snapshotForCwd!(directory);
      expect(workspace.slashCommands).toContainEqual({
        name: "plan",
        description: "Create a plan",
        input: { hint: "task" },
      });
      expect(workspace.slashCommands.filter((command) => command.name === "compact")).toHaveLength(
        1,
      );
      expect(workspace.skills).toContainEqual({
        name: "review",
        description: "Review the code",
        path: "skill://review",
        enabled: true,
      });
      const unrelated = yield* instance.snapshotForCwd!(other);
      expect(
        unrelated.workspaceSnapshots?.find((entry) => entry.cwd === directory)?.skills,
      ).toEqual(workspace.skills);
      expect(unrelated.slashCommands.map((command) => command.name)).toContain("security");
      expect(unrelated.slashCommands.map((command) => command.name)).not.toContain("plan");
      expect(unrelated.skills.map((skill) => skill.name)).toEqual(["explain"]);
    }).pipe(Effect.scoped),
  );
});

it("capitalizes OMP thinking labels without changing protocol values", () => {
  const models = ompModelsFromConfigOptions([
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "default",
      options: [{ value: "default", name: "Default" }],
    },
    {
      id: "thinking",
      name: "Thinking",
      type: "select",
      currentValue: "high",
      options: [
        { value: "high", name: "high" },
        { value: "xhigh", name: "xhigh" },
        { value: "medium-low", name: "medium-low" },
      ],
    },
  ]);
  expect(models[0]?.capabilities.optionDescriptors?.[0]).toMatchObject({
    options: [
      { id: "high", label: "High" },
      { id: "xhigh", label: "X-High" },
      { id: "medium-low", label: "Medium-Low" },
    ],
  });
});

it("translates only advertised OMP skill mentions", () => {
  expect(
    rewriteOmpSkillMentions("Use $review and $unknown. Budget $100 or $HOME", new Set(["review"])),
  ).toBe("Use /skill:review and $unknown. Budget $100 or $HOME");
});
