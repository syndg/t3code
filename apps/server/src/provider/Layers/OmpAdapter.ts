import {
  ApprovalRequestId,
  EventId,
  OMP_DEFAULT_MODEL,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
  RuntimeRequestId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  type TurnCompletedPayload,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("omp");
const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
});
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursor);
const isAcpError = Schema.is(AcpErrors.AcpError);
type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];

interface PendingApproval {
  readonly request: AcpSchema.RequestPermissionRequest;
  readonly response: Deferred.Deferred<{
    decision: ProviderApprovalDecision;
    result: AcpSchema.RequestPermissionResponse;
  }>;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly scope: Scope.Closeable;
  readonly runtime: Runtime;
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptFiber: Fiber.Fiber<AcpSchema.PromptResponse, AcpErrors.AcpError> | undefined;
  stopped: boolean;
  closed: boolean;
}

export interface OmpAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly makeRuntime: (
    cwd: string,
    resumeSessionId?: string,
    approvalMode?: string,
    mcpServers?: ReadonlyArray<AcpSchema.McpServer>,
  ) => Effect.Effect<Runtime, AcpErrors.AcpError, Scope.Scope>;
}

function approvalMode(runtimeMode: ProviderSession["runtimeMode"]): string | undefined {
  if (runtimeMode === "full-access") return "yolo";
  if (runtimeMode === "auto-accept-edits") return "write";
  if (runtimeMode === "approval-required") return "always-ask";
  return undefined;
}

function approvalOptions(request: AcpSchema.RequestPermissionRequest) {
  return request.options.map((option) => ({
    label: option.name,
    decision:
      option.kind === "allow_always"
        ? ("acceptForSession" as const)
        : option.kind.startsWith("allow")
          ? ("accept" as const)
          : ("decline" as const),
  }));
}

function optionForDecision(
  request: AcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
) {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : decision === "decline"
          ? "reject_once"
          : undefined;
  return kind ? request.options.find((option) => option.kind === kind) : undefined;
}

