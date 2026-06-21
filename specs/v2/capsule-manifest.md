# Capsule Manifest — Migration & Implementation Plan

**Status:** Increments 1, 2a, 2b, 3, 4 shipped (manifest + System Context source +
deterministic reconcile plane + flag-gated runner re-actuation + pre-apply scope
admission + change-aware skip). Increment 5 planned.
**Owner:** capsule
**Last updated:** 2026-06-21

A staged, strictly-additive plan to make a typed **Capsule Manifest** the single
source of truth for what governs a project, driven by a Kubernetes-style
**reconcile loop**. Adapted from Keel's intent-capsule control plane onto
opencode's existing seams. Every increment is opt-in and behavior-preserving when
disabled.

---

## 0. Runtime note — V1 is what actually runs (read this first)

Increments 1–4 below are built against the **V2 core** (`packages/core`), the
in-progress session rewrite. **The shipped TUI/CLI does not run V2 yet** — it runs
the **V1 runtime** (`packages/opencode/src/session/prompt.ts`, `SessionPrompt`).
`@opencode-ai/core` is only a *devDependency* of `packages/opencode`. So the V2
work is correct and unit-tested but **dormant** until V2 becomes the runtime.

To make capsules actually run today, the integration is **also wired into V1**,
reusing the pure core modules (`@opencode-ai/core/capsule/{manifest,predicate,reconcile,kinds}`):

- `packages/opencode/src/session/capsule.ts` — a small adapter (plain Bun file IO):
  `context(dirs)` renders the manifest for the system prompt; `afterTurn(dirs, root,
  attempts)` returns ephemeral gap feedback or undefined.
- `packages/opencode/src/session/prompt.ts` — appends `context` to the assembled
  `system`; at the loop's settle point (the `break`) calls `afterTurn` and, on a
  gap, injects an ephemeral `turnFeedback` user message and re-actuates instead of
  breaking, capped by `reconcileAttempts`.

**Verified live** (`capsules run` + DeepSeek V4 Pro): asked to create only
`src/greet.ts`, the model declared done, the reconciler re-actuated 3×, and the
model created `test/greet.test.ts` despite the prompt forbidding it — then converged.

The V1 adapter is at parity with the V2 design: context (1), reconcile re-actuation
(2b), scope admission (3), change-aware skip + status persistence to
`.opencode/capsule-status.json` (4). When V2 becomes the runtime, the V1 integration
is removed and the `packages/core` path takes over unchanged.

---

## 1. Why, and what we are NOT doing

opencode is already token-lean (Keel's own analysis measured opencode at ~1.8K
vs ~112K input tokens/request). **This plan is not a token-efficiency play** and
must not import Keel's bloat (a 21–28KB constitution prompt, 70–90 tools, or
reconciler feedback persisted into durable conversation history). Those are
explicitly out of scope.

What we *are* adopting is Keel's **shape**:

- **The manifest sits in the middle.** Today many inputs (`AGENTS.md`, agent
  config, skills, permissions) are assembled straight into the model prompt. The
  endgame inserts a manifest between them and the model: inputs are assembled
  *into the manifest first → reconciled → the model picks up from the manifest +
  referenced artifacts*. The manifest **indexes**; artifacts (prose, design docs,
  memory) are **referenced by hash and read on demand**, never inlined.
- **Determinism / governance.** A reconcile loop that diffs observed vs desired
  state and drives the model to convergence — deterministic termination,
  unskippable verification, scope fencing — independent of token count. This is
  the real value: task reliability, not cheaper requests.

We borrow Kubernetes' **shape, not its cluster** (no namespaces, no watch/
informers, no optimistic concurrency — single writer, level-triggered on turn
boundaries).

---

## 2. The non-negotiable invariants of this migration

1. **Additive only.** No existing context source, prompt, or tool changes
   behavior. New code contributes `SystemContext.empty` (i.e. nothing) until a
   project opts in by authoring a manifest *and* setting the flag.
2. **Off by default, flag-gated.** Each increment lands behind its own dedicated
   flag (`OPENCODE_EXPERIMENTAL_CAPSULE` for the source; further flags per
   increment). The broad `OPENCODE_EXPERIMENTAL` switch must **not** silently
   enable capsule behavior.
3. **Never block.** A capsule source must never return
   `SystemContext.unavailable` in a way that blocks context-epoch
   initialization. Absence, parse failure, and errors all degrade to empty —
   exactly how ambient `AGENTS.md` instructions behave.
