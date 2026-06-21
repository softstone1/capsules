import { Effect, Option, Schema } from "effect"
import { parse } from "jsonc-parser"
import { minimatch } from "minimatch"
import { isAbsolute, join, relative } from "path"
import { CapsuleManifest } from "@opencode-ai/core/capsule/manifest"
import { CapsulePredicate } from "@opencode-ai/core/capsule/predicate"
import { CapsuleReconcile } from "@opencode-ai/core/capsule/reconcile"
import { Hash } from "@opencode-ai/core/util/hash"

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

/**
 * Filter a skill list to the manifest's `spec.compose.skills` selection — the
 * need-to-know lever, so a project carries only the skills it declares. Inert
 * (returns the list unchanged) when the flag is off, there's no manifest, or no
 * skills selection. Resolution: `include` (if any) restricts, then `exclude` removes.
 */
export async function filterSkills<T>(
  dirs: ReadonlyArray<string>,
  items: ReadonlyArray<T>,
  nameOf: (item: T) => string,
): Promise<ReadonlyArray<T>> {
  if (!flag("OPENCODE_EXPERIMENTAL_CAPSULE")) return items
  const manifest = await load(dirs)
  const selection = manifest?.spec.compose?.skills
  if (!selection) return items
  const include = selection.include
  const exclude = new Set(selection.exclude ?? [])
  const restricted = include && include.length > 0 ? items.filter((item) => include.includes(nameOf(item))) : items
  return exclude.size > 0 ? restricted.filter((item) => !exclude.has(nameOf(item))) : restricted
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
  // Change-aware skip: if we last converged at this exact fingerprint, nothing
  // convergence depends on has changed — re-evaluation is redundant.
  const fingerprint = await fingerprintOf(manifest, root)
  const previous = await readStatus(root)
  // Gates with no scope can't be fingerprinted cheaply, so don't skip those.
  const canSkip = CapsuleReconcile.gates(manifest).length === 0 || (manifest.spec.scope?.length ?? 0) > 0
  if (canSkip && previous?.phase === "Converged" && previous.lastConvergedHash === fingerprint) return undefined
  const env: CapsulePredicate.Env = {
    resolve: (path) => (isAbsolute(path) ? path : join(root, path)),
    read: (path) => Effect.promise(() => read(path)),
  }
  const decision = await Effect.runPromise(
    CapsuleReconcile.evaluate({ manifest, env, attempts, gates: gateRunner(root) }),
  )
  // Persist status only on converge (reconciler-owned, separate from the manifest).
  if (decision._tag === "Converged") {
    await writeStatus(root, { ...CapsuleReconcile.status(manifest, decision), lastConvergedHash: fingerprint })
    return undefined
  }
  return CapsuleReconcile.feedback(manifest, decision)
}

const decodeStatus = Schema.decodeUnknownOption(CapsuleManifest.Status, { errors: "all", onExcessProperty: "ignore" })

function statusPath(root: string) {
  return join(root, ".opencode", "capsule-status.json")
}

async function readStatus(root: string): Promise<CapsuleManifest.Status | undefined> {
  const text = await read(statusPath(root))
  if (!text) return undefined
  try {
    return Option.getOrUndefined(decodeStatus(JSON.parse(text) as unknown))
  } catch {
    return undefined
  }
}

async function writeStatus(root: string, status: CapsuleManifest.Status): Promise<void> {
  try {
    await Bun.write(statusPath(root), JSON.stringify(status, null, 2))
  } catch {
    // best-effort: a status write failure never breaks the turn
  }
}

/** sha256 over the manifest generation and every file convergence depends on. */
async function fingerprintOf(manifest: CapsuleManifest.Manifest, root: string): Promise<string> {
  const parts = await Promise.all(
    CapsuleReconcile.inputs(manifest).map(async (path) => {
      const content = await read(isAbsolute(path) ? path : join(root, path))
      return `${path}=${content === undefined ? "∅" : Hash.sha256(content)}`
    }),
  )
  // Gates verify the whole scope, so changes anywhere in scope must re-run them.
  const gateCommands = CapsuleReconcile.gates(manifest)
  if (gateCommands.length > 0) {
    parts.push("gates=" + Hash.sha256(JSON.stringify(gateCommands)))
    for (const glob of manifest.spec.scope ?? []) {
      for await (const file of new Bun.Glob(glob).scan({ cwd: root, onlyFiles: true })) {
        const content = await read(join(root, file))
        parts.push(`${file}=${content === undefined ? "∅" : Hash.sha256(content)}`)
      }
    }
  }
  return Hash.sha256(JSON.stringify([manifest.metadata.generation ?? 0, parts.sort()]))
}

const GATE_TIMEOUT_MS = 120_000

/** A gate runner that executes a command in the project root and reports exit status + output. */
function gateRunner(root: string): CapsuleReconcile.GateRunner {
  return { run: (command) => Effect.promise(() => runCommand(command, root)) }
}

async function runCommand(command: string, root: string): Promise<CapsuleReconcile.GateRunResult> {
  try {
    const argv = process.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", command]
    const proc = Bun.spawn(argv, { cwd: root, stdout: "pipe", stderr: "pipe", env: process.env })
    const stdout = new Response(proc.stdout).text()
    const stderr = new Response(proc.stderr).text()
    const killer = setTimeout(() => proc.kill(), GATE_TIMEOUT_MS)
    const exitCode = await proc.exited
    clearTimeout(killer)
    return { ok: exitCode === 0, output: (await stdout) + (await stderr) }
  } catch (error) {
    return { ok: false, output: String(error) }
  }
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
