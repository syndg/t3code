import type { EnvironmentId, ForkUpdateState } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CircleArrowUpIcon, CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { APP_VERSION } from "../../branding";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const announcedNightlies = new Set<string>();

export function ForkUpdateButton({
  environmentId,
  connected,
  state,
}: {
  environmentId: EnvironmentId;
  connected: boolean;
  state: ForkUpdateState;
}) {
  const startUpdate = useAtomCommand(serverEnvironment.startForkUpdate, { reportFailure: false });
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const canStart =
    connected &&
    !pending &&
    (state.status === "available" || state.status === "failed") &&
    !!state.targetVersion;
  const start = async () => {
    if (!canStart || submitting.current || !state.targetVersion) return;
    submitting.current = true;
    setPending(true);
    try {
      const result = await startUpdate({
        environmentId,
        input: { targetVersion: state.targetVersion },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start fork update",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  return (
    <Button size="xs" variant="outline" disabled={!canStart} onClick={() => void start()}>
      {pending
        ? "Starting…"
        : state.status === "updating"
          ? "Updating…"
          : state.status === "failed"
            ? "Retry"
            : "Update"}
    </Button>
  );
}

function ForkUpdateNotice({
  environmentId,
  label,
  connected,
  state,
}: {
  environmentId: EnvironmentId;
  label: string;
  connected: boolean;
  state: ForkUpdateState;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const noticeKey = `${state.status}:${state.targetVersion ?? ""}`;
  const lastStatus = useRef(state.status);

  useEffect(() => {
    const key = `${environmentId}:${state.targetVersion}`;
    if (connected && state.status === "available" && !announcedNightlies.has(key)) {
      announcedNightlies.add(key);
      toastManager.add({
        type: "info",
        title: `${label}: nightly available`,
        description: `${state.targetVersion}. Use Update in the sidebar to start Codex.`,
      });
    }
    if (connected && state.status === "updated" && lastStatus.current !== "updated") {
      toastManager.add({
        type: "success",
        title: `${label} updated`,
        description: `Running ${state.currentVersion}. You can refresh now.`,
      });
    }
    if (connected) lastStatus.current = state.status;
  }, [connected, environmentId, label, state.status, state.currentVersion, state.targetVersion]);

  if (
    state.status === "idle" ||
    dismissed === noticeKey ||
    (state.status === "updated" && state.currentVersion === APP_VERSION)
  ) {
    return null;
  }

  const updating = state.status === "updating";
  const failed = state.status === "failed";
  const updated = state.status === "updated";

  const Icon = failed ? TriangleAlertIcon : updated ? CircleCheckIcon : CircleArrowUpIcon;
  return (
    <Alert variant="sidebar" role="status" aria-live="polite">
      <Icon aria-hidden />
      <AlertTitle>
        {label}:{" "}
        {failed
          ? "Update failed"
          : updated
            ? "Updated"
            : updating
              ? "Updating fork"
              : "Nightly available"}
      </AlertTitle>
      <AlertDescription>
        {!connected && updating
          ? "Waiting for the fork server to reconnect."
          : (state.message ??
            (updated
              ? `Running ${state.currentVersion}. Refresh to load the new client.`
              : updating
                ? "Codex is preparing and validating the update in the background."
                : `${state.targetVersion}. Update starts Codex using your subscription; only this fork will restart after validation.`))}
      </AlertDescription>
      <AlertAction>
        {updated ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!connected}
            onClick={() => window.location.reload()}
          >
            Refresh
          </Button>
        ) : state.targetVersion ? (
          <ForkUpdateButton environmentId={environmentId} connected={connected} state={state} />
        ) : null}
        {!updating ? (
          <Button size="xs" variant="ghost" onClick={() => setDismissed(noticeKey)}>
            Dismiss
          </Button>
        ) : null}
      </AlertAction>
    </Alert>
  );
}

export function SidebarForkUpdateNotice() {
  const { environments } = useEnvironments();
  const forks = environments.filter((environment) => environment.serverConfig?.forkUpdate);
  if (forks.length === 0) return null;
  return (
    <div className="space-y-2 px-2 pb-2">
      {forks.map((environment) => {
        const state = environment.serverConfig?.forkUpdate;
        return state ? (
          <ForkUpdateNotice
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
            connected={environment.connection.phase === "connected"}
            state={state}
          />
        ) : null;
      })}
    </div>
  );
}
