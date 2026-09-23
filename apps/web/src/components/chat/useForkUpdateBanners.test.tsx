import { act, createElement, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { ForkUpdateState } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => {
  const state: ForkUpdateState = {
    status: "available",
    currentVersion: "0.0.43-nightly.20260922.2123",
    targetVersion: "0.0.43-nightly.20260923.2150",
  };
  return { start: vi.fn(), toast: vi.fn(), state };
});
vi.mock("../../branding", () => ({ APP_VERSION: "0.0.43-nightly.20260922.2123" }));
vi.mock("../../state/server", () => ({ serverEnvironment: { startForkUpdate: Symbol() } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixture.start }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "fork-notice-test",
        label: "OMP fork",
        connection: { phase: "connected" },
        serverConfig: { forkUpdate: fixture.state },
      },
    ],
  }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: fixture.toast } }));
vi.mock("../ui/button", () => ({
  InlineButton: (props: ComponentProps<"button">) => createElement("button", props),
  Button: (props: ComponentProps<"button">) => createElement("button", props),
}));

import { useForkUpdateBanners } from "./useForkUpdateBanners";
function ForkUpdateBanners() {
  return (
    <>
      {useForkUpdateBanners().map((item) => (
        <div key={item.id}>{item.actions}</div>
      ))}
    </>
  );
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.clearAllMocks();
});

describe("fork update consent and completion", () => {
  it("does not start from a notice or treat worker acceptance as update success", async () => {
    let accept!: (value: unknown) => void;
    const accepted = new Promise<unknown>((resolve) => {
      accept = resolve;
    });
    fixture.start.mockReturnValue(accepted);
    await act(async () => {
      renderer = create(<ForkUpdateBanners />);
    });
    expect(fixture.start).not.toHaveBeenCalled();
    const update = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Update"))!;
    await act(async () => {
      update.props.onClick();
      update.props.onClick();
    });
    expect(fixture.start).toHaveBeenCalledTimes(1);
    await act(async () => {
      accept(
        AsyncResult.success({
          targetVersion: fixture.state.targetVersion,
          method: "respawn",
        }),
      );
    });
    expect(fixture.toast.mock.calls.some(([notice]) => notice.type === "success")).toBe(false);

    fixture.state = { ...fixture.state, status: "failed", message: "Validation failed" };
    await act(async () => {
      renderer!.update(<ForkUpdateBanners />);
    });
    expect(fixture.toast.mock.calls.some(([notice]) => notice.type === "success")).toBe(false);
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => button.children.includes("Reload UI")),
    ).toBe(false);

    fixture.state = { ...fixture.state, status: "updating" };
    await act(async () => {
      renderer!.update(<ForkUpdateBanners />);
    });

    fixture.state = {
      ...fixture.state,
      status: "updated",
      currentVersion: fixture.state.targetVersion!,
    };
    await act(async () => {
      renderer!.update(<ForkUpdateBanners />);
    });
    expect(fixture.toast.mock.calls.filter(([notice]) => notice.type === "success")).toHaveLength(
      1,
    );
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => button.children.includes("Reload UI")),
    ).toBe(true);
  });
});
