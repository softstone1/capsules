export * as CapsuleReconcile from "./reconcile"

import { Effect } from "effect"
import { CapsuleKind } from "./kinds"
import { CapsuleManifest } from "./manifest"
import { CapsulePredicate } from "./predicate"

/**
 * The deterministic reconcile decision (the control plane's core).
 *
 * Diffs observed workspace state against the manifest's desired state and returns
 * exactly one outcome. No model is involved here — this is what makes termination
 * and convergence deterministic. The runner integration (a flag-gated post-turn
 * hook that injects ephemeral gap feedback and re-actuates) is increment 2b; this
 * module is its reusable, side-effect-free engine.
 *
 * @module
 */

export type Decision =
  // Desired state is met (or nothing is machine-checkable) — the loop exits.
  | { readonly _tag: "Converged" }
  // A gap remains and we are under the attempt cap — re-actuate with `gap` feedback.
  | { readonly _tag: "NeedsActuation"; readonly gap: ReadonlyArray<string> }
  // Gap persists past the cap (oscillation / budget) — stop for a human.
  | { readonly _tag: "Escalate"; readonly reason: string }

export interface GateRunResult {
  readonly ok: boolean
  readonly output: string
}

/** Runs a verification gate (a shell command). Injected so the decision stays pure/testable. */
export interface GateRunner {
  readonly run: (command: string) => Effect.Effect<GateRunResult>
}

/** The verification gates that govern convergence (only the `gates_and_acceptance` strategy runs them). */
export function gates(manifest: CapsuleManifest.Manifest): ReadonlyArray<string> {
  return CapsuleKind.convergence(manifest) === "gates_and_acceptance" ? (manifest.spec.gates ?? []) : []
}

/** The default re-actuation cap; guarantees the (future) runner loop terminates. */
export const DEFAULT_MAX_ATTEMPTS = 3

/** Pure decision from already-evaluated checks. `attempts` counts reconcile passes so far. */
export function decide(input: {
  readonly hasCheckable: boolean
  readonly failing: ReadonlyArray<string>
  readonly attempts: number
  readonly maxAttempts: number
}): Decision {
  if (!input.hasCheckable || input.failing.length === 0) return { _tag: "Converged" }
  if (input.attempts >= input.maxAttempts)
    return { _tag: "Escalate", reason: `not converged after ${input.maxAttempts} attempts: ${input.failing.join("; ")}` }
  return { _tag: "NeedsActuation", gap: input.failing }
}

/** Evaluate a manifest's checkable acceptance + verification gates, then decide. */
export function evaluate(input: {
  readonly manifest: CapsuleManifest.Manifest
  readonly env: CapsulePredicate.Env
  readonly attempts: number
  readonly maxAttempts?: number
  // Optional: when present, `spec.gates` (for the gates_and_acceptance strategy) run
  // as commands and must exit 0. Absent ⟹ gates are advisory (not executed).
  readonly gates?: GateRunner
}): Effect.Effect<Decision> {
  return Effect.gen(function* () {
    const strategy = CapsuleKind.convergence(input.manifest)
    // A human signs off on manual_approval; the loop never drives it.
    if (strategy === "manual_approval") return { _tag: "Converged" } as Decision
    const checks = checkables(input.manifest, strategy)
    const gateCommands = input.gates ? gates(input.manifest) : []
    if (checks.length === 0 && gateCommands.length === 0) return { _tag: "Converged" } as Decision
    const predicateResults = yield* Effect.forEach(
      checks,
      (check) => CapsulePredicate.evaluate(check.predicate, input.env).pipe(Effect.map((pass) => ({ pass, describe: check.describe }))),
      { concurrency: "unbounded" },
    )
    const runner = input.gates
    const gateResults = runner
      ? yield* Effect.forEach(gateCommands, (command) => runner.run(command).pipe(Effect.map((result) => ({ pass: result.ok, describe: gateGap(command, result) }))), {
          concurrency: 1,
        })
      : []
    return decide({
      hasCheckable: true,
      failing: [...predicateResults, ...gateResults].filter((result) => !result.pass).map((result) => result.describe),
      attempts: input.attempts,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    })
  })
}

function gateGap(command: string, result: GateRunResult): string {
  const tail = result.output.trim().slice(-300).replace(/\s+/g, " ").trim()
  return `gate failed: \`${command}\`${tail ? ` — ${tail}` : ""}`
}

/**
 * The distinct workspace files convergence depends on (every checkable predicate's
 * path). The reconciler fingerprints these to skip re-evaluation when nothing
 * relevant changed since the last convergence (increment 4). The invariant: this
 * must cover every file the predicates read, or a change could be missed.
 */
export function inputs(manifest: CapsuleManifest.Manifest): ReadonlyArray<string> {
  return Array.from(new Set(checkables(manifest, CapsuleKind.convergence(manifest)).map((check) => check.predicate.path)))
}

/** Reconciler-owned status for a decision. Persisted only on convergence (later increment). */
export function status(manifest: CapsuleManifest.Manifest, decision: Decision): CapsuleManifest.Status {
  const observedGeneration = manifest.metadata.generation
  const base = observedGeneration === undefined ? {} : { observedGeneration }
  if (decision._tag === "Converged")
    return { ...base, phase: "Converged", conditions: [{ type: "Converged", status: "True", reason: "AcceptanceMet" }] }
  if (decision._tag === "Escalate")
    return {
      ...base,
      phase: "Escalated",
      conditions: [{ type: "Converged", status: "False", reason: "Escalated", message: decision.reason }],
    }
  return {
    ...base,
    phase: "Reconciling",
    conditions: [{ type: "Converged", status: "False", reason: "AcceptanceGap", message: decision.gap.join("; ") }],
  }
}

/**
 * The ephemeral gap-feedback message the runner injects to re-actuate (increment
 * 2b). Returns undefined unless the decision asks for actuation. Never persisted
 * to durable history — it is rebuilt from `status` each pass.
 */
export function feedback(manifest: CapsuleManifest.Manifest, decision: Decision): string | undefined {
  if (decision._tag !== "NeedsActuation") return undefined
  return [
    `The capsule "${manifest.metadata.name}" is not yet converged. These acceptance criteria are unmet:`,
    ...decision.gap.map((gap) => `- ${gap}`),
    "Make the changes needed to satisfy them, then stop.",
  ].join("\n")
}

interface Checkable {
  readonly predicate: CapsuleManifest.Predicate
  readonly describe: string
}

function checkables(
  manifest: CapsuleManifest.Manifest,
  strategy: CapsuleManifest.ConvergenceStrategy,
): ReadonlyArray<Checkable> {
  // artifacts_present converges when every referenced artifact exists on disk.
  if (strategy === "artifacts_present")
    return Object.values(manifest.spec.artifacts ?? {}).map((artifact) => ({
      predicate: { kind: "file_exists", path: artifact.path },
      describe: `artifact present: ${artifact.path}`,
    }))
  // acceptance_only and gates_and_acceptance are governed by typed acceptance
  // predicates. Executable shell gates are a later sub-increment; until then a
  // Capsule converges on its acceptance predicates alone.
  return CapsuleManifest.acceptancePredicates(manifest).map((predicate) => ({
    predicate,
    describe: CapsuleManifest.describePredicate(predicate),
  }))
}
