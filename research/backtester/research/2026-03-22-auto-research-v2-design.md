# Auto-Research V2 Design

Date: 2026-03-22
Owner: auto-research refactor track
Status: proposed

## Goal

Move `auto-research` from a fragile LLM-driven parameter search loop toward a persistent autonomous research engine that can:

1. search parameters deterministically at high throughput
2. evolve strategy families and code structure with LLM assistance
3. persist lineage, drift, and convergence state across long unattended runs
4. remain compatible with the current Node.js and TypeScript codebase

This design keeps the existing backtester, SQLite, strategy registry, paper-trading path, and runtime discovery in Node.js.

## Why The Current Structure Tops Out

Current control flow lives mostly in:

- `research/backtester/src/auto-research/orchestrator.ts`
- `research/backtester/src/auto-research/types.ts`
- `research/backtester/src/auto-research/llm-adapter.ts`
- `research/backtester/src/auto-research/code-agent.ts`
- `research/backtester/src/auto-research/proposed-catalog.ts`
- `research/backtester/src/auto-research/run-manager.ts`

The current loop mixes three different concerns into one iteration object:

1. parameter search
2. family/catalog evolution
3. code evolution

The practical result:

- `ReviewDecision.nextCandidates` is still part of the control plane
- code mutation exists but is a side lane, not the main research object
- the run state is iteration-centric, not lineage-centric
- the same LLM review has to judge, rank, mutate, and emit valid executable JSON
- unattended long runs fail on contract/latency issues before research budget is exhausted

The key local signals:

- `ReviewDecision` currently carries `nextCandidates`, `proposedFamilies`, and `codeTasks` in one payload
- `ensureNextCandidatesForKeepSearching()` can still fail the run when review output is weak
- `toReviewProposalBatch()` and review prompts are built around candidate batches, not around higher-level hypotheses
- `CliCodeMutationAgent` can execute bounded code tasks, but only after proposal/review already chose them
- `CatalogEntryRecord` can represent proposed and implemented families, but there is no first-class lineage for family/code evolution

## What To Borrow

### From Karpathy `autoresearch`

Use the idea, not the Python.

The useful parts are:

- one objective evaluation harness
- a narrow editable scope per experiment
- deterministic keep/discard decisions
- very cheap experiment cadence

This maps to our system as:

- backtest and walk-forward stay the objective harness
- parameter candidates and code mutations should each have explicit editable scope
- promotion and rejection remain engine-governed

### From `Q00/ouroboros`

Use the persistence and lineage ideas, not the ontology-heavy workflow as-is.

The useful parts are:

- event-sourced run history
- persistent loop that survives session boundaries
- explicit stagnation and convergence detection
- separation between execution and evaluation

This maps to our system as:

- research lineage in SQLite
- drift/stagnation/convergence summaries over families, code tasks, and candidate genomes
- restart-safe autonomous runs

## Target Architecture

Split the system into three loops.

### 1. Inner Loop: Experiment Kernel

Purpose:

- compile executable candidate plans
- evaluate them deterministically
- score and rank them
- never depend on LLM output shape to continue

Responsibilities:

- seed loading
- deterministic mutations
- candidate diversification
- market selection
- backtest and walk-forward execution
- promotion gate checks
- artifact persistence

LLM role:

- none required for loop continuity

Output:

- `ExperimentResult[]`
- leaderboard
- objective signals for the outer/spec loops

### 2. Outer Loop: Hypothesis And Code Evolution

Purpose:

- generate and refine higher-level research hypotheses
- propose new families, features, and code mutations
- decide what should be compiled into experiments

Responsibilities:

- propose new family schemas
- propose code changes in bounded scopes
- propose new scoring/exit/feature ideas
- select which hypothesis branches deserve budget next

LLM role:

- hypothesis generation
- ranking or selecting among engine-generated options
- proposing code tasks and spec mutations

Important constraint:

- the outer loop should not directly author `nextCandidates`
- it should author hypotheses and bounded change requests
- the engine compiles those into executable candidate batches