export const makeOmpAdapter = Effect.fn("makeOmpAdapter")(function* (options: OmpAdapterOptions) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const ownerScope = yield* Scope.Scope;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, SessionContext>();
  const locks = new Map<ThreadId, Semaphore.Semaphore>();
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create an OMP event ID.",
          cause,
        }),
    ),
  );
  const stamp = Effect.all({
    eventId: Effect.map(randomId, EventId.make),
    createdAt: Effect.map(DateTime.now, DateTime.formatIso),
  });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };
  const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      let lock = locks.get(threadId);
      if (!lock) {
        lock = yield* Semaphore.make(1);
        locks.set(threadId, lock);
      }
      return yield* lock.withPermit(task);
    });

  const stopContext = (context: SessionContext) =>
    context.stopLock.withPermit(
      Effect.gen(function* () {
        if (context.closed) return;
        context.stopped = true;
        for (const pending of context.approvals.values()) {
          yield* Deferred.succeed(pending.response, {
            decision: "cancel",
            result: { outcome: { outcome: "cancelled" } },
          });
        }
        if (context.promptFiber) yield* Effect.ignore(context.runtime.cancel);
        yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignoreCause({ log: true }));
        context.closed = true;
        if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
        yield* emit({
          type: "session.exited",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          payload: { exitKind: "graceful" },
        });
      }).pipe(Effect.uninterruptible),
    );

  const handlePermission = (context: SessionContext, request: AcpSchema.RequestPermissionRequest) =>
    Effect.gen(function* () {
      if (context.stopped) return { outcome: { outcome: "cancelled" as const } };
      const requestId = ApprovalRequestId.make(yield* randomId);
      const response = yield* Deferred.make<{
        decision: ProviderApprovalDecision;
        result: AcpSchema.RequestPermissionResponse;
      }>();
      context.approvals.set(requestId, { request, response });
      const parsed = parsePermissionRequest(request);
      const turnId = context.activeTurnId;
      return yield* Effect.gen(function* () {
        yield* emit(
          makeAcpRequestOpenedEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId,
            requestId: RuntimeRequestId.make(requestId),
            permissionRequest: parsed,
            approvalOptions: approvalOptions(request),
            detail: parsed.detail ?? "OMP requests permission.",
            args: request.toolCall.rawInput,
            source: "acp.jsonrpc",
            method: "session/request_permission",
            rawPayload: request,
          }),
        );
        const answer = yield* Deferred.await(response);
        yield* emit(
          makeAcpRequestResolvedEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId,
            requestId: RuntimeRequestId.make(requestId),
            permissionRequest: parsed,
            decision: answer.decision,
          }),
        );
        return answer.result;
      }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
    });

  const handleEvent = (context: SessionContext, event: AcpSessionRuntime.AcpSessionRuntimeEvent) =>
    Effect.gen(function* () {
      if (event._tag === "EventStreamBarrier") {
        yield* Deferred.succeed(event.acknowledge, undefined);
        return;
      }
      if (context.stopped) return;
      switch (event._tag) {
        case "ConnectionTerminated":
          yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
          return;
        case "AssistantItemStarted":
        case "AssistantItemCompleted":
          yield* emit(
            makeAcpAssistantItemEvent({
              stamp: yield* stamp,
              provider: PROVIDER,
              threadId: context.threadId,
              turnId: context.activeTurnId,
              itemId: event.itemId,
              lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
            }),
          );
          return;
        case "ThoughtDelta":
        case "ContentDelta":
          yield* emit(
            makeAcpContentDeltaEvent({
              stamp: yield* stamp,
              provider: PROVIDER,
              threadId: context.threadId,
              turnId: context.activeTurnId,
              ...(event._tag === "ContentDelta" && event.itemId ? { itemId: event.itemId } : {}),
              ...(event._tag === "ThoughtDelta" ? { streamKind: "reasoning_text" } : {}),
              text: event.text,
              rawPayload: event.rawPayload,
            }),
          );
          return;
        case "PlanUpdated":
          yield* emit(
            makeAcpPlanUpdatedEvent({
              stamp: yield* stamp,
              provider: PROVIDER,
              threadId: context.threadId,
              turnId: context.activeTurnId,
              payload: event.payload,
              source: "acp.jsonrpc",
              method: "session/update",
              rawPayload: event.rawPayload,
            }),
          );
          return;
        case "ToolCallUpdated":
          yield* emit(
            makeAcpToolCallEvent({
              stamp: yield* stamp,
              provider: PROVIDER,
              threadId: context.threadId,
              turnId: context.activeTurnId,
              toolCall: event.toolCall,
              rawPayload: event.rawPayload,
            }),
          );
          return;
      }
    });

  const startSession: Adapter["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (!options.enabled)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Enable Oh My Pi in provider settings.",
          });
        if (
          (input.provider && input.provider !== PROVIDER) ||
          (input.providerInstanceId && input.providerInstanceId !== options.instanceId) ||
          (input.modelSelection && input.modelSelection.instanceId !== options.instanceId)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The OMP provider instance does not match the requested session.",
          });
        }
        const cwd = input.cwd;
        if (!cwd?.trim())
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "A workspace directory is required.",
          });
        const cursor = decodeResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && Option.isNone(cursor))
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The saved OMP session is invalid.",
          });
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);
        const sessionScope = yield* Scope.make("sequential");
        let transferred = false;
        yield* Effect.addFinalizer(() =>
          transferred
            ? Effect.void
            : Scope.close(sessionScope, Exit.void).pipe(Effect.ignoreCause({ log: true })),
        );
        return yield* Effect.gen(function* () {
          const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
          const runtime = yield* options.makeRuntime(
            cwd,
            Option.isSome(cursor) ? cursor.value.sessionId : undefined,
            approvalMode(input.runtimeMode),
            mcp
              ? [
                  {
                    type: "http",
                    name: "t3-code",
                    url: mcp.endpoint,
                    headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                  },
                ]
              : [],
          );
          let context: SessionContext | undefined;
          yield* runtime.handleRequestPermission((request) =>
            context
              ? handlePermission(context, request).pipe(
                  Effect.mapError((cause) =>
                    AcpErrors.AcpRequestError.internalError(
                      "Could not process an OMP permission request.",
                      undefined,
                      { cause },
                    ),
                  ),
                )
              : Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
          );
          const started = yield* runtime.start();
          const modelConfig = started.sessionSetupResult.configOptions?.find(
            (option) => option.id === "model",
          );
          const currentModel =
            modelConfig?.type === "select" ? modelConfig.currentValue : undefined;
          const selectedModel = input.modelSelection?.model;
          const model =
            selectedModel && selectedModel !== OMP_DEFAULT_MODEL ? selectedModel : currentModel;
          if (model && model !== currentModel) yield* runtime.setModel(model);
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            cwd: input.cwd,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(model ? { model } : {}),
            resumeCursor: { schemaVersion: 1, sessionId: started.sessionId },
            createdAt,
            updatedAt: createdAt,
          };
          const running: SessionContext = {
            threadId: input.threadId,
            cwd,
            scope: sessionScope,
            runtime,
            promptLock: yield* Semaphore.make(1),
            stopLock: yield* Semaphore.make(1),
            approvals: new Map(),
            turns: [],
            session,
            activeTurnId: undefined,
            promptFiber: undefined,
            stopped: false,
            closed: false,
          };
          context = running;
          sessions.set(input.threadId, running);
          yield* Stream.runForEach(runtime.getEvents(), (event) =>
            handleEvent(running, event),
          ).pipe(
            Effect.catchCause(() => Effect.logError("Could not process an OMP ACP event.")),
            Effect.forkIn(sessionScope),
          );
          yield* emit({
            type: "session.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* emit({
            type: "session.state.changed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "OMP ACP session ready" },
          });
          yield* emit({
            type: "thread.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          yield* runtime.drainEvents;
          transferred = true;
          return session;
        }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError((cause) =>
            isAcpError(cause)
              ? mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause)
              : cause,
          ),
        );
      }).pipe(Effect.scoped),
    );

  const sendTurn: Adapter["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "The selected model belongs to another provider instance.",
        });
      const prompt: AcpSchema.ContentBlock[] = [];
      const text = input.input?.trim() ?? "";
      if (text) prompt.push({ type: "text", text });
      for (const attachment of input.attachments ?? []) {
        if (attachment.type !== "image") continue;
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Invalid image attachment '${attachment.name}'.`,
          });
        const info = yield* fs.stat(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "attachment/stat",
                detail: `Could not read '${attachment.name}'.`,
                cause,
              }),
          ),
        );
        if (info.type !== "File" || Number(info.size) > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Image '${attachment.name}' is too large.`,
          });
        const bytes = yield* fs.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "attachment/read",
                detail: `Could not read '${attachment.name}'.`,
                cause,
              }),
          ),
        );
        if (bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Image '${attachment.name}' is too large.`,
          });
        prompt.push({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType,
        });
      }
      if (prompt.length === 0)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "A turn requires text or an image.",
        });
      return yield* context.promptLock.withPermit(
        Effect.gen(function* () {
          const turnId = TurnId.make(yield* randomId);
          let started = false;
          const settle = (payload: TurnCompletedPayload) =>
            Effect.gen(function* () {
              if (!started || context.stopped || context.activeTurnId !== turnId) return;
              context.activeTurnId = undefined;
              context.promptFiber = undefined;
              context.session = {
                ...context.session,
                status: payload.state === "failed" ? "error" : "ready",
                activeTurnId: undefined,
                updatedAt: DateTime.formatIso(yield* DateTime.now),
                ...(payload.errorMessage ? { lastError: payload.errorMessage } : {}),
              };
              yield* emit({
                type: "turn.completed",
                ...(yield* stamp),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload,
              });
            }).pipe(Effect.uninterruptible);
          return yield* Effect.gen(function* () {
            const requestedModel = input.modelSelection?.model;
            const model =
              requestedModel && requestedModel !== OMP_DEFAULT_MODEL
                ? requestedModel
                : context.session.model;
            if (model && model !== context.session.model)
              yield* context.runtime
                .setModel(model)
                .pipe(
                  Effect.mapError((cause) =>
                    mapAcpToAdapterError(
                      PROVIDER,
                      input.threadId,
                      "session/set_config_option",
                      cause,
                    ),
                  ),
                );
            const thinking = input.modelSelection
              ? getModelSelectionStringOptionValue(input.modelSelection, "thinking")
              : undefined;
            if (thinking)
              yield* context.runtime
                .setConfigOption("thinking", thinking)
                .pipe(
                  Effect.mapError((cause) =>
                    mapAcpToAdapterError(
                      PROVIDER,
                      input.threadId,
                      "session/set_config_option",
                      cause,
                    ),
                  ),
                );
            context.activeTurnId = turnId;
            context.session = {
              ...context.session,
              status: "running",
              activeTurnId: turnId,
              ...(model ? { model } : {}),
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
            started = true;
            yield* emit({
              type: "turn.started",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: model ? { model } : {},
            });
            const fiber = yield* context.runtime
              .prompt({
                prompt: [
                  ...prompt,
                  { type: "text", text: buildRuntimeInstructions({ harness: "Oh My Pi", model }) },
                ],
              })
              .pipe(Effect.forkIn(context.scope));
            context.promptFiber = fiber;
            const result = yield* Fiber.await(fiber).pipe(
              Effect.flatMap((exit) => exit),
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", cause),
              ),
            );
            yield* context.runtime.drainEvents;
            context.turns.push({ id: turnId, items: [result] });
            yield* settle({
              state: result.stopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: result.stopReason,
            });
            return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
          }).pipe(
            Effect.tapError((cause) => settle({ state: "failed", errorMessage: cause.message })),
            Effect.onInterrupt(() =>
              Effect.ignore(context.runtime.cancel).pipe(
                Effect.andThen(settle({ state: "cancelled", stopReason: "cancelled" })),
              ),
            ),
          );
        }),
      );
    });

  const stopAll = () => Effect.forEach([...sessions.values()], stopContext, { discard: true });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(Effect.ignoreCause({ log: true }), Effect.ensuring(PubSub.shutdown(events))),
  );
  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    compaction: { type: "slash-command", command: "/compact" },
    startSession,
    sendTurn,
    interruptTurn: (threadId) =>
      Effect.flatMap(requireSession(threadId), (context) =>
        context.runtime.cancel.pipe(
          Effect.mapError((cause) =>
            mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", cause),
          ),
        ),
      ),
    respondToRequest: (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.approvals.get(requestId);
        if (!pending)
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: "This approval is no longer pending.",
          });
        const option =
          decision === "cancel" ? undefined : optionForDecision(pending.request, decision);
        if (decision !== "cancel" && !option)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: "OMP did not offer that permission choice.",
          });
        yield* Deferred.succeed(pending.response, {
          decision,
          result: {
            outcome: option
              ? { outcome: "selected", optionId: option.optionId }
              : { outcome: "cancelled" },
          },
        });
      }),
    respondToUserInput: (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/elicitation",
          detail: `OMP has no pending user-input request for ${threadId}.`,
        }),
      ),
    stopSession: (threadId) =>
      withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopContext)),
    stopAll,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.stopped)
          .map((context) => ({ ...context.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
    rollbackThread: () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "OMP ACP does not support conversation rewind.",
        }),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
