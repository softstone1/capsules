import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { CapsuleAdmission } from "@opencode-ai/core/capsule/admission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const FLAG = "OPENCODE_EXPERIMENTAL_CAPSULE_ADMISSION"

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

describe("CapsuleAdmission", () => {
  it.live("denies out-of-scope writes, admits in-scope and unmappable ones", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = tmp.path
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
            await fs.writeFile(
              path.join(root, ".opencode", "capsule.json"),
              JSON.stringify({ metadata: { name: "demo" }, spec: { scope: ["packages/core/**"] } }),
            )
          })

          const admission = CapsuleAdmission.Service.pipe(
            Effect.provide(CapsuleAdmission.layer),
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
          const check = (action: string, resources: ReadonlyArray<string>) =>
            Effect.runPromise(admission.pipe(Effect.flatMap((a) => a.violations(action, resources))))

          // Flag off → no violations regardless of scope.
          yield* Effect.promise(() =>
            withFlag(false, async () => {
              expect(await check("edit", ["other/x.ts"])).toEqual([])
            }),
          )

          yield* Effect.promise(() =>
            withFlag(true, async () => {
              // Out of scope → violation.
              const denied = await check("edit", ["other/x.ts"])
              expect(denied).toHaveLength(1)
              expect(denied[0].reason).toContain("other/x.ts")

              // In scope → admitted.
              expect(await check("edit", ["packages/core/src/capsule/admission.ts"])).toEqual([])

              // Non-write action → not governed by scope.
              expect(await check("bash", ["other/x.ts"])).toEqual([])

              // Mix: only the out-of-scope path is flagged.
              const mixed = await check("edit", ["packages/core/a.ts", "elsewhere/b.ts"])
              expect(mixed.map((v) => v.resource)).toEqual(["elsewhere/b.ts"])
            }),
          )
        }),
      ),
    ),
  )
})