### 3. Spec Loop: Persistent Lineage, Drift, And Convergence

Purpose:

- track whether research is actually learning or just thrashing
- allow unattended runs to resume safely
- summarize why the current branch exists

Responsibilities:

- lineage graph
- event log
- drift metrics
- stagnation detection
- convergence heuristics
- resume/replay/retrospective

LLM role:

- optional summarization and retrospective
- not required to keep the system alive

## Core Design Principle

LLM output should shape research direction, but not directly own loop continuity.

That means:

- LLM can propose code tasks and family ideas
- LLM can prefer one hypothesis branch over another
- engine must compile executable experiments
- engine must decide whether enough valid next work exists
- engine must keep running even if review text is mediocre

## New First-Class Objects

The current `ProposalBatch` / `ReviewDecision` abstraction is too iteration-local.

Add these new concepts in `types.ts`.

### ResearchHypothesis

Represents a branch of reasoning, not an executable batch.

Suggested shape:

```ts
type ResearchHypothesis = {
  hypothesisId: string;
  stage: "parametric" | "family" | "feature" | "code";
  title: string;
  thesis: string;
  targetFamilyIds: string[];
  parentHypothesisIds: string[];
  evidence: string[];
  proposedSpecChanges: ProposedStrategyFamily[];
  proposedCodeTasks: CodeMutationTask[];
  expectedMechanism: string;
  riskNotes: string[];
  origin: "llm" | "engine" | "artifact_seed" | "human_seed";
};
```

### ExperimentPlan

Represents executable work compiled from hypotheses.

Suggested shape:

```ts
type ExperimentPlan = {
  planId: string;
  hypothesisId: string;
  mode: "candidate_batch" | "code_mutation_smoke" | "family_validation";
  candidates: CandidateProposal[];
  preparation: ResearchPreparationAction[];
  validationCommands: string[];
  budget: {
    candidateLimit: number;
    marketLimit: number;
    timeoutMs?: number;
  };
};
```

### ResearchLineage

Represents persistent research state across many loops.

Suggested shape:

```ts
type ResearchLineage = {
  lineageId: string;
  stage: ResearchStage;
  objective: string;
  startedAt: string;
  updatedAt: string;
  activeHypothesisIds: string[];
  convergedFamilyIds: string[];
  retiredHypothesisIds: string[];
  drift: ResearchDriftMetrics;
};
```

### ResearchDriftMetrics

Measures whether the loop is learning or spinning.

Suggested shape:

```ts
type ResearchDriftMetrics = {
  performanceDrift: number;
  noveltyDrift: number;
  structureDrift: number;
  reproducibilityDrift: number;
  stagnationScore: number;
};
```

## Proposed Module Split

Keep the current files working, but introduce explicit layers.

### A. Experiment Kernel

New files:

- `research/backtester/src/auto-research/experiment-compiler.ts`
- `research/backtester/src/auto-research/experiment-kernel.ts`
- `research/backtester/src/auto-research/lineage-store.ts`

Responsibilities:

- `experiment-compiler.ts`
  - converts `ResearchHypothesis[]` into `ExperimentPlan[]`
  - engine-generated mutations and top-ups happen here
  - artifact seeds, midpoint expansion, diversification, and family-aware mutations move here

- `experiment-kernel.ts`
  - executes `ExperimentPlan`
  - wraps current evaluation machinery
  - owns deterministic continuation when LLM is absent or weak

- `lineage-store.ts`
  - appends lineage events and snapshots
  - likely SQLite-backed
  - can start with append-only JSONL plus SQLite later, but SQLite is preferred

### B. Outer Loop

New files:

- `research/backtester/src/auto-research/hypothesis-orchestrator.ts`
- `research/backtester/src/auto-research/research-review.ts`

Responsibilities:

- `hypothesis-orchestrator.ts`
  - calls LLM for hypothesis generation
  - never asks LLM for raw executable next batch as the only continuation path
  - emits `ResearchHypothesis[]`