4. **Single writer.** `spec` is authored (human / template / compiler). `status`
   is written **only** by the reconciler. The turn loop is read-only on
   spec/status (it actuates workspace files).
5. **Persist only on converge.** The graph/status is an optimization for
   change-aware verification, not a per-turn audit log.
6. **One increment at a time.** Increments that change the turn loop (2–5) land
   individually, each with its own tests, never bundled.

---

## 3. Mapping to opencode's existing architecture

opencode already solves the "don't replay history / need-to-know context"
problem that Keel's spec/status split solves — it just aims at *context*, not
*verification*. We reuse those seams rather than reinventing them.

| Keel concept | opencode seam we build on | File |
|---|---|---|
| spec/status, anti-replay | **System Context / Context Epoch** | `packages/core/src/system-context/`, `session/context-epoch.ts`, `CONTEXT.md` |
| Manifest as a context source | System Context **registry** + producer | `system-context/registry.ts`, `instruction-context.ts` (the template) |
| Admission control | permission + policy | `permission/`, `policy.ts` |
| Change detection (hashes) | git snapshots | `snapshot.ts` |
| Turn / step loop | session **runner** | `session/runner/llm.ts`, `runner/max-steps.ts` |
| Verification gates / acceptance / convergence | — (genuinely new) | new in increment 2 |

Note: opencode's existing `reconcile`/`admission` symbols refer to *context-source*
admission (the System Context engine), **not** Keel's *mutation* admission. The
vocabulary overlaps; the capability (verification-gate reconcile loop) does not
exist yet.

---

## 4. The Capsule Manifest (v0 envelope)

Kubernetes-shaped, split into authored `spec` and reconciler-owned `status`.
Defined in `packages/core/src/capsule/manifest.ts` as an Effect `Schema`.

```jsonc
{
  "apiVersion": "opencode.dev/v0",
  "kind": "Capsule",                    // Capsule | Task (more kinds become data later)
  "metadata": {
    "name": "opencode:capsule-manifest",
    "role": "feature",                  // application | feature | task | general
    "parent": "opencode",               // DAG edge (null/absent for root)
    "generation": 1,                    // ++ on every spec edit (cheap drift signal)
    "labels": { "domain": "typescript" }
  },
  "spec": {                             // ── AUTHORED desired state ──
    "goal": "make the manifest the single source of truth",
    "scope": ["packages/core/src/capsule/"],
    "invariants": ["never inline artifact contents into context"],
    "gates": ["bun turbo typecheck --filter=@opencode-ai/core"],
    "acceptance": ["specs/v2/capsule-manifest.md documents all five increments"],
    "artifacts": {
      "design": { "path": "specs/v2/capsule-manifest.md", "description": "this plan" }
    },
    "convergence": "gates_and_acceptance"
  },
  "status": { }                          // ── RECONCILER-OWNED. Never authored. ──
}
```

**v0 rendering:** only the authored governing fields render into context — goal,
scope, invariants, acceptance — plus artifacts as **pointers** (path +
description, never contents). `gates` / `convergence` / `status` are parsed and
shape-validated now but not yet enforced (no reconciler in v0). `invariants` /
`gates` / `acceptance` are authored as plain strings in v0 so they can widen to
typed records later without a breaking change (excess/unknown fields are ignored
on decode).

**Discovery:** `.opencode/capsule.json` or `.opencode/capsule.jsonc`, checked at
the opened directory then the project root (most specific wins). Mirrors how
`.opencode/` config is already discovered (`config.ts`).

---

## 5. Increment roadmap

Each row is independently shippable and reversible. ✅ = done.

