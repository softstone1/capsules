import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { CapsuleReconciler } from "@opencode-ai/core/capsule/reconciler"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const FLAG = "OPENCODE_EXPERIMENTAL_CAPSULE_RECONCILE"

const withFlag = async (value: boolean, fn: () => Promise<void>) => {
  const prev = process.env[FLAG]
  if (value) process.env[FLAG] = "1"
  else delete process.env[FLAG]
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env[FLAG]
    else process.env[FLAG] = prev
  }
}

describe("CapsuleReconciler", () => {
  it.live("re-actuates on a failing predicate, converges when met, escalates at the cap", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = tmp.path
          const target = path.join(root, "src", "lib.txt")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
            await fs.mkdir(path.join(root, "src"), { recursive: true })
            await fs.writeFile(
              path.join(root, ".opencode", "capsule.json"),
              JSON.stringify({
                metadata: { name: "demo", generation: 2 },
                spec: {
                  convergence: "acceptance_only",
                  acceptance: [{ kind: "file_contains", path: "src/lib.txt", value: "DONE" }],
                },
              }),
            )
            await fs.writeFile(target, "todo")
          })

          const reconciler = CapsuleReconciler.Service.pipe(
            Effect.provide(CapsuleReconciler.layer),
            Effect.provide(FSUtil.defaultLayer),
            Effect.provide(
              Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location({ directory: AbsolutePath.make(root) }, { projectDirectory: AbsolutePath.make(root) }),
                ),
              ),
            ),
          )

          // Flag off → inert no matter the workspace state.
          yield* Effect.promise(() =>
            withFlag(false, async () => {
              const off = await Effect.runPromise(reconciler.pipe(Effect.flatMap((r) => r.afterTurn(0))))
              expect(off).toBeUndefined()
            }),
          )

          // Flag on, predicate failing → ephemeral gap feedback.
          yield* Effect.promise(() =>
            withFlag(true, async () => {
              const gap = await Effect.runPromise(reconciler.pipe(Effect.flatMap((r) => r.afterTurn(0))))
              expect(gap).toBeDefined()
              expect(gap).toContain("DONE")

              // At the attempt cap → escalate (undefined), guaranteeing termination.
              const capped = await Effect.runPromise(reconciler.pipe(Effect.flatMap((r) => r.afterTurn(3))))
              expect(capped).toBeUndefined()

              // Satisfy the predicate → converged (undefined) and status persisted.
              await fs.writeFile(target, "DONE")
              const converged = await Effect.runPromise(reconciler.pipe(Effect.flatMap((r) => r.afterTurn(0))))
              expect(converged).toBeUndefined()
              const status = JSON.parse(await fs.readFile(path.join(root, ".opencode", "capsule-status.json"), "utf8"))
              expect(status.phase).toBe("Converged")
              expect(status.observedGeneration).toBe(2)
            }),
          )
        }),
      ),
    ),
  )

  it.live("skips re-evaluation when nothing convergence depends on changed", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = tmp.path
          const target = path.join(root, "lib.txt")
          const statusPath = path.join(root, ".opencode", "capsule-status.json")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
            await fs.writeFile(
              path.join(root, ".opencode", "capsule.json"),
              JSON.stringify({
                metadata: { name: "demo" },
                spec: {
                  convergence: "acceptance_only",
                  acceptance: [{ kind: "file_contains", path: "lib.txt", value: "DONE" }],
                },
              }),
            )
            await fs.writeFile(target, "DONE")
          })

          const reconciler = CapsuleReconciler.Service.pipe(
            Effect.provide(CapsuleReconciler.layer),
            Effect.provide(FSUtil.defaultLayer),
            Effect.provide(
              Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location({ directory: AbsolutePath.make(root) }, { projectDirectory: AbsolutePath.make(root) }),
                ),
              ),
            ),
          )
          const afterTurn = (attempts: number) =>
            Effect.runPromise(reconciler.pipe(Effect.flatMap((r) => r.afterTurn(attempts))))

          yield* Effect.promise(() =>
            withFlag(true, async () => {
              // First pass converges and persists a fingerprint.
              expect(await afterTurn(0)).toBeUndefined()
              const persisted = JSON.parse(await fs.readFile(statusPath, "utf8"))
              expect(persisted.lastConvergedHash).toBeTruthy()

              // Mark the status; a change-aware skip must NOT rewrite it.
              await fs.writeFile(statusPath, JSON.stringify({ ...persisted, _sentinel: "keep" }))
              expect(await afterTurn(0)).toBeUndefined()
              expect(JSON.parse(await fs.readFile(statusPath, "utf8"))._sentinel).toBe("keep")

              // Changing a convergence input changes the fingerprint → re-evaluate.
              await fs.writeFile(target, "todo")
              expect(await afterTurn(0)).toBeDefined()
            }),
          )
        }),
      ),
    ),
  )
})
