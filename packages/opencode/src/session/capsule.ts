import { Effect, Option, Schema } from "effect"
import { parse } from "jsonc-parser"
import { minimatch } from "minimatch"
import { isAbsolute, join, relative } from "path"
import { CapsuleManifest } from "@opencode-ai/core/capsule/manifest"
import { CapsulePredicate } from "@opencode-ai/core/capsule/predicate"
import { CapsuleReconcile } from "@opencode-ai/core/capsule/reconcile"

/**
 * V1-runtime adapter for the capsule control plane.
 *
 * The capsule logic (manifest schema, render, predicates, reconcile decision)
 * lives in `@opencode-ai/core/capsule/*` and is pure. This module wires it into
 * the V1 session loop (`session/prompt.ts`) with plain Bun file IO, so it runs in
 * the actual TUI/CLI — independent of the in-progress V2 core runtime.
 *
 * Everything is gated and degrades to "no capsule" on any absence/error, so it is
 * inert unless a project authors `.opencode/capsule.json` and sets the flags.
 *
 * @module
 */

const decode = Schema.decodeUnknownOption(CapsuleManifest.Manifest, { errors: "all", onExcessProperty: "ignore" })

function flag(name: string) {
  const value = process.env[name]?.toLowerCase()
  return value === "1" || value === "true"
}

async function read(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text()
  } catch {
    return undefined
  }
}

/** Discover and parse the nearest `.opencode/capsule.{json,jsonc}` across the given dirs. */
export async function load(dirs: ReadonlyArray<string>): Promise<CapsuleManifest.Manifest | undefined> {
  const seen = new Set<string>()
  for (const dir of dirs) {
    for (const name of ["capsule.jsonc", "capsule.json"]) {
      const path = join(dir, ".opencode", name)
      if (seen.has(path)) continue
      seen.add(path)
      const text = await read(path)
      if (!text) continue
      const errors: import("jsonc-parser").ParseError[] = []
      const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) continue
      const manifest = Option.getOrUndefined(decode(parsed))
      if (manifest) return manifest
    }
  }
  return undefined
}

/** The rendered manifest block to append to the system prompt, or undefined when off/absent. */
export async function context(dirs: ReadonlyArray<string>): Promise<string | undefined> {
  if (!flag("OPENCODE_EXPERIMENTAL_CAPSULE")) return undefined
  const manifest = await load(dirs)
  if (!manifest) return undefined
  const rendered = CapsuleManifest.render(manifest)
  return rendered.length > 0 ? rendered : undefined
}

/**
 * Evaluate the capsule after a settled turn. Returns ephemeral gap feedback to
 * inject and re-actuate, or undefined to let the turn settle (converged, escalated
 * at the attempt cap, disabled, or no manifest). `root` anchors relative predicate
 * paths.
 */
export async function afterTurn(
  dirs: ReadonlyArray<string>,
  root: string,
  attempts: number,
): Promise<string | undefined> {
  if (!flag("OPENCODE_EXPERIMENTAL_CAPSULE_RECONCILE")) return undefined
  const manifest = await load(dirs)
  if (!manifest) return undefined
  const env: CapsulePredicate.Env = {
    resolve: (path) => (isAbsolute(path) ? path : join(root, path)),
    read: (path) => Effect.promise(() => read(path)),
  }
  const decision = await Effect.runPromise(CapsuleReconcile.evaluate({ manifest, env, attempts }))
  return CapsuleReconcile.feedback(manifest, decision)
}

/**
 * Scope admission: the file-write `patterns` that fall outside the capsule
 * `spec.scope`. Empty = admitted. Deny-only and conservative — off, no manifest,
 * no scope, a non-`edit` permission, or an unmappable path all admit.
 */
export async function scopeViolations(
  dirs: ReadonlyArray<string>,
  root: string,
  permission: string,
  patterns: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  if (!flag("OPENCODE_EXPERIMENTAL_CAPSULE_ADMISSION")) return []
  if (permission !== "edit") return []
  const manifest = await load(dirs)
  const scope = manifest?.spec.scope
  if (!scope || scope.length === 0) return []
  return patterns.filter((pattern) => {
    const rel = slash(isAbsolute(pattern) ? relative(root, pattern) : pattern)
    if (rel === "" || rel === "." || rel === ".." || rel.startsWith("../")) return false
    return !inScope(rel, scope)
  })
}

const slash = (path: string) => path.replaceAll("\\", "/")

function inScope(target: string, scope: ReadonlyArray<string>) {
  return scope.some((entry) => {
    const glob = slash(entry).replace(/\/+$/, "")
    if (glob === "" || glob === ".") return true
    return target === glob || target.startsWith(`${glob}/`) || minimatch(target, glob) || minimatch(target, `${glob}/**`)
  })
}
