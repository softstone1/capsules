export * as CapsuleReconciler from "./reconciler"

import { Context, Effect, Layer, Option, Schema } from "effect"
import { isAbsolute, join } from "path"
import { Flag } from "../flag/flag"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Hash } from "../util/hash"
import { CapsuleLoad } from "./load"
import { CapsuleManifest } from "./manifest"
import { CapsulePredicate } from "./predicate"
import { CapsuleReconcile } from "./reconcile"

/**
 * The post-turn reconcile hook the session runner consults (increment 2b).
 *
 * The runner owns the loop and the attempt counter; this service owns the
 * deterministic decision. Two layers keep the runner's wiring clean:
 *
 * - `noop` — never re-actuates, no dependencies. The default in tests and
 *   anywhere the feature is not wired, so the runner's behavior is unchanged.
 * - `layer` — the real reconciler (requires `FSUtil` + `Location`). Returns
 *   ephemeral gap feedback while a manifest's acceptance is unmet and the attempt
 *   cap is not reached; undefined once converged, escalated, disabled, or absent.
 *
 * @module
 */

export interface Interface {
  /**
   * Evaluate the active capsule after a settled turn. `attempts` is the
   * re-actuation count so far. Returns ephemeral gap feedback to inject and
   * re-actuate, or undefined to let the turn settle.
   */
  readonly afterTurn: (attempts: number) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/CapsuleReconciler") {}

export const noop = Layer.succeed(Service, Service.of({ afterTurn: () => Effect.succeed(undefined) }))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const statusPath = join(location.project.directory, ".opencode", "capsule-status.json")
    const env: CapsulePredicate.Env = {
      resolve: (path) => (isAbsolute(path) ? path : join(location.project.directory, path)),
      read: (path) => fs.readFileStringSafe(path).pipe(Effect.orElseSucceed(() => undefined)),
    }
    const decodeStatus = Schema.decodeUnknownOption(CapsuleManifest.Status, { errors: "all", onExcessProperty: "ignore" })
    const readStatus = fs.readJson(statusPath).pipe(
      Effect.map((json) => Option.getOrUndefined(decodeStatus(json))),
      Effect.orElseSucceed(() => undefined),
    )
    // A content fingerprint over the manifest generation and every file
    // convergence depends on. Identical fingerprint ⟹ nothing relevant changed.
    const fingerprint = (manifest: CapsuleManifest.Manifest) =>
      Effect.forEach(
        CapsuleReconcile.inputs(manifest),
        (path) => env.read(env.resolve(path)).pipe(Effect.map((content) => `${path}=${content === undefined ? "∅" : Hash.sha256(content)}`)),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((parts) => Hash.sha256(JSON.stringify([manifest.metadata.generation ?? 0, [...parts].sort()]))))
    const afterTurn = (attempts: number) =>
      Effect.gen(function* () {
        if (!Flag.OPENCODE_EXPERIMENTAL_CAPSULE_RECONCILE) return undefined
        const manifest = yield* CapsuleLoad.load()
        if (!manifest) return undefined
        // Change-aware skip: if we last converged at this exact fingerprint,
        // nothing convergence depends on has changed — re-evaluation is redundant.
        const current = yield* fingerprint(manifest)
        const previous = yield* readStatus
        if (previous?.phase === "Converged" && previous.lastConvergedHash === current) return undefined
        const decision = yield* CapsuleReconcile.evaluate({ manifest, env, attempts })
        // Persist only on converge (status is reconciler-owned, separate from the
        // authored manifest). Best-effort: a write failure never breaks the turn.
        if (decision._tag === "Converged") {
          yield* fs
            .writeJson(statusPath, { ...CapsuleReconcile.status(manifest, decision), lastConvergedHash: current })
            .pipe(Effect.orElseSucceed(() => undefined))
          return undefined
        }
        // NeedsActuation → gap feedback; Escalate → undefined (loop stops).
        return CapsuleReconcile.feedback(manifest, decision)
      }).pipe(Effect.provideService(FSUtil.Service, fs), Effect.provideService(Location.Service, location))
    return Service.of({ afterTurn })
  }),
)
