import type { ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as AcpSchema from "effect-acp/schema";

import type { ServerProviderShape } from "../Services/ServerProvider.ts";

/** Keeps ACP session catalogs scoped to the workspace that announced them. */
export const makeAcpCommandCatalog = Effect.fn("makeAcpCommandCatalog")(function* (
  provider: ServerProviderShape,
  mapCommands: (
    commands: ReadonlyArray<AcpSchema.AvailableCommand>,
    skills: ServerProvider["skills"],
  ) => Pick<NonNullable<ServerProvider["workspaceSnapshots"]>[number], "slashCommands" | "skills">,
) {
  const workspaces = yield* SubscriptionRef.make<NonNullable<ServerProvider["workspaceSnapshots"]>>(
    [],
  );
  const getSnapshot = Effect.all([provider.getSnapshot, SubscriptionRef.get(workspaces)]).pipe(
    Effect.map(([snapshot, workspaceSnapshots]) =>
      workspaceSnapshots.length > 0 ? { ...snapshot, workspaceSnapshots } : snapshot,
    ),
  );
  const snapshotForCwd = Effect.fn("AcpCommandCatalog.snapshotForCwd")(function* (
    cwd: string,
    skills?: ServerProvider["skills"],
  ) {
    const machineSnapshot = yield* provider.getSnapshot;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(workspaces, (entries) => {
      const existing = entries.find((entry) => entry.cwd === cwd);
      return [
        ...entries.filter((entry) => entry.cwd !== cwd),
        {
          cwd,
          checkedAt,
          slashCommands: existing?.slashCommands ?? machineSnapshot.slashCommands,
          skills: skills ?? existing?.skills ?? machineSnapshot.skills,
        },
      ].slice(-16);
    });
    const snapshot = yield* getSnapshot;
    const workspace = snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd);
    return {
      ...snapshot,
      checkedAt,
      slashCommands: workspace?.slashCommands ?? snapshot.slashCommands,
      skills: workspace?.skills ?? snapshot.skills,
    };
  });
  const onAvailableCommands = Effect.fn("AcpCommandCatalog.onAvailableCommands")(function* (
    commands: ReadonlyArray<AcpSchema.AvailableCommand>,
    cwd: string,
    skills?: ServerProvider["skills"],
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(workspaces, (entries) => {
      const catalog = mapCommands(
        commands,
        skills ?? entries.find((entry) => entry.cwd === cwd)?.skills ?? [],
      );
      return [
        ...entries.filter((entry) => entry.cwd !== cwd),
        { cwd, checkedAt, ...catalog },
      ].slice(-16);
    });
  });
  return {
    onAvailableCommands,
    snapshotForCwd,
    skillNamesForCwd: (cwd: string) =>
      Effect.map(
        SubscriptionRef.get(workspaces),
        (entries) =>
          new Set(
            entries.find((entry) => entry.cwd === cwd)?.skills.map((skill) => skill.name) ?? [],
          ),
      ),
    snapshot: {
      ...provider,
      getSnapshot,
      refresh: provider.refresh.pipe(Effect.andThen(getSnapshot)),
      streamChanges: Stream.merge(
        provider.streamChanges.pipe(Stream.map(() => undefined)),
        SubscriptionRef.changes(workspaces).pipe(Stream.map(() => undefined)),
      ).pipe(Stream.mapEffect(() => getSnapshot)),
    } satisfies ServerProviderShape,
  };
});
