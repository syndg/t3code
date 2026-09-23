// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";

const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);
const instanceId = ProviderInstanceId.make("omp-test");
const threadId = ThreadId.make("omp-thread");

it.effect("starts an ACP session, streams a turn, and resumes the saved session", () =>
  Effect.gen(function* () {
    const adapter = yield* makeOmpAdapter({
      instanceId,
      enabled: true,
      makeRuntime: (cwd, resumeSessionId) =>
        AcpSessionRuntime.make({
          spawn: { command: process.execPath, args: [mockAgentPath], cwd },
          cwd,
          ...(resumeSessionId ? { resumeSessionId, resumeMethod: "load" as const } : {}),
          clientInfo: { name: "t3-omp-test", version: "0.0.0" },
          authMethodId: "agent",
        }).pipe(Effect.provide(NodeServices.layer)),
    });
    const seen: ProviderRuntimeEvent[] = [];
    const completed = yield* Deferred.make<void>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          seen.push(event);
          if (event.type === "turn.completed") yield* Deferred.succeed(completed, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    const session = yield* adapter.startSession({
      threadId,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    expect(session.resumeCursor).toMatchObject({ schemaVersion: 1, sessionId: "mock-session-1" });
    const first = yield* adapter.sendTurn({ threadId, input: "Hello from OMP" });
    yield* Deferred.await(completed);
    expect(first.turnId).toBeDefined();
    expect(seen.some((event) => event.type === "content.delta")).toBe(true);
    expect(seen.some((event) => event.type === "turn.completed")).toBe(true);
    yield* adapter.stopSession(threadId);
    const resumed = yield* adapter.startSession({
      threadId,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
      resumeCursor: session.resumeCursor,
    });
    expect(resumed.resumeCursor).toMatchObject({ schemaVersion: 1, sessionId: "mock-session-1" });
    yield* adapter.stopSession(threadId);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-omp-adapter-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("emits a failed completion when the ACP prompt fails", () =>
  Effect.gen(function* () {
    const adapter = yield* makeOmpAdapter({
      instanceId,
      enabled: true,
      makeRuntime: (cwd) =>
        AcpSessionRuntime.make({
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd,
            env: { ...process.env, T3_ACP_FAIL_PROMPT: "1" },
          },
          cwd,
          clientInfo: { name: "t3-omp-test", version: "0.0.0" },
          authMethodId: "agent",
        }).pipe(Effect.provide(NodeServices.layer)),
    });
    const completed = yield* Deferred.make<ProviderRuntimeEvent>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        event.type === "turn.completed"
          ? Deferred.succeed(completed, event).pipe(Effect.asVoid)
          : Effect.void,
      ),
      Effect.forkScoped,
    );
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    const result = yield* adapter.sendTurn({ threadId, input: "Fail this turn" }).pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    const event = yield* Deferred.await(completed);
    expect(event).toMatchObject({ type: "turn.completed", payload: { state: "failed" } });
    expect((yield* adapter.listSessions())[0]?.status).toBe("error");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-omp-adapter-failure-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("forwards ACP permission choices and completes the turn after approval", () =>
  Effect.gen(function* () {
    const adapter = yield* makeOmpAdapter({
      instanceId,
      enabled: true,
      makeRuntime: (cwd) =>
        AcpSessionRuntime.make({
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd,
            env: { ...process.env, T3_ACP_EMIT_TOOL_CALLS: "1" },
          },
          cwd,
          clientInfo: { name: "t3-omp-test", version: "0.0.0" },
          authMethodId: "agent",
        }).pipe(Effect.provide(NodeServices.layer)),
    });
    const seen: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          seen.push(event);
          if (event.type === "request.opened" && event.requestId) {
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(event.requestId),
              "acceptForSession",
            );
          }
        }),
      ),
      Effect.forkScoped,
    );
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "Read package metadata" });
    expect(seen.some((event) => event.type === "request.opened")).toBe(true);
    expect(seen.some((event) => event.type === "request.resolved")).toBe(true);
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: "turn.completed",
        payload: expect.objectContaining({ state: "completed" }),
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-omp-adapter-approval-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
