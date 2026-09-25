import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/schema";

const Config = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    disabledServers: Schema.optional(Schema.Array(Schema.String)),
    enabledServers: Schema.optional(Schema.Array(Schema.String)),
  }),
);
const Server = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  type: Schema.optional(Schema.Literals(["http", "sse", "stdio"])),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeConfig = Schema.decodeUnknownSync(Config);
// ACP cannot carry OMP-only OAuth, cwd, or timeout options. Fail rather than silently discard them.
const decodeServer = Schema.decodeUnknownSync(Server, { onExcessProperty: "error" });
const isDisabled = Schema.is(Schema.Struct({ enabled: Schema.Literal(false) }));

class OmpMcpConfigError extends Schema.TaggedError<OmpMcpConfigError>()("OmpMcpConfigError", {
  message: Schema.String,
}) {}

/** ACP skips OMP's own discovery. Forward its user-owned mcp.json, not arbitrary project configs. */
export const loadOmpMcpServers = Effect.fn("loadOmpMcpServers")(function* (
  environment: NodeJS.ProcessEnv,
  cwd: string,
  clientServers: ReadonlyArray<AcpSchema.McpServer>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
  const root = path.join(home, environment.PI_CONFIG_DIR || ".omp");
  const profile = (environment.OMP_PROFILE ?? environment.PI_PROFILE)?.trim();
  const namedProfile = profile && profile !== "default" ? profile : undefined;
  if (
    namedProfile &&
    (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(namedProfile) ||
      namedProfile.endsWith(".") ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(namedProfile))
  ) {
    return yield* new OmpMcpConfigError({ message: "Invalid OMP profile name." });
  }
  const agentDir = namedProfile
    ? path.join(root, "profiles", namedProfile, "agent")
    : environment.PI_CODING_AGENT_DIR
      ? path.resolve(cwd, environment.PI_CODING_AGENT_DIR)
      : path.join(root, "agent");
  const configPath = path.join(agentDir, "mcp.json");
  const contents = yield* fs.readFileString(configPath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.fail(
              new OmpMcpConfigError({
                message: `Could not read OMP MCP configuration at ${configPath}.`,
              }),
            ),
    }),
  );
  if (contents === undefined) return clientServers;

  // Never attach schema errors: they can contain authorization headers from the input.
  return yield* Effect.try({
    try: () => {
      const config = decodeConfig(contents);
      const servers = [...clientServers];
      const claimed = new Set(clientServers.map((server) => server.name));
      const disabled = new Set(config.disabledServers);
      const enabled = new Set(config.enabledServers);
      const expand = (value: string) =>
        value.replace(
          /\$\{([^}:]+)(?::-([^}]*))?\}/g,
          (match, key: string, fallback?: string) => environment[key] ?? fallback ?? match,
        );
      for (const [name, value] of Object.entries(config.mcpServers ?? {})) {
        // T3 owns its client-supplied servers; local entries cannot replace or disable them.
        if (claimed.has(name) || disabled.has(name)) continue;
        if (isDisabled(value) && !enabled.has(name)) continue;
        const server = decodeServer(value);
        const type = server.type ?? "stdio";
        if (type === "stdio") {
          if (!server.command || server.url !== undefined)
            throw new OmpMcpConfigError({ message: "Invalid stdio server." });
          servers.push({
            name,
            command: expand(server.command),
            args: (server.args ?? []).map(expand),
            env: Object.entries(server.env ?? {}).map(([name, value]) => ({
              name,
              value: expand(value),
            })),
          });
        } else {
          if (!server.url || server.command !== undefined)
            throw new OmpMcpConfigError({ message: "Invalid remote server." });
          servers.push({
            name,
            type,
            url: expand(server.url),
            headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({
              name,
              value: expand(value),
            })),
          });
        }
      }
      return servers;
    },
    catch: () =>
      new OmpMcpConfigError({ message: `Invalid OMP MCP configuration at ${configPath}.` }),
  });
});
