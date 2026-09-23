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

// OMP 18.2.11 completes the spawn call BEFORE its asynchronous child completes.
it.effect("projects OMP child lifecycle independently of the spawn tool status", () =>
  Effect.gen(function* () {
    const child = {
      index: 0,
      id: "probe",
      agent: "task",
      task: "Reply OMP_CHILD_OK",
      toolCount: 0,
      tokens: 0,
      durationMs: 0,
      recentOutput: [],
    };
    const update = (status: string, childStatus: string, extra = {}) => ({
      sessionUpdate: "tool_call_update",
      toolCallId: "spawn-probe",
      status,
      rawOutput: {
        details: {
          results: [],
          progress: [{ ...child, status: childStatus, ...extra }],
          async: {
            type: "task",
            jobId: "probe",
            state: childStatus === "completed" ? "completed" : "running",
          },
        },
      },
    });
    const updates = [
      {
        sessionUpdate: "tool_call",
        toolCallId: "spawn-probe",
        title: "Spawning probe",
        kind: "other",
        status: "in_progress",
      },
      update("in_progress", "pending"),
      update("completed", "pending"),
      update("in_progress", "running", {
        resolvedModelIdentity: "openai-codex/gpt-6-astra",
        resolvedThinkingLevel: "medium",
        tokens: 20,
      }),
      update("in_progress", "completed", {
        resolvedModelIdentity: "openai-codex/gpt-6-astra",
        resolvedThinkingLevel: "medium",
        tokens: 42,
        durationMs: 500,
        extractedToolData: { yield: [{ data: { result: "OMP_CHILD_OK" }, status: "success" }] },
        recentOutput: ["Still working"],
      }),
    ];
    const adapter = yield* makeOmpAdapter({
      instanceId,
      enabled: true,
      makeRuntime: (cwd) =>
        AcpSessionRuntime.make({
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd,
            env: { ...process.env, T3_ACP_PROMPT_UPDATES: JSON.stringify(updates) },
          },
          cwd,
          clientInfo: { name: "t3-omp-test", version: "0.0.0" },
          authMethodId: "agent",
        }).pipe(Effect.provide(NodeServices.layer)),
    });
    const seen: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          seen.push(event);
        }),
      ),
      Effect.forkScoped,
    );
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "Spawn probe" });
    const tasks = seen.filter((event) => event.type.startsWith("task."));
    expect(tasks.filter((event) => event.type === "task.started")).toHaveLength(1);
    expect(tasks.filter((event) => event.type === "task.completed")).toHaveLength(1);
    expect(tasks.at(-1)).toMatchObject({
      type: "task.completed",
      payload: {
        status: "completed",
        title: "probe",
        role: "task",
        model: "openai-codex/gpt-6-astra",
        effort: "medium",
        summary: "OMP_CHILD_OK",
        typedUsage: { totalTokens: 42, durationMs: 500 },
      },
    });
    expect(tasks.find((event) => event.type === "task.progress")).toMatchObject({
      payload: { status: "pending" },
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-omp-tasks-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("tracks batched nested children and distinct failed and aborted outcomes", () =>
  Effect.gen(function* () {
    const snapshot = (progress: unknown[], results: unknown[] = []) => ({
      sessionUpdate: "tool_call_update",
      toolCallId: "spawn-batch",
      status: "in_progress",
      rawOutput: { details: { progress, results } },
    });
    const running = { index: 0, id: "parent", agent: "task", status: "running", task: "Parent" };
    const nested = {
      index: 0,
      id: "parent.child",
      agent: "task",
      status: "running",
      task: "Nested",
    };
    const failed = { index: 1, id: "failed", agent: "scout", status: "running", task: "Fail" };
    const aborted = { index: 2, id: "aborted", agent: "task", status: "running", task: "Abort" };
    const updates = [
      {
        sessionUpdate: "tool_call",
        toolCallId: "spawn-batch",
        title: "Spawning batch",
        status: "in_progress",
      },
      snapshot([
        { ...running, inflightTaskDetails: { progress: [nested], results: [] } },
        failed,
        aborted,
      ]),
      snapshot([
        {
          ...running,
          status: "completed",
          extractedToolData: {
            task: [{ progress: [], results: [{ ...nested, exitCode: 0, output: "Nested done" }] }],
          },
        },
        {
          ...failed,
          status: "failed",
          exitCode: 1,
          error: "Failed to inspect",
          recentOutput: ["Still inspecting"],
        },
        { ...aborted, status: "aborted", aborted: true },
      ]),
      snapshot([
        { ...running, status: "completed" },
        { ...failed, status: "failed" },
        { ...aborted, status: "aborted" },
      ]),
    ];
    const adapter = yield* makeOmpAdapter({
      instanceId,
      enabled: true,
      makeRuntime: (cwd) =>
        AcpSessionRuntime.make({
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd,
            env: { ...process.env, T3_ACP_PROMPT_UPDATES: JSON.stringify(updates) },
          },
          cwd,
          clientInfo: { name: "t3-omp-test", version: "0.0.0" },
          authMethodId: "agent",
        }).pipe(Effect.provide(NodeServices.layer)),
    });
    const seen: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          seen.push(event);
        }),
      ),
      Effect.forkScoped,
    );
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "Spawn batch" });
    const tasks = seen.filter((event) => event.type.startsWith("task."));
    expect(tasks.filter((event) => event.type === "task.started")).toHaveLength(4);
    expect(tasks.filter((event) => event.type === "task.completed")).toHaveLength(4);
    expect(
      tasks.find(
        (event) => event.type === "task.completed" && event.payload.taskId === "parent.child",
      ),
    ).toMatchObject({
      payload: { parentAgentId: "parent", status: "completed", summary: "Nested done" },
    });
    expect(
      tasks.find((event) => event.type === "task.completed" && event.payload.taskId === "failed"),
    ).toMatchObject({ payload: { status: "failed", summary: "Failed to inspect" } });
    expect(
      tasks.find((event) => event.type === "task.updated" && event.payload.taskId === "aborted"),
    ).toMatchObject({ payload: { status: "cancelled" } });
    expect(
      tasks.find((event) => event.type === "task.completed" && event.payload.taskId === "aborted"),
    ).toMatchObject({ payload: { status: "stopped" } });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-omp-batch-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("settles live children as cancelled when the OMP session stops", () =>
  Effect.gen(function* () {
    const updates = [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "spawn-stop",
        status: "in_progress",
        rawOutput: {
          details: {
            progress: [
              {
                id: "still-running",
                index: 0,
                agent: "task",
                status: "running",
                task: "Continue",
                tokens: 12,
              },
            ],
            results: [],
          },
        },
      },
    ];
    const adapter = yield* makeOmpAdapter({
      instanceId,
      enabled: true,
      makeRuntime: (cwd) =>
        AcpSessionRuntime.make({
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd,
            env: { ...process.env, T3_ACP_PROMPT_UPDATES: JSON.stringify(updates) },
          },
          cwd,
          clientInfo: { name: "t3-omp-test", version: "0.0.0" },
          authMethodId: "agent",
        }).pipe(Effect.provide(NodeServices.layer)),
    });
    const seen: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          seen.push(event);
        }),
      ),
      Effect.forkScoped,
    );
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "Spawn a long-running child" });
    yield* adapter.stopSession(threadId);
    expect(
      seen.find(
        (event) => event.type === "task.progress" && event.payload.taskId === "still-running",
      ),
    ).toMatchObject({ payload: { typedUsage: { totalTokens: 12 } } });
    expect(
      seen.find(
        (event) => event.type === "task.updated" && event.payload.taskId === "still-running",
      ),
    ).toMatchObject({ payload: { status: "cancelled" } });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-omp-stop-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect(
  "dispatches native skills and slash commands without appending runtime instructions",
  () =>
    Effect.gen(function* () {
      const advertised: string[] = [];
      const adapter = yield* makeOmpAdapter({
        instanceId,
        enabled: true,
        onAvailableCommands: (commands) =>
          Effect.sync(() => {
            advertised.push(...commands.map((command) => command.name));
          }),
        skillNamesForCwd: () => Effect.succeed(new Set(["probe"])),
        makeRuntime: (cwd) =>
          AcpSessionRuntime.make({
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd,
              env: {
                ...process.env,
                T3_ACP_ECHO_PROMPT: "1",
                T3_ACP_STARTUP_UPDATES: JSON.stringify([
                  {
                    sessionUpdate: "available_commands_update",
                    availableCommands: [
                      { name: "skill:probe", description: "Run probe" },
                      { name: "model", description: "Show model" },
                    ],
                  },
                ]),
              },
            },
            cwd,
            clientInfo: { name: "t3-omp-test", version: "0.0.0" },
            authMethodId: "agent",
          }).pipe(Effect.provide(NodeServices.layer)),
      });
      const seen: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      expect(advertised).toEqual(["skill:probe", "model"]);
      const promptAfter = (index: number) => {
        const delta = seen.slice(index).find((event) => event.type === "content.delta");
        expect(delta?.type).toBe("content.delta");
        if (delta?.type !== "content.delta") return [];
        return JSON.parse(delta.payload.delta) as Array<{ type: string; text: string }>;
      };
      let before = seen.length;
      yield* adapter.sendTurn({ threadId, input: "$probe inspect this" });
      expect(promptAfter(before)).toEqual([{ type: "text", text: "/skill:probe inspect this" }]);
      before = seen.length;
      yield* adapter.sendTurn({ threadId, input: "/model" });
      expect(promptAfter(before)).toEqual([{ type: "text", text: "/model" }]);
      before = seen.length;
      yield* adapter.sendTurn({ threadId, input: "Use /skill:probe now" });
      expect(promptAfter(before)).toEqual([{ type: "text", text: "Use /skill:probe now" }]);
      before = seen.length;
      yield* adapter.sendTurn({ threadId, input: "Explain this" });
      expect(promptAfter(before)[0]).toEqual({ type: "text", text: "Explain this" });
      expect(promptAfter(before)).toHaveLength(2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-omp-skills-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("links a child first seen on a later turn to its spawning turn", () =>
  Effect.gen(function* () {
    const update = (progress: unknown[]) => ({
      sessionUpdate: "tool_call_update",
      toolCallId: "spawn-late",
      status: "in_progress",
      rawOutput: { details: { progress, results: [] } },
    });
    const parent = { id: "parent", index: 0, agent: "task", task: "Parent", status: "running" };
    const first = [
      {
        sessionUpdate: "tool_call",
        toolCallId: "spawn-late",
        title: "Spawning parent",
        status: "in_progress",
      },
      update([parent]),
    ];
    const second = [
      update([
        {
          ...parent,
          inflightTaskDetails: {
            progress: [
              {
                id: "parent.child",
                index: 0,
                agent: "task",
                task: "Nested",
                status: "completed",
                tokens: 9,
              },
            ],
            results: [],
          },
        },
      ]),
    ];
    const adapter = yield* makeOmpAdapter({
      instanceId,
      enabled: true,
      makeRuntime: (cwd) =>
        AcpSessionRuntime.make({
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd,
            env: {
              ...process.env,
              T3_ACP_PROMPT_UPDATES: JSON.stringify(first),
              T3_ACP_SECOND_PROMPT_UPDATES: JSON.stringify(second),
            },
          },
          cwd,
          clientInfo: { name: "t3-omp-test", version: "0.0.0" },
          authMethodId: "agent",
        }).pipe(Effect.provide(NodeServices.layer)),
    });
    const seen: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          seen.push(event);
        }),
      ),
      Effect.forkScoped,
    );
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const origin = yield* adapter.sendTurn({ threadId, input: "Spawn parent" });
    const followup = yield* adapter.sendTurn({ threadId, input: "Wait for it" });
    expect(followup.turnId).not.toBe(origin.turnId);
    expect(
      seen.find(
        (event) => event.type === "task.started" && event.payload.taskId === "parent.child",
      ),
    ).toMatchObject({ turnId: origin.turnId, payload: { parentAgentId: "parent" } });
    expect(
      seen.find(
        (event) => event.type === "task.completed" && event.payload.taskId === "parent.child",
      ),
    ).toMatchObject({
      turnId: origin.turnId,
      payload: { status: "completed", typedUsage: { totalTokens: 9 } },
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-omp-late-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