- `research-review.ts`
  - synthesizes objective results with LLM judgment
  - can say:
    - keep the same hypothesis branch
    - spawn a code branch
    - freeze a validated family
    - retire a branch

### C. Code Evolution

Reuse and promote:

- `research/backtester/src/auto-research/code-agent.ts`
- `research/backtester/src/auto-research/proposed-catalog.ts`
- `research/backtester/src/auto-research/runtime-discovery.ts`
- `research/backtester/src/auto-research/validation.ts`

Needed changes:

1. code mutation becomes a first-class `ExperimentPlan` mode
2. each code task runs in an isolated workspace or git worktree
3. each code task gets a fixed benchmark pack
4. only after passing benchmark pack should the new family/catalog entry become active in main runtime families

Suggested new file:

- `research/backtester/src/auto-research/code-worktree.ts`

Responsibilities:

- create disposable branch/worktree
- run code task
- run smoke benchmark
- collect diff, validation, benchmark deltas
- merge or discard

## Required Change In Control Flow

### Current

```
proposal -> preparation -> code mutation -> evaluation -> review
review decides nextCandidates directly
```

### Proposed

```
lineage -> hypothesis generation -> experiment compilation -> execution kernel -> objective review -> lineage update
                                               |
                                               +-> optional code evolution branch
```

More concretely:

1. load lineage state
2. gather objective ledger summary
3. ask LLM for hypotheses, spec deltas, and optional code tasks
4. engine compiles executable plans from those hypotheses
5. run plans through experiment kernel
6. objective governance updates catalog, leaderboard, validated blocks
7. review layer updates lineage, not raw nextCandidates
8. if code branch is approved, launch isolated code experiment plan

## What Changes In Existing Files

### `types.ts`

Add:

- `ResearchHypothesis`
- `ExperimentPlan`
- `ResearchLineage`
- `ResearchDriftMetrics`
- `LineageEvent`

Do not immediately remove:

- `ProposalBatch`
- `ReviewDecision`

Instead:

- deprecate them for inner-loop control
- keep them as compatibility payloads while the refactor is staged

### `orchestrator.ts`

Reduce it to a composition root.

Near-term target:

- keep current CLI entry point
- move candidate generation logic out
- move review-governance logic out
- call:
  - `loadOrCreateLineage()`
  - `generateHypotheses()`
  - `compileExperimentPlans()`
  - `runExperimentKernel()`
  - `updateLineage()`

`governReviewDecision()` and `ensureNextCandidatesForKeepSearching()` should stop being the gatekeepers of loop continuity.

### `llm-adapter.ts`

Shift responsibilities:

Current:

- outputs proposal batches and review decisions with executable candidates

Target:

- outputs higher-level hypotheses and spec/code proposals
- can still emit candidate ideas, but compiler owns executable final form

New methods to add:

- `proposeHypotheses()`
- `reviewLineageProgress()`
- `proposeCodeEvolution()`

### `code-agent.ts`

Keep the current bounded-scope audit.

Promote it by adding:

- isolated worktree execution
- benchmark pack invocation
- merge/discard decision payload

### `proposed-catalog.ts`

Use it as the bridge between outer loop and inner loop.

New behavior:

- `proposed` is not enough
- add explicit activation states, for example:
  - `proposed`
  - `compiled`
  - `benchmarked`
  - `implemented`
  - `validated`
  - `discarded`

This is the missing layer between LLM idea and executable runtime family.

### `run-manager.ts`

Keep it, but add lineage-level persistence.

Current state files are run-local:

- `run-state.json`
- `status.json`

Add lineage artifacts such as:

- `lineage.json`
- `events.jsonl` or SQLite-backed event tables
- `retrospective.json`

## Objective Governance Rules

Move more decisions from LLM to deterministic engine governance.

### Engine-Owned

- candidate dedupe
- diversification
- candidate compilation
- candidate budget allocation
- promotion gates
- max-no-trade stopping
- benchmark pass/fail for code mutations
- validated block promotion

### LLM-Owned

- new hypothesis generation
- family schema proposals
- feature/exit/market-state ideas
- bounded code task proposals
- ranking which branches deserve more budget

