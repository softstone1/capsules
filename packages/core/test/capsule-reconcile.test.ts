import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CapsuleManifest } from "@opencode-ai/core/capsule/manifest"
import { CapsulePredicate } from "@opencode-ai/core/capsule/predicate"
import { CapsuleReconcile } from "@opencode-ai/core/capsule/reconcile"

const decode = Schema.decodeUnknownSync(CapsuleManifest.Manifest)

// An Env backed by an in-memory file map — no filesystem, fully deterministic.
const envFrom = (files: Record<string, string>): CapsulePredicate.Env => ({
  resolve: (path) => path,
  read: (path) => Effect.succeed(files[path]),
})

const run = <A>(effect: Effect.Effect<A>) => Effect.runSync(effect)

describe("capsule predicate", () => {
  test("file_contains / file_exists / file_absent", () => {
    const env = envFrom({ "src/lib.rs": "fn rate_limit() {}" })
    expect(run(CapsulePredicate.evaluate({ kind: "file_exists", path: "src/lib.rs" }, env))).toBe(true)
    expect(run(CapsulePredicate.evaluate({ kind: "file_exists", path: "nope.rs" }, env))).toBe(false)
    expect(run(CapsulePredicate.evaluate({ kind: "file_absent", path: "nope.rs" }, env))).toBe(true)
    expect(run(CapsulePredicate.evaluate({ kind: "file_contains", path: "src/lib.rs", value: "rate_limit" }, env))).toBe(
      true,
    )
    expect(run(CapsulePredicate.evaluate({ kind: "file_contains", path: "src/lib.rs", value: "missing" }, env))).toBe(
      false,
    )
  })
})

describe("capsule reconcile", () => {
  const manifest = (acceptance: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) =>
    decode({
      metadata: { name: "demo", generation: 4 },
      spec: { goal: "g", acceptance, ...extra },
    } as unknown)

  test("converges when there is nothing machine-checkable (prose only)", () => {
    const decision = run(
      CapsuleReconcile.evaluate({ manifest: manifest(["ship it"]), env: envFrom({}), attempts: 0 }),
    )
    expect(decision._tag).toBe("Converged")
  })

  test("needs actuation while a typed predicate fails, converges once met", () => {
    const m = manifest([{ kind: "file_contains", path: "src/lib.rs", value: "rate_limit" }])
    const gap = run(CapsuleReconcile.evaluate({ manifest: m, env: envFrom({ "src/lib.rs": "" }), attempts: 0 }))
    expect(gap._tag).toBe("NeedsActuation")
    if (gap._tag === "NeedsActuation") expect(gap.gap[0]).toContain("rate_limit")

    const met = run(
      CapsuleReconcile.evaluate({ manifest: m, env: envFrom({ "src/lib.rs": "rate_limit" }), attempts: 0 }),
    )
    expect(met._tag).toBe("Converged")
  })

  test("escalates at the attempt cap (guarantees termination)", () => {
    const m = manifest([{ kind: "file_exists", path: "never.txt" }])
    const decision = run(
      CapsuleReconcile.evaluate({ manifest: m, env: envFrom({}), attempts: 3, maxAttempts: 3 }),
    )
    expect(decision._tag).toBe("Escalate")
  })

  test("artifacts_present strategy checks artifact files exist", () => {
    const m = decode({
      metadata: { name: "research" },
      spec: { convergence: "artifacts_present", artifacts: { findings: { path: "notes.md" } } },
    } as unknown)
    expect(run(CapsuleReconcile.evaluate({ manifest: m, env: envFrom({}), attempts: 0 }))._tag).toBe("NeedsActuation")
    expect(
      run(CapsuleReconcile.evaluate({ manifest: m, env: envFrom({ "notes.md": "x" }), attempts: 0 }))._tag,
    ).toBe("Converged")
  })

  test("manual_approval never auto-drives the loop", () => {
    const m = decode({
      metadata: { name: "release" },
      spec: { convergence: "manual_approval", acceptance: [{ kind: "file_exists", path: "never.txt" }] },
    } as unknown)
    expect(run(CapsuleReconcile.evaluate({ manifest: m, env: envFrom({}), attempts: 0 }))._tag).toBe("Converged")
  })

  test("status and feedback reflect the decision", () => {
    const m = manifest([{ kind: "file_exists", path: "x" }])
    const gap: CapsuleReconcile.Decision = { _tag: "NeedsActuation", gap: ["file exists: x"] }
    const status = CapsuleReconcile.status(m, gap)
    expect(status.phase).toBe("Reconciling")
    expect(status.observedGeneration).toBe(4)
    expect(CapsuleReconcile.feedback(m, gap)).toContain("file exists: x")
    expect(CapsuleReconcile.feedback(m, { _tag: "Converged" })).toBeUndefined()
  })
})
