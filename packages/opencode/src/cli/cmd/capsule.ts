import { Effect } from "effect"
import { join } from "path"
import { CapsuleManifest } from "@opencode-ai/core/capsule/manifest"
import * as Capsule from "@/session/capsule"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"

// The launcher runs with bun --cwd packages/opencode, so process.cwd() is the
// package, not the user's shell dir. $PWD preserves the invocation directory.
const projectDir = () => process.env.PWD ?? process.cwd()

/**
 * Predefined capsule templates (best practices as code). `init` scaffolds one into
 * `.opencode/capsule.json`; edit it and enable with the OPENCODE_EXPERIMENTAL_CAPSULE*
 * flags. New templates are just entries here.
 */
const TEMPLATES = {
  // Safe default: context only. No scope/acceptance, so admission + reconcile stay
  // inert until you opt in by adding them.
  general: {
    apiVersion: "opencode.dev/v0",
    kind: "Capsule",
    metadata: { name: "my-project", role: "application", generation: 1 },
    spec: {
      goal: "Describe what this project is and the current objective.",
      invariants: [
        "Match the surrounding code style and conventions.",
        "Verify changes (typecheck / tests) before claiming a task is done.",
      ],
      artifacts: {
        conventions: { path: "AGENTS.md", description: "project conventions, read on demand" },
      },
    },
  },
  // Drives a feature to completion: fenced to scope, converges on typed acceptance.
  feature: {
    apiVersion: "opencode.dev/v0",
    kind: "Capsule",
    metadata: { name: "my-project:feature", role: "feature", generation: 1 },
    spec: {
      goal: "Describe the feature to build.",
      scope: ["src/**", "test/**"],
      acceptance: [
        { kind: "file_exists", path: "REPLACE/with/a/file/the/feature/must/create.ts" },
        { kind: "file_contains", path: "REPLACE/with/a/file.ts", value: "REPLACE_with_required_text" },
      ],
      convergence: "acceptance_only",
    },
  },
} as const

const InitCommand = effectCmd({
  command: "init [template]",
  describe: "scaffold .opencode/capsule.json from a template",
  builder: (yargs) =>
    yargs.positional("template", {
      type: "string",
      choices: Object.keys(TEMPLATES) as Array<keyof typeof TEMPLATES>,
      default: "general" as keyof typeof TEMPLATES,
      describe: "template to scaffold",
    }),
  handler: Effect.fn("Cli.capsule.init")(function* (args) {
    const path = join(projectDir(), ".opencode", "capsule.json")
    if (yield* Effect.promise(() => Bun.file(path).exists())) {
      UI.println(".opencode/capsule.json already exists — not overwriting.")
      return
    }
    const template = TEMPLATES[args.template as keyof typeof TEMPLATES]
    yield* Effect.promise(() => Bun.write(path, JSON.stringify(template, null, 2) + "\n"))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Created .opencode/capsule.json" + UI.Style.TEXT_NORMAL + ` (${args.template})`)
    UI.println("Edit goal / scope / acceptance, then enable:")
    UI.println("  OPENCODE_EXPERIMENTAL_CAPSULE=1 (context)")
    UI.println("  OPENCODE_EXPERIMENTAL_CAPSULE_RECONCILE=1 (reconcile loop)")
    UI.println("  OPENCODE_EXPERIMENTAL_CAPSULE_ADMISSION=1 (scope admission)")
  }),
})

const StatusCommand = effectCmd({
  command: "status",
  describe: "show the project capsule and its reconcile status",
  builder: (yargs) => yargs,
  handler: Effect.fn("Cli.capsule.status")(function* () {
    const dir = projectDir()
    const manifest = yield* Effect.promise(() => Capsule.load([dir]))
    if (!manifest) {
      UI.println("No .opencode/capsule.json found in " + dir)
      return
    }
    const rendered = CapsuleManifest.render(manifest)
    UI.println(rendered.length > 0 ? rendered : "# Project Capsule: " + manifest.metadata.name)

    const statusText = yield* Effect.promise(() =>
      Bun.file(join(dir, ".opencode", "capsule-status.json"))
        .text()
        .catch(() => undefined),
    )
    UI.println("")
    if (!statusText) {
      UI.println("Status: not yet reconciled (no .opencode/capsule-status.json).")
      return
    }
    const status = JSON.parse(statusText) as CapsuleManifest.Status
    UI.println("Status: " + (status.phase ?? "unknown"))
    for (const condition of status.conditions ?? [])
      UI.println(`  - ${condition.type}=${condition.status}` + (condition.reason ? ` (${condition.reason})` : ""))
  }),
})

export const CapsuleCommand = effectCmd({
  command: "capsule",
  describe: "manage the project capsule (manifest + reconcile status)",
  builder: (yargs) => yargs.command(InitCommand).command(StatusCommand).demandCommand(),
  handler: () => Effect.void,
})