### Shared

- branch retirement
- convergence judgment
- retrospective summaries

## How Code Evolution Becomes Real

The user requirement is not just parameter search. The engine must be able to discover that a new code path or feature is worth trying.

That requires a strict pipeline:

1. LLM proposes `CodeMutationTask`
2. engine checks task policy
3. task runs in isolated worktree
4. benchmark pack runs
5. runtime discovery checks for new family or changed behavior
6. only then does catalog state move forward
7. only then can main inner loop allocate experiment budget to the new family

Without this isolation, code evolution keeps contaminating the main search loop.

## Benchmark Packs For Code Evolution

Add a small deterministic benchmark layer for code tasks.

Suggested file:

- `research/backtester/src/auto-research/benchmark-pack.ts`

Pack types:

- `strategy-smoke`
- `block-walk-forward-smoke`
- `portfolio-walk-forward-smoke`
- `performance-regression-smoke`

Each code task should declare which benchmark pack applies.

## Drift, Stagnation, Convergence

Inspired by Ouroboros, but adapted to research.

### Drift Signals

- performance drift:
  - top-N OOS score stopped improving
- novelty drift:
  - new candidates are too close to old ones
- structure drift:
  - same family is being renamed without real semantic change
- reproducibility drift:
  - holdout wins do not repeat in walk-forward or cross-checks

### Stagnation Signals

- same family basin selected for `N` generations
- no validated blocks after `N` generations
- code tasks repeatedly fail the same benchmark pack
- best candidate score delta below epsilon for `N` generations

### Convergence Signals

- no family/schema mutation for `N` generations
- top validated blocks stable across reruns
- drift below threshold and promotion set unchanged

These should be engine-computed first and only summarized by LLM second.

## Three-Phase Implementation Sequence

### Phase 1: Remove LLM From Loop Continuity

Goal:

- make current unattended loop robust before adding more autonomy

Changes:

1. add `experiment-compiler.ts`
2. make engine compile next candidate batches from:
   - artifact seeds
   - engine mutations
   - LLM hypothesis hints
3. make review optional for continuation
4. LLM review can refine ranking, not block progress

Expected result:

- current `keep_searching without nextCandidates` class of failure disappears as a hard blocker

### Phase 2: Promote Code Evolution To First-Class

Goal:

- make code tasks research objects, not side effects

Changes:

1. add worktree isolation
2. add benchmark packs
3. add catalog activation states
4. add `code_evolution` experiment plan mode

Expected result:

- LLM can genuinely suggest new structure or new factors
- system can test them unattended without corrupting the main runtime

### Phase 3: Add Persistent Research Lineage

Goal:

- long-running autonomous improvement with restart safety and branch memory

Changes:

1. add lineage store
2. add drift/stagnation metrics
3. add retrospectives and branch selection
4. add convergence-aware scheduling

Expected result:

- the system behaves more like a research organization and less like a stateless prompt loop

## First Concrete Refactor Steps

If implementation starts immediately, the first pull sequence should be:

1. create `experiment-compiler.ts`
2. move artifact seeds, engine mutations, and diversification into it
3. change orchestrator to continue from compiled plans even if review is weak
4. add `ResearchHypothesis` and `ExperimentPlan` types
5. add `code-worktree.ts`
6. wrap `CliCodeMutationAgent` with isolated benchmarked execution
7. add lineage persistence

## What Not To Do

- do not rewrite the project in Python
- do not move backtesting correctness into the LLM layer
- do not make code mutation directly edit the main workspace without isolation
- do not let review JSON own run continuity
- do not collapse block and portfolio loops back into one undifferentiated prompt

## Bottom Line

The target is not "better prompts".

The target is:

- deterministic inner loop
- hypothesis-driven outer loop
- persistent lineage/spec loop
- first-class code evolution in Node.js

That is the structure that can eventually support autonomous discovery of new strategy families, new indicators, new exit logic, and new portfolio assembly behavior without requiring a human to keep the loop alive.
