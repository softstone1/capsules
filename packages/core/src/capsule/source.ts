export * as CapsuleSource from "./source"

import { Effect, Layer, Schema } from "effect"
import { Flag } from "../flag/flag"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { SystemContext } from "../system-context/index"
import { SystemContextRegistry } from "../system-context/registry"
import { CapsuleLoad } from "./load"
import { CapsuleManifest } from "./manifest"

/**
 * Contributes the project Capsule Manifest as a System Context source.
 *
 * Additive and off by default: gated behind `OPENCODE_EXPERIMENTAL_CAPSULE`, and
 * even when enabled it contributes `SystemContext.empty` unless a parseable
 * `.opencode/capsule.json` (or `.jsonc`) with renderable governing fields exists.
 * Any error or absence degrades to empty — it can never block context
 * initialization, exactly like ambient `AGENTS.md` instructions.
 *
 * @module
 */

const key = SystemContext.Key.make("core/capsule")

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* SystemContextRegistry.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service

    const observe = Effect.fn("CapsuleSource.observe")(function* () {
      if (!Flag.OPENCODE_EXPERIMENTAL_CAPSULE) return SystemContext.empty
      const manifest = yield* CapsuleLoad.load()
      if (!manifest || CapsuleManifest.render(manifest).length === 0) return SystemContext.empty
      return source(manifest)
    })

    yield* registry.register({
      key,
      load: observe().pipe(
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Location.Service, location),
        Effect.catch(() => Effect.succeed(SystemContext.empty)),
        Effect.catchDefect(() => Effect.succeed(SystemContext.empty)),
      ),
    })
  }),
)

function source(manifest: CapsuleManifest.Manifest) {
  return SystemContext.make({
    key,
    codec: Schema.toCodecJson(CapsuleManifest.Manifest),
    load: Effect.succeed(manifest),
    baseline: CapsuleManifest.render,
    update: (_previous, current) => `The project capsule manifest has changed.\n\n${CapsuleManifest.render(current)}`,
    removed: () => "The project capsule manifest no longer applies.",
  })
}