| # | Increment | Adds | Flag | Turn-loop change? | Status |
|---|---|---|---|---|---|
| 1 | **Manifest + System Context source** | schema; loads `.opencode/capsule.json`; renders compact baseline; empty when absent | `OPENCODE_EXPERIMENTAL_CAPSULE` | No | ✅ |
| 2a | **Reconcile plane** (deterministic) | kind registry + convergence strategies; typed acceptance predicates; pure `decide` + effectful `evaluate`; status + feedback builders; attempt cap | — (pure; no runtime caller yet) | No | ✅ |
| 2b | **Runner wiring** (re-actuation) | `CapsuleReconciler` service (noop/real); post-turn hook evaluates the capsule, injects **ephemeral** gap feedback, re-actuates under the cap; writes `status` on converge | `OPENCODE_EXPERIMENTAL_CAPSULE_RECONCILE` | Yes (additive, no-op off) | ✅ |
| 3 | **Scope admission** | `CapsuleAdmission` service consulted in the permission deny pre-check; out-of-scope `edit` writes rejected **pre-apply** | `OPENCODE_EXPERIMENTAL_CAPSULE_ADMISSION` | No (permission layer) | ✅ |
| 4 | **Change-aware skip** | fingerprint (generation + convergence-input hashes); skip re-evaluation when fresh | (under reconcile flag) | No | ✅ |
| 5a | **CLI surface + templates** | `capsule init [general\|feature]` scaffolds a manifest; `capsule status` shows manifest + reconcile status | — | No | ✅ |
| 5b | **Capsule graph** | DAG of nodes (application → feature); per-node scope; staleness/drift | `OPENCODE_EXPERIMENTAL_CAPSULE_GRAPH` | No | Planned |

### Increment 1 — shipped

Files added/changed (all additive):

- `packages/core/src/capsule/manifest.ts` — `Manifest` schema (`spec`/`status`
  envelope), `ConvergenceStrategy`, `render()`.
- `packages/core/src/capsule/source.ts` — `CapsuleSource.layer`: a System Context
  registry producer, flag-gated, empty when absent.
- `packages/core/src/flag/flag.ts` — `OPENCODE_EXPERIMENTAL_CAPSULE` (dedicated
  getter, not folded into `OPENCODE_EXPERIMENTAL`).
- `packages/core/src/system-context/builtins.ts` — merge `CapsuleSource.layer`
  into the location builtins layer (the one wiring touch-point).

Verified: `@opencode-ai/core`, `opencode`, `@opencode-ai/server`, `@opencode-ai/tui`
typecheck clean. With the flag off (default) or no manifest present, the source
contributes nothing → zero behavior change.

### Increment 2a — reconcile plane (shipped)

The deterministic core of the loop, built and unit-tested in isolation with **zero
changes to the runner** (the most sensitive, mid-rewrite file). Pure / effectful-
with-injected-reader, so it tests without a filesystem or model.

- `packages/core/src/capsule/kinds.ts` — kind registry; `convergence(manifest)`
  resolves the strategy (explicit `spec.convergence`, else the kind default).
  Kinds are data, the `ConvergenceStrategy` set is code.
- `packages/core/src/capsule/manifest.ts` — `acceptance` widened to typed
  `Predicate` items (`file_exists` / `file_absent` / `file_contains`) **or** prose
  strings (advisory). Prose-only manifests keep working. Helpers
  `acceptancePredicates`, `describePredicate`.
- `packages/core/src/capsule/predicate.ts` — `evaluate(predicate, env)` over an
  injected `Env { resolve, read }` (FS reads only; deterministic).
- `packages/core/src/capsule/reconcile.ts` — pure `decide(...)` and effectful
  `evaluate(...)` returning `Converged | NeedsActuation(gap) | Escalate`;
  per-strategy `checkables`; `status(...)` and `feedback(...)` builders;
  `DEFAULT_MAX_ATTEMPTS` cap.

Convergence semantics today: `acceptance_only` converges on typed acceptance
predicates; `gates_and_acceptance` ALSO runs `spec.gates` as shell commands (each
must exit 0) — so a Capsule converges when its acceptance predicates pass *and* its
gates are green; `artifacts_present` converges when referenced artifacts exist;
`manual_approval` never auto-drives the loop. **A manifest with no predicates and no
gates converges immediately** — the loop is a no-op until you author machine-checkable
criteria (opt-in twice: flag + predicates/gates).

### Executable gates (shipped)

`gates_and_acceptance` runs `spec.gates` as commands. The decision logic
(`reconcile.ts`) takes an injected `GateRunner` so it stays pure/testable; the V1
adapter provides a real runner (`Bun.spawn` `sh -c` / `cmd /c`, 120s timeout,
captured output). A non-zero exit is a gap (`gate failed: \`<cmd>\` — <output tail>`)
that drives re-actuation. Gates are advisory (not executed) when no runner is wired —
e.g. the dormant V2 path. Change-aware skip stays correct: when gates apply, the
fingerprint also hashes the `scope` files (via `Bun.Glob`), and a manifest with gates
but no scope disables the skip (always re-verifies). Verified live: gate
`test -f src/done.txt` fails → feedback, file created → converged.

