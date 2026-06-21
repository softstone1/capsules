export * as CapsuleManifest from "./manifest"

import { Schema } from "effect"

/**
 * The Capsule Manifest — a typed, Kubernetes-shaped envelope that is becoming the
 * single source of truth for what governs a project and where to find it.
 *
 * `spec` is authored desired state (human / template / compiler). `status` is
 * reconciler-owned observed state. v0 ships the full envelope but only renders the
 * authored governing fields into system context; the reconciler that writes
 * `status` and enforces `gates` / `invariants` arrives in later increments
 * (see `specs/v2/capsule-manifest.md`).
 *
 * The manifest INDEXES; it is not a paste-bin. Prose (design docs, AGENTS.md,
 * memory) is referenced as `artifacts` and read on demand — never inlined here.
 *
 * @module
 */

export const API_VERSION = "opencode.dev/v0"

/** Where a capsule sits in the (future) capsule graph. */
export const Role = Schema.Literals(["application", "feature", "task", "general"])
export type Role = typeof Role.Type

/** Built-in dispatch kinds. New kinds become data (a kind file) in a later increment. */
export const Kind = Schema.Literals(["Capsule", "Task"])
export type Kind = typeof Kind.Type

/** What "converged" means for this manifest. The reconcile loop is parameterised by this. */
export const ConvergenceStrategy = Schema.Literals([
  "gates_and_acceptance",
  "acceptance_only",
  "artifacts_present",
  "manual_approval",
])
export type ConvergenceStrategy = typeof ConvergenceStrategy.Type

export const Metadata = Schema.Struct({
  name: Schema.NonEmptyString,
  role: Schema.optional(Role),
  /** The DAG edge to the parent node; null/absent for the root. */
  parent: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  /** Bumped on every `spec` edit; the cheap integer drift signal. */
  generation: Schema.optional(Schema.Int),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

/** A file referenced by the manifest. Read on demand; never inlined into context. */
export const Artifact = Schema.Struct({
  path: Schema.NonEmptyString,
  description: Schema.optional(Schema.String),
})

/**
 * A typed, machine-checkable acceptance predicate evaluated against the
 * workspace (deterministic filesystem reads — no shell, no model). Paths are
 * relative to the project root.
 */
export const Predicate = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("file_exists"), path: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("file_absent"), path: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("file_contains"), path: Schema.NonEmptyString, value: Schema.NonEmptyString }),
])
export type Predicate = typeof Predicate.Type

/**
 * One acceptance entry: either a typed `Predicate` (gates convergence) or a prose
 * string (advisory only — rendered as guidance, never machine-checked). Authoring
 * prose remains valid, so v0 manifests keep working as acceptance widens.
 */
export const AcceptanceItem = Schema.Union([Predicate, Schema.NonEmptyString])
export type AcceptanceItem = typeof AcceptanceItem.Type

/**
 * Authored desired state.
 *
 * v0 keeps `invariants` / `gates` / `acceptance` as human-readable strings: they
 * render as guidance now and become typed + enforced (admission, verification
 * gates) in later increments. Widening a string array to a typed record is a
 * forward-compatible change, so authored manifests keep working.
 */
export const Spec = Schema.Struct({
  goal: Schema.optional(Schema.String),
  /** File globs the work stays within. A feature subsets its parent's scope. */
  scope: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  invariants: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  gates: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  acceptance: Schema.optional(Schema.Array(AcceptanceItem)),
  artifacts: Schema.optional(Schema.Record(Schema.String, Artifact)),
  convergence: Schema.optional(ConvergenceStrategy),
})

/** One structured status fact, latest-wins per `type`. Reconciler-owned. */
export const Condition = Schema.Struct({
  type: Schema.NonEmptyString,
  status: Schema.Literals(["True", "False", "Unknown"]),
  reason: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
})

export const Phase = Schema.Literals(["Pending", "Reconciling", "Converged", "Stale", "Escalated"])
export type Phase = typeof Phase.Type

/**
 * Reconciler-owned observed state. Never authored by hand. v0 ships the shape so
 * later increments can populate it without a schema break; nothing writes it yet.
 */
export const Status = Schema.Struct({
  observedGeneration: Schema.optional(Schema.Int),
  phase: Schema.optional(Phase),
  conditions: Schema.optional(Schema.Array(Condition)),
  lastConvergedHash: Schema.optional(Schema.String),
  artifactHashes: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type Status = typeof Status.Type

export const Manifest = Schema.Struct({
  apiVersion: Schema.optional(Schema.Literal(API_VERSION)),
  kind: Schema.optional(Kind),
  metadata: Metadata,
  spec: Spec,
  status: Schema.optional(Status),
})
export type Manifest = typeof Manifest.Type

/**
 * Render the authored governing fields into a compact system-context block.
 *
 * Only authored (`spec`) fields appear, and artifacts are emitted as pointers —
 * the model is told where to read, not handed the contents. Returns an empty
 * string when there is nothing governing to say, so the caller can contribute no
 * context at all rather than an empty section.
 */
export function render(manifest: Manifest) {
  const spec = manifest.spec
  const sections = [
    spec.goal ? `Goal: ${spec.goal}` : undefined,
    list("Scope — keep work within these paths:", spec.scope),
    list("Invariants — these must hold:", spec.invariants),
    list("Acceptance — the work is done when:", spec.acceptance?.map(describeAcceptance)),
    artifacts(manifest),
  ].filter((section): section is string => section !== undefined)
  if (sections.length === 0) return ""
  return [`# Project Capsule: ${manifest.metadata.name}`, ...sections].join("\n\n")
}

/** Human-readable form of a typed predicate, used in context and gap feedback. */
export function describePredicate(predicate: Predicate) {
  if (predicate.kind === "file_exists") return `file exists: ${predicate.path}`
  if (predicate.kind === "file_absent") return `file absent: ${predicate.path}`
  return `${predicate.path} contains "${predicate.value}"`
}

/** The machine-checkable acceptance predicates; prose entries are advisory and excluded. */
export function acceptancePredicates(manifest: Manifest): ReadonlyArray<Predicate> {
  return (manifest.spec.acceptance ?? []).filter((item): item is Predicate => typeof item !== "string")
}

function describeAcceptance(item: AcceptanceItem) {
  return typeof item === "string" ? item : describePredicate(item)
}

function list(heading: string, items: ReadonlyArray<string> | undefined) {
  if (!items || items.length === 0) return undefined
  return [heading, ...items.map((item) => `- ${item}`)].join("\n")
}

function artifacts(manifest: Manifest) {
  const entries = Object.entries(manifest.spec.artifacts ?? {})
  if (entries.length === 0) return undefined
  return [
    "Reference artifacts — read on demand; do not assume their contents:",
    ...entries.map(([name, artifact]) =>
      artifact.description ? `- ${name}: ${artifact.path} — ${artifact.description}` : `- ${name}: ${artifact.path}`,
    ),
  ].join("\n")
}
