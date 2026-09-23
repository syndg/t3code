import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const Child = Schema.Struct({
  id: Schema.NonEmptyString,
  index: Schema.optional(Schema.Number),
  agent: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  task: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  aborted: Schema.optional(Schema.Boolean),
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  tokens: Schema.optional(Schema.Number),
  toolCount: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
  currentTool: Schema.optional(Schema.String),
  lastIntent: Schema.optional(Schema.String),
  resolvedModelIdentity: Schema.optional(Schema.String),
  resolvedThinkingLevel: Schema.optional(Schema.String),
  recentOutput: Schema.optional(Schema.Array(Schema.String)),
  inflightTaskDetails: Schema.optional(Schema.Unknown),
  extractedToolData: Schema.optional(Schema.Unknown),
});
const decodeChild = Schema.decodeUnknownOption(Child);

export type OmpChild = typeof Child.Type;
export interface OmpChildSnapshot {
  readonly child: OmpChild;
  readonly parentAgentId?: string;
  readonly result: boolean;
}

export function boundedOmpChildText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 500 ? `${trimmed.slice(0, 499)}…` : trimmed;
}

/** OMP's async child completion can carry its answer only in a successful `yield` result. */
export function ompChildYieldResult(child: OmpChild): string | undefined {
  if (!Predicate.isObject(child.extractedToolData) || !Array.isArray(child.extractedToolData.yield))
    return undefined;
  for (const entry of child.extractedToolData.yield.toReversed()) {
    if (!Predicate.isObject(entry) || entry.status !== "success" || !Predicate.isObject(entry.data))
      continue;
    const answer = entry.data.result;
    const text =
      typeof answer === "string"
        ? boundedOmpChildText(answer)
        : Predicate.isObject(answer) || Array.isArray(answer)
          ? boundedOmpChildText(JSON.stringify(answer))
          : undefined;
    if (text) return text;
  }
  return undefined;
}

/** OMP nests task snapshots inside each child's live and completed tool data. */
export function ompChildSnapshots(rawOutput: unknown): ReadonlyArray<OmpChildSnapshot> {
  const snapshots: OmpChildSnapshot[] = [];
  const visited = new WeakSet<object>();
  const scanDetails = (value: unknown, parentAgentId?: string): void => {
    if (!Predicate.isObject(value) || visited.has(value)) return;
    visited.add(value);
    const progress = Array.isArray(value.progress) ? value.progress : [];
    const results = Array.isArray(value.results) ? value.results : [];
    for (const [entries, result] of [
      [progress, false],
      [results, true],
    ] as const) {
      for (const entry of entries) {
        const decoded = decodeChild(entry);
        if (Option.isNone(decoded)) continue;
        const child = decoded.value;
        snapshots.push({ child, result, ...(parentAgentId ? { parentAgentId } : {}) });
        scanDetails(child.inflightTaskDetails, child.id);
        if (
          Predicate.isObject(child.extractedToolData) &&
          Array.isArray(child.extractedToolData.task)
        ) {
          for (const nested of child.extractedToolData.task) scanDetails(nested, child.id);
        }
      }
    }
  };
  if (Predicate.isObject(rawOutput)) scanDetails(rawOutput.details);
  return snapshots;
}
