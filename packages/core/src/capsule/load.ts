export * as CapsuleLoad from "./load"

import { Array, Effect, Option, Schema } from "effect"
import { type ParseError, parse } from "jsonc-parser"
import { join } from "path"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { CapsuleManifest } from "./manifest"

/**
 * Discovers and parses the project Capsule Manifest, shared by the System Context
 * source and the reconciler so both observe the same authored truth.
 *
 * Returns `undefined` on absence / parse failure / decode failure — never throws,
 * so callers degrade to "no capsule" rather than failing a turn.
 *
 * @module
 */

const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decode = Schema.decodeUnknownOption(CapsuleManifest.Manifest, decodeOptions)

export const load = Effect.fn("CapsuleLoad.load")(function* () {
  const fs = yield* FSUtil.Service
  const location = yield* Location.Service
  // Most specific wins: a manifest beside the opened directory overrides one at
  // the project root.
  const candidates = Array.dedupe(
    [location.directory, location.project.directory].flatMap((directory) => [
      join(directory, ".opencode", "capsule.jsonc"),
      join(directory, ".opencode", "capsule.json"),
    ]),
  )
  for (const path of candidates) {
    const text = yield* fs.readFileStringSafe(path).pipe(Effect.orElseSucceed(() => undefined))
    if (!text) continue
    const errors: ParseError[] = []
    const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
    if (errors.length) continue
    const manifest = Option.getOrUndefined(decode(parsed))
    if (manifest) return manifest
  }
  return undefined
})