### Increment 2b — runner wiring (shipped)

The 2a plane is wired into the turn loop as a flag-gated, capped re-actuation.

- `packages/core/src/capsule/load.ts` — shared manifest discovery+parse, used by
  both the System Context source and the reconciler (source.ts refactored onto it).
- `packages/core/src/capsule/reconciler.ts` — `CapsuleReconciler` service:
  - `noop` (no dependencies) — never re-actuates; the default in tests and anywhere
    the feature is unwired, so the runner's behavior is unchanged.
  - `layer` (requires `FSUtil` + `Location`) — `afterTurn(attempts)` loads the
    manifest, evaluates via the 2a plane, returns ephemeral gap feedback while
    unmet/under cap, undefined once converged/escalated/disabled/absent. Writes
    `status` to `.opencode/capsule-status.json` (single writer, separate from the
    authored manifest, best-effort) **only on convergence**.
- `packages/core/src/session/runner/llm.ts` — threads an optional `feedback?: string`
  through `runTurn` → `runTurnAttempt` (and the overflow/rebuild wrappers), appended
  as `Message.user(feedback)` to the provider request the same way `MAX_STEPS_PROMPT`
  is — **never persisted to durable history**. The `run` loop calls
  `capsule.afterTurn(reconcileAttempts)` after an activity settles; a returned string
  re-actuates and increments the counter. Off (default, via the `noop` layer or the
  flag) → returns undefined → loop byte-identical to before.
- `packages/core/src/location-layer.ts` — provides the real `CapsuleReconciler.layer`
  to the runner; the two runner test harnesses provide `CapsuleReconciler.noop`.

**Termination:** the reconcile attempt counter feeds `decide`, which escalates at
`DEFAULT_MAX_ATTEMPTS` (= 3) → undefined → loop exits. Proven by
`test/capsule-reconciler.test.ts`.

Verified: core + opencode + server + tui typecheck clean (consumers force-rechecked
against new core); 142 tests pass including the full session-runner suite (off-path
unchanged) and a reconciler integration test (flag-off inert → failing predicate
feedback → cap escalate → converged + status persisted).

> Since shipped: executable gates (this increment), admission (3), and the
> `capsule` CLI (5a). Still open: in-TUI surfacing of escalation (a denied write /
> escalation only logs today — no in-session indicator), typed deny-invariants, and
> the capsule graph (5b).

### Increment 3 — scope admission (shipped)

Out-of-scope file writes are rejected **pre-apply** via the permission layer.

- `packages/core/src/capsule/admission.ts` — `CapsuleAdmission` service:
  - `noop` (no deps) — never flags a violation; the default in tests / when unwired.
  - `layer` (requires `FSUtil` + `Location`) — `violations(action, resources)`
    returns the resources of an `edit` action that fall outside `spec.scope`.
    **Deny-only and conservative:** flag off, no manifest, no `scope`, a non-`edit`
    action, or a path it cannot map into the project all yield *no* violation, so
    admission can never block legitimate work it is unsure about. Scope entries match
    as exact paths, directory prefixes, or minimatch globs (and `glob/**`).
- `packages/core/src/permission.ts` — `evaluateInput` consults
  `admission.violations` right after the existing `denied()` hard-deny pre-check.
  It is **additive**: it can only *add* a deny (effect `"deny"`), never relax a rule,
  and a saved "always allow" cannot override it. All file writes (write / edit /
  apply_patch) route through the `edit` action, so this is the single chokepoint.
- `packages/core/src/location-layer.ts` — provides the real `CapsuleAdmission.layer`
  to `PermissionV2.locationLayer`. Only `permission.test.ts` builds the real
  permission layer (all tool tests mock it), so it provides `CapsuleAdmission.noop`;
  blast radius is two files.

Verified: core + opencode + server + tui typecheck clean (consumers force-rechecked);
`capsule-admission.test.ts` (scope matching, flag/action gating, conservative
default-allow) and the full `permission.test.ts` pass. The two failing
`tool-write`/`tool-edit` "locked docstring" source-drift tests are **pre-existing**
(confirmed by re-running on a clean tree with changes stashed) and untouched.

