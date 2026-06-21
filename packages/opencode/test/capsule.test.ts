import { describe, test, expect, afterEach } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as Capsule from "../src/session/capsule"

// The V1 capsule adapter (session/capsule.ts) is the live runtime path; these
// lock in the behavior proven by hand: context, reconcile, gates, admission, and
// the assembler slices (skill filtering + instructions composition).

const FLAGS = [
  "OPENCODE_EXPERIMENTAL_CAPSULE",
  "OPENCODE_EXPERIMENTAL_CAPSULE_RECONCILE",
  "OPENCODE_EXPERIMENTAL_CAPSULE_ADMISSION",
] as const

afterEach(() => {
  for (const flag of FLAGS) delete process.env[flag]
})

const on = (...flags: string[]) => {
  for (const flag of flags) process.env[flag] = "1"
}

const project = async (manifest: unknown, files: Record<string, string> = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capsule-test-"))
  await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
  await fs.writeFile(path.join(dir, ".opencode", "capsule.json"), JSON.stringify(manifest))
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), content)
  }
  return dir
}

describe("capsule adapter — context", () => {
  test("renders the manifest when enabled, undefined when off or absent", async () => {
    const dir = await project({ metadata: { name: "demo" }, spec: { goal: "do the thing" } })
    expect(await Capsule.context([dir])).toBeUndefined() // flag off
    on("OPENCODE_EXPERIMENTAL_CAPSULE")
    expect(await Capsule.context([dir])).toContain("do the thing")
    expect(await Capsule.context([os.tmpdir()])).toBeUndefined() // no manifest dir
  })
})

describe("capsule adapter — reconcile", () => {
  test("failing predicate re-actuates, met converges + persists status, cap escalates", async () => {
    on("OPENCODE_EXPERIMENTAL_CAPSULE_RECONCILE")
    const dir = await project(
      {
        metadata: { name: "r", generation: 3 },
        spec: { convergence: "acceptance_only", acceptance: [{ kind: "file_contains", path: "lib.txt", value: "DONE" }] },
      },
      { "lib.txt": "todo" },
    )
    expect(await Capsule.afterTurn([dir], dir, 0)).toContain("DONE") // unmet -> feedback
    expect(await Capsule.afterTurn([dir], dir, 3)).toBeUndefined() // cap -> escalate
    await fs.writeFile(path.join(dir, "lib.txt"), "DONE")
    expect(await Capsule.afterTurn([dir], dir, 0)).toBeUndefined() // met -> converged
    const status = JSON.parse(await fs.readFile(path.join(dir, ".opencode", "capsule-status.json"), "utf8"))
    expect(status.phase).toBe("Converged")
    expect(status.observedGeneration).toBe(3)
  })

  test("executable gate: failing command re-actuates, passing converges", async () => {
    on("OPENCODE_EXPERIMENTAL_CAPSULE_RECONCILE")
    const dir = await project(
      { metadata: { name: "g" }, spec: { scope: ["src/**"], gates: ["test -f src/done.txt"] } },
      { "src/.keep": "" },
    )
    expect(await Capsule.afterTurn([dir], dir, 0)).toContain("gate failed") // gate fails
    await fs.writeFile(path.join(dir, "src", "done.txt"), "x")
    expect(await Capsule.afterTurn([dir], dir, 0)).toBeUndefined() // gate passes -> converged
  })
})

describe("capsule adapter — admission", () => {
  test("flags out-of-scope edits, admits in-scope and non-edit", async () => {
    const dir = await project({ metadata: { name: "a" }, spec: { scope: ["src/**"] } })
    on("OPENCODE_EXPERIMENTAL_CAPSULE_ADMISSION")
    expect(await Capsule.scopeViolations([dir], dir, "edit", ["notes.md"])).toEqual(["notes.md"])
    expect(await Capsule.scopeViolations([dir], dir, "edit", ["src/ok.ts"])).toEqual([])
    expect(await Capsule.scopeViolations([dir], dir, "read", ["notes.md"])).toEqual([])
    delete process.env.OPENCODE_EXPERIMENTAL_CAPSULE_ADMISSION
    expect(await Capsule.scopeViolations([dir], dir, "edit", ["notes.md"])).toEqual([]) // off -> inert
  })
})

describe("capsule adapter — assembler", () => {
  test("skill filtering: include restricts, exclude removes, off is inert", async () => {
    const dir = await project({ metadata: { name: "s" }, spec: { compose: { skills: { include: ["a", "b"], exclude: ["b"] } } } })
    const items = [{ name: "a" }, { name: "b" }, { name: "c" }]
    expect((await Capsule.filterSkills([dir], items, (i) => i.name)).map((i) => i.name)).toEqual(["a", "b", "c"]) // off
    on("OPENCODE_EXPERIMENTAL_CAPSULE")
    expect((await Capsule.filterSkills([dir], items, (i) => i.name)).map((i) => i.name)).toEqual(["a"])
  })

  test("instructions composition: declared files rendered, off/absent undefined", async () => {
    const dir = await project(
      { metadata: { name: "i" }, spec: { compose: { instructions: ["DOC.md"] } } },
      { "DOC.md": "write tests first" },
    )
    expect(await Capsule.instructions([dir], dir)).toBeUndefined() // off
    on("OPENCODE_EXPERIMENTAL_CAPSULE")
    expect(await Capsule.instructions([dir], dir)).toContain("write tests first")
    const bare = await project({ metadata: { name: "i2" }, spec: {} })
    expect(await Capsule.instructions([bare], bare)).toBeUndefined() // no compose.instructions
  })
})
