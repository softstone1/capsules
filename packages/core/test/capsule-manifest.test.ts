import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CapsuleManifest } from "@opencode-ai/core/capsule/manifest"

const decode = Schema.decodeUnknownSync(CapsuleManifest.Manifest)

describe("capsule manifest", () => {
  test("renders only authored governing fields, artifacts as pointers", () => {
    const manifest = decode({
      apiVersion: "opencode.dev/v0",
      kind: "Capsule",
      metadata: { name: "demo", role: "feature", generation: 3 },
      spec: {
        goal: "ship the manifest",
        scope: ["packages/core/src/capsule/"],
        invariants: ["never inline artifact contents"],
        acceptance: ["typecheck passes"],
        artifacts: { design: { path: "specs/v2/capsule-manifest.md", description: "the plan" } },
      },
    })
    const text = CapsuleManifest.render(manifest)
    expect(text).toContain("# Project Capsule: demo")
    expect(text).toContain("Goal: ship the manifest")
    expect(text).toContain("Scope")
    expect(text).toContain("packages/core/src/capsule/")
    expect(text).toContain("Invariants")
    expect(text).toContain("Acceptance")
    // artifacts are referenced by path, never inlined
    expect(text).toContain("specs/v2/capsule-manifest.md")
    expect(text).toContain("the plan")
  })

  test("contributes nothing when there are no governing fields", () => {
    const manifest = decode({ metadata: { name: "empty" }, spec: {} })
    expect(CapsuleManifest.render(manifest)).toBe("")
  })

  test("ignores unknown/future fields so the schema can widen without breaking", () => {
    const manifest = decode({
      metadata: { name: "fwd", futureMetaField: true },
      spec: { goal: "x", compose: { skills: { manifest: "rust" } }, futureSpecField: 42 },
      status: { phase: "Reconciling", observedGeneration: 1 },
    } as unknown)
    expect(CapsuleManifest.render(manifest)).toContain("Goal: x")
  })
})