> Scope only this increment. **Typed deny-invariants** (e.g. "never write path X")
> and surfacing the scope reason to the model (today a denied write reports the
> tool's generic "Unable to write" failure) are follow-ups. The admission reloads
> the manifest per `edit` evaluation when enabled; an mtime cache is a later tweak.

### Increment 4 — change-aware skip (shipped)

The reconciler skips re-evaluation when nothing convergence depends on has changed
since the last convergence. Self-contained in the capsule module (no new flag, no
wiring change).

- `packages/core/src/capsule/reconcile.ts` — `inputs(manifest)` returns the
  distinct files convergence depends on (every checkable predicate's path).
  Invariant: it must cover every file the predicates read.
- `packages/core/src/capsule/reconciler.ts` — `afterTurn` computes a `fingerprint`
  = `sha256(generation + sorted[ path = sha256(content) | "∅" ])` over `inputs`
  (reusing `util/hash.ts`). It reads the persisted status; if the last decision was
  `Converged` at this exact `fingerprint`, it returns immediately — no predicate
  evaluation, no status rewrite. Otherwise it evaluates as before and persists the
  fingerprint as `status.lastConvergedHash` on the next convergence.

The fingerprint folds `metadata.generation` *and* the input-set, so an authored
spec edit (even without a generation bump) or any workspace change to a relevant
file changes the fingerprint and forces re-evaluation — the skip can never hide a
regression. With executable gates shipped, the skip is now a real wall-clock win —
it avoids re-running gate commands (tests/typecheck) when nothing in scope changed —
and the fingerprint is the same staleness signal increment 5's graph nodes will use.

Verified: core + consumers typecheck clean; `capsule-reconciler.test.ts` proves
the skip deterministically (a sentinel written into the status file survives an
unchanged turn — no rewrite — while changing a convergence input re-actuates).

### Increment 5 — capsule graph

One project = one DAG of capsule nodes (root application → feature nodes). A
feature **subsets** parent scope, **appends** invariants/gates, **overrides**
goal/convergence. Per-node manifest cache; staleness/drift detection; a
`/capsule [status|graph|stale]` surface. Highest effort, most speculative — only
after 1–4 prove out.

---

## 6. The endgame (north star, not yet built)

Everything flows through the manifest:

- **The assembler.** A compile step takes existing sources (`AGENTS.md`, agent
  config, skills selection, permissions) and *assembles them into the manifest*
  (`spec.compose` = constitution / instructions / skills / artifacts pointers),
  so the manifest becomes the single thing the model reads from. Until then, v0
  loads an *authored* manifest and adds to context; it does not yet replace the
  existing sources.
- **Predefined templates as code.** Best-practice capsules
  (`application`/`feature`/`general`, a software-development template) ship as
  structured, instantiable definitions — the same transformation applied to a
  canned `spec`. A project instantiates a template instead of authoring from
  scratch.
- **Skill filtering via `spec.compose.skills` (shipped).** The manifest selects
  which skills the model sees (`{ include, exclude }`) — the need-to-know / token
  lever. Schema in `capsule/manifest.ts` (`Compose`/`SkillSelection`); V1 filters in
  `session/system.ts` via `Capsule.filterSkills` (inert when off / no selection).
- **Instructions composition via `spec.compose.instructions` (shipped).** The
  manifest declares which instruction files govern; when present they render and
  REPLACE ad-hoc AGENTS.md discovery (manifest as source of truth). `Capsule.instructions`
  in the V1 adapter; wired in the `prompt.ts` system assembly; inert when absent.
  Next assembler slice: full `spec.compose` (constitution/prompt-profile) and an
  auto-assembler that folds discovered sources into the manifest.

Sequencing rule: the assembler and template system land **after** the reconcile
loop (increment 2) proves the manifest is load-bearing, so we never make the
manifest authoritative before it can be enforced.

---

## 7. Testing & rollout

- **Per increment:** unit-test the pure parts (render, convergence dispatch,
  admission predicates) and assert the disabled path contributes
  `SystemContext.empty`. Tests run from the package dir (`packages/core`), never
  root.
- **Behavior-preserving gate:** the full typecheck + test suite must pass with
  every flag **off** and produce byte-identical context to pre-change `main`.
- **Dogfood:** author `.opencode/capsule.json` for this repo and enable the flag
  in a dev shell to validate end-to-end before defaulting anything on.
- **No default-on** until at least increments 1–3 are stable and measured (task
  success-rate delta, not token delta).
