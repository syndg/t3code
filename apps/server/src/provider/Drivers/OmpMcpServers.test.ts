import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { loadOmpMcpServers } from "./OmpMcpServers.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("OMP user MCP configuration", (it) => {
  it.effect("keeps host servers authoritative and applies user enable/disable overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const host = { name: "t3-code", type: "http" as const, url: "http://host/mcp", headers: [] };
      yield* fs.writeFileString(
        path.join(directory, "mcp.json"),
        encodeJson({
          mcpServers: {
            "t3-code": { type: "http", url: "http://replacement/mcp" },
            gateway: {
              type: "http",
              url: "http://localhost:${PORT:-4789}/mcp",
              headers: { Authorization: "Bearer ${TOKEN}" },
              enabled: false,
            },
            denied: { type: "http", url: "http://denied/mcp" },
            disabled: {
              type: "http",
              url: "http://disabled/mcp",
              enabled: false,
              oauth: { clientId: "unused" },
            },
          },
          enabledServers: ["gateway", "denied"],
          disabledServers: ["denied", "t3-code"],
        }),
      );
      const servers = yield* loadOmpMcpServers(
        { PI_CODING_AGENT_DIR: directory, TOKEN: "test-token" },
        directory,
        [host],
      );
      expect(servers).toEqual([
        host,
        {
          name: "gateway",
          type: "http",
          url: "http://localhost:4789/mcp",
          headers: [{ name: "Authorization", value: "Bearer test-token" }],
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("isolates named profiles and rereads configuration on the next session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const defaultDir = path.join(home, ".omp", "agent");
      const profileDir = path.join(home, ".omp", "profiles", "work", "agent");
      yield* fs.makeDirectory(defaultDir, { recursive: true });
      yield* fs.makeDirectory(profileDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(defaultDir, "mcp.json"),
        encodeJson({ mcpServers: { personal: { command: "personal-server" } } }),
      );
      const environment = { HOME: home, OMP_PROFILE: "work", PI_CODING_AGENT_DIR: defaultDir };
      expect(yield* loadOmpMcpServers(environment, home, [])).toEqual([]);
      yield* fs.writeFileString(
        path.join(profileDir, "mcp.json"),
        encodeJson({
          mcpServers: { work: { command: "work-server", env: { KEY: "WORK_KEY" } } },
        }),
      );
      expect(yield* loadOmpMcpServers(environment, home, [])).toEqual([
        {
          name: "work",
          command: "work-server",
          args: [],
          env: [{ name: "KEY", value: "WORK_KEY" }],
        },
      ]);
      expect(
        yield* loadOmpMcpServers({ HOME: home, OMP_PROFILE: "", PI_PROFILE: "work" }, home, []),
      ).toEqual([{ name: "personal", command: "personal-server", args: [], env: [] }]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects malformed or unrepresentable configuration without exposing secrets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      for (const contents of [
        '{"mcpServers": "secret-token"',
        encodeJson({
          mcpServers: {
            gateway: {
              type: "http",
              url: "http://localhost/mcp",
              auth: { clientSecret: "secret-token" },
            },
          },
        }),
      ]) {
        yield* fs.writeFileString(path.join(directory, "mcp.json"), contents);
        const error = yield* loadOmpMcpServers(
          { PI_CODING_AGENT_DIR: directory },
          directory,
          [],
        ).pipe(Effect.flip);
        expect(error.message).toContain("Invalid OMP MCP configuration");
        expect(encodeJson(error)).not.toContain("secret-token");
        expect(String(error)).not.toContain("secret-token");
      }
    }).pipe(Effect.scoped),
  );
});
