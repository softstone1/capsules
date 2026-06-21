export * as CapsuleAdmission from "./admission"

import { Context, Effect, Layer } from "effect"
import { minimatch } from "minimatch"
import { isAbsolute, relative, resolve } from "path"
import { Flag } from "../flag/flag"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { CapsuleLoad } from "./load"

/**
 * Pre-apply scope admission (increment 3): a file-mutating write to a path outside
 * the capsule's `spec.scope` is rejected before it lands, deterministically.
 *
 * The permission layer consults this in its deny pre-check. Two layers keep the
 * wiring clean and safe:
 *
 * - `noop` — never flags a violation, no dependencies. The default everywhere the
 *   feature is unwired, so permission behavior is unchanged.
 * - `layer` — the real check (requires `FSUtil` + `Location`). It is **deny-only
 *   and conservative**: it flags a violation solely when it is confident a path is
 *   outside scope. Flag off, no manifest, no `scope`, a non-write action, or a path
 *   it cannot map into the project all yield "no violation" — so admission can
 *   never block legitimate work it is unsure about.
 *
 * @module
 */

export interface Violation {
  readonly resource: string
  readonly reason: string
}

export interface Interface {
  /** Resources of a file-mutating action that fall outside the capsule scope. Empty = admitted. */
  readonly violations: (action: string, resources: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Violation>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/CapsuleAdmission") {}

export const noop = Layer.succeed(Service, Service.of({ violations: () => Effect.succeed([]) }))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const violations = (action: string, resources: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (!Flag.OPENCODE_EXPERIMENTAL_CAPSULE_ADMISSION) return []
        // opencode routes every file-mutating write (write/edit/apply_patch) through
        // the "edit" permission action; scope governs only those.
        if (action !== "edit") return []
        const manifest = yield* CapsuleLoad.load()
        const scope = manifest?.spec.scope
        if (!scope || scope.length === 0) return []
        return resources.flatMap((resource): ReadonlyArray<Violation> => {
          const target = toProjectRelative(resource, location.directory, location.project.directory)
          // Unmappable (external / outside the project): governed by external-directory
          // permission, not scope. Never claim a violation we are unsure about.
          if (target === undefined || inScope(target, scope)) return []
          return [{ resource, reason: `outside capsule scope: ${target}` }]
        })
      }).pipe(Effect.provideService(FSUtil.Service, fs), Effect.provideService(Location.Service, location))
    return Service.of({ violations })
  }),
)

const slash = (path: string) => path.replaceAll("\\", "/")

function toProjectRelative(resource: string, locationDir: string, projectDir: string): string | undefined {
  const absolute = isAbsolute(resource) ? resource : resolve(locationDir, resource)
  const rel = slash(relative(projectDir, absolute))
  if (rel === "" || rel === "." || rel === ".." || rel.startsWith("../")) return undefined
  return rel
}

function inScope(target: string, scope: ReadonlyArray<string>) {
  return scope.some((entry) => {
    const glob = slash(entry).replace(/\/+$/, "")
    if (glob === "" || glob === ".") return true
    return (
      target === glob ||
      target.startsWith(`${glob}/`) ||
      minimatch(target, glob) ||
      minimatch(target, `${glob}/**`)
    )
  })
}
