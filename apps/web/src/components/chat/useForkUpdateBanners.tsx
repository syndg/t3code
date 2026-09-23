import type { EnvironmentId, ForkUpdateState } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CircleArrowUpIcon, CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { APP_VERSION } from "../../branding";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const announcedNightlies = new Set<string>();

function reportStartFailure(error: unknown) {
  toastManager.add({
    type: "error",
    title: "Could not start fork update",
    description: error instanceof Error ? error.message : String(error),
  });
}

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
  const start = () => {
    if (!canStart || submitting.current || !state.targetVersion) return;
    submitting.current = true;
    setPending(true);
    void startUpdate({
      environmentId,
      input: { targetVersion: state.targetVersion },
    })
      .then((result) => {
        if (result._tag === "Failure") reportStartFailure(squashAtomCommandFailure(result));
      })
      .catch(reportStartFailure)
      .finally(() => {
        submitting.current = false;
        setPending(false);
      });
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

export function useForkUpdateBanners(): ComposerBannerStackItem[] {
  const { environments } = useEnvironments();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const lastStatuses = useRef(new Map<string, ForkUpdateState["status"]>());

  useEffect(() => {
    for (const environment of environments) {
      const state = environment.serverConfig?.forkUpdate;
      if (!state || environment.connection.phase !== "connected") continue;
      const key = `${environment.environmentId}:${state.targetVersion}`;
      if (state.status === "available" && !announcedNightlies.has(key)) {
        announcedNightlies.add(key);
        toastManager.add({
          type: "info",
          title: `${environment.label}: nightly available`,
          description: "Use Update above the composer to start the update.",
        });
      }
      if (
        state.status === "updated" &&
        lastStatuses.current.get(environment.environmentId) === "updating"
      ) {
        toastManager.add({
          type: "success",
          title: `${environment.label} updated`,
          description:
            "The server is connected. You can keep working or reload to load the new UI.",
        });
      }
      lastStatuses.current.set(environment.environmentId, state.status);
    }
  }, [environments]);

  return environments.flatMap((environment): ComposerBannerStackItem[] => {
    const state = environment.serverConfig?.forkUpdate;
    if (!state || state.status === "idle") return [];
    const key = `${environment.environmentId}:${state.status}:${state.targetVersion ?? ""}`;
    if (dismissed.has(key) || (state.status === "updated" && state.currentVersion === APP_VERSION))
      return [];
    const connected = environment.connection.phase === "connected";
    const updating = state.status === "updating";
    const failed = state.status === "failed";
    const updated = state.status === "updated";
    const Icon = failed ? TriangleAlertIcon : updated ? CircleCheckIcon : CircleArrowUpIcon;
    const title = `${environment.label}: ${failed ? "Update failed" : updated ? "Server updated" : updating ? "Updating" : "Nightly available"}`;
    const description =
      !connected && (updating || updated)
        ? "Reconnecting to the server…"
        : updated
          ? "Keep working, or reload to load the new UI."
          : failed
            ? "Open details to see what stopped the update."
            : updating
              ? (state.message ?? "Preparing and validating the update.")
              : state.targetVersion;
    return [
      {
        id: key,
        variant: failed ? "error" : "default",
        priority: updating ? "urgent" : "notice",
        icon: <Icon aria-hidden />,
        title: (
          <Popover>
            <PopoverTrigger
              render={<InlineButton />}
              className="block max-w-full truncate"
              aria-label={`${title}. View details`}
            >
              {title}
            </PopoverTrigger>
            <PopoverPopup side="top" align="start" width="md">
              <div className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">
                {updated
                  ? description
                  : (state.message ??
                    `Update to ${state.targetVersion}. The update runs in the background and reconnects when ready.`)}
              </div>
            </PopoverPopup>
          </Popover>
        ),
        description,
        actions: updated ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={!connected}
            onClick={() => window.location.reload()}
          >
            Reload UI
          </Button>
        ) : !updating && state.targetVersion ? (
          <ForkUpdateButton
            environmentId={environment.environmentId}
            connected={connected}
            state={state}
          />
        ) : undefined,
        ...(!updating
          ? {
              dismissLabel: "Dismiss update notice",
              onDismiss: () => setDismissed((current) => new Set([...current, key])),
            }
          : {}),
      },
    ];
  });
}
