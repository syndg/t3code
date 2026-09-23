// @effect-diagnostics nodeBuiltinImport:off - Shared bootstrap I/O is used by the standalone Node worker before the server Effect runtime exists.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { ForkUpdateState } from "@t3tools/contracts";

// systemd's ExecStart display must be unambiguous when verifying the deployment boundary.
const AbsolutePath = Schema.String.check(Schema.isPattern(/^\/[^\s\0]+$/));
export const ForkUpdaterConfig = Schema.Struct({
  repository: AbsolutePath,
  baseDir: AbsolutePath,
  nodeBinary: AbsolutePath,
  codexBinary: AbsolutePath,
});
export type ForkUpdaterConfig = typeof ForkUpdaterConfig.Type;

export const FORK_UPDATE_SERVICE = "t3code-omp.service";
export const FORK_UPDATE_UNIT = "t3code-omp-update";
export const FORK_UPDATE_PORT = 3774;
export const FORK_UPSTREAM_REPOSITORY = "https://github.com/pingdotgg/t3code.git";
export const FORK_UPSTREAM_RELEASES = "https://api.github.com/repos/pingdotgg/t3code/releases";

const nightlyVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.[1-9]\d{7}\.(0|[1-9]\d*)$/;
export const isForkNightlyVersion = (version: string): boolean => nightlyVersion.test(version);

export function forkUpdaterPaths(baseDir: string) {
  const root = NodePath.join(baseDir, "fork-updater");
  return {
    root,
    state: NodePath.join(root, "state.json"),
    current: NodePath.join(root, "current"),
    releases: NodePath.join(root, "releases"),
    log: NodePath.join(root, "job.log"),
  };
}

const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(ForkUpdaterConfig));
const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(ForkUpdateState));
const encodeState = Schema.encodeSync(Schema.fromJsonString(ForkUpdateState));

export async function readForkUpdaterConfig(file: string): Promise<ForkUpdaterConfig> {
  const config = decodeConfig(await NodeFSP.readFile(file, "utf8"));
  const baseDir = await NodeFSP.realpath(config.baseDir);
  const original = await NodeFSP.realpath(NodePath.join(NodeOS.homedir(), ".t3")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return NodePath.join(NodeOS.homedir(), ".t3");
    },
  );
  if (baseDir === original || baseDir.startsWith(`${original}${NodePath.sep}`)) {
    throw new Error("The fork updater must not use the original T3 data directory.");
  }
  const userdata = await NodeFSP.realpath(NodePath.join(baseDir, "userdata"));
  if (userdata === original || userdata.startsWith(`${original}${NodePath.sep}`)) {
    throw new Error("The fork userdata must not resolve into the original T3 data directory.");
  }
  return { ...config, baseDir, repository: await NodeFSP.realpath(config.repository) };
}

export async function readForkUpdateState(file: string): Promise<ForkUpdateState | undefined> {
  try {
    return decodeState(await NodeFSP.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeForkUpdateState(file: string, state: ForkUpdateState): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    const handle = await NodeFSP.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${encodeState(state)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(temporary, file);
    const directory = await NodeFSP.open(NodePath.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}
