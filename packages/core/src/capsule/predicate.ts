export * as CapsulePredicate from "./predicate"

import { Effect } from "effect"
import { CapsuleManifest } from "./manifest"

/**
 * Evaluates a typed acceptance predicate against the workspace.
 *
 * Reads are injected via `Env` so the decision logic stays pure and unit-testable
 * without a filesystem: the reconciler builds an `Env` from `FSUtil` + `Location`;
 * tests build one from an in-memory map.
 *
 * @module
 */

export interface Env {
  /** Resolve a manifest-relative path to the absolute path used by `read`. */
  readonly resolve: (path: string) => string
  /** Read a file's contents, or `undefined` when it does not exist / is unreadable. */
  readonly read: (absolutePath: string) => Effect.Effect<string | undefined>
}

export function evaluate(predicate: CapsuleManifest.Predicate, env: Env): Effect.Effect<boolean> {
  return env.read(env.resolve(predicate.path)).pipe(
    Effect.map((content) => {
      if (predicate.kind === "file_exists") return content !== undefined
      if (predicate.kind === "file_absent") return content === undefined
      return content !== undefined && content.includes(predicate.value)
    }),
  )
}
