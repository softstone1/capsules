export * as CapsuleKind from "./kinds"

import { CapsuleManifest } from "./manifest"

/**
 * The Kind Registry — kinds are data, convergence strategies are code.
 *
 * A kind answers "what does *converged* mean for this manifest?". The reconcile
 * loop is kind-agnostic: it reads `kind`, looks up the strategy here, and
 * parameterises itself. New kinds that reuse an existing strategy become data (a
 * kind file) in a later increment; only a genuinely new way to converge touches
 * the `ConvergenceStrategy` set.
 *
 * @module
 */

export interface KindDef {
  readonly kind: CapsuleManifest.Kind
  readonly convergence: CapsuleManifest.ConvergenceStrategy
  readonly roles: ReadonlyArray<CapsuleManifest.Role>
}

export const BUILTINS: Record<CapsuleManifest.Kind, KindDef> = {
  Capsule: { kind: "Capsule", convergence: "gates_and_acceptance", roles: ["application", "feature"] },
  Task: { kind: "Task", convergence: "acceptance_only", roles: ["task", "general"] },
}

/** The strategy that governs a manifest: an explicit `spec.convergence`, else the kind default. */
export function convergence(manifest: CapsuleManifest.Manifest): CapsuleManifest.ConvergenceStrategy {
  return manifest.spec.convergence ?? BUILTINS[manifest.kind ?? "Capsule"].convergence
}
