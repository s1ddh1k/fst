import type { CandidateBacktestEvaluation, ResearchIterationRecord } from "./types.js";

export class FamilyLifecycleTracker {
  private stagnationStreak = new Map<string, number>();
  private iterationCounts = new Map<string, number>();
  private bestNetReturn = new Map<string, number>();
  private retired = new Set<string>();
  private readonly stagnationThreshold: number;
  private readonly iterationBudget: number;

  constructor(params: {
    stagnationThreshold?: number;
    iterationBudget?: number;
  }) {
    this.stagnationThreshold = params.stagnationThreshold ?? 5;
    this.iterationBudget = params.iterationBudget ?? 15;
  }

  restoreFromHistory(
    iterations: ResearchIterationRecord[],
    trackedFamilyIds: Set<string>,
    compareEvaluations: (a: CandidateBacktestEvaluation, b: CandidateBacktestEvaluation) => number
  ): void {
    const epsilon = 1e-6;
    for (const iteration of iterations) {
      const bestByFamily = new Map<string, CandidateBacktestEvaluation>();
      for (const evaluation of iteration.evaluations) {
        const fid = evaluation.candidate.familyId;
        if (trackedFamilyIds.size > 0 && !trackedFamilyIds.has(fid)) {
          continue;
        }
        const current = bestByFamily.get(fid);
        if (!current || compareEvaluations(current, evaluation) > 0) {
          bestByFamily.set(fid, evaluation);
        }
      }

      for (const [fid, iterBest] of bestByFamily) {
        this.iterationCounts.set(fid, (this.iterationCounts.get(fid) ?? 0) + 1);
        const prevBest = this.bestNetReturn.get(fid) ?? -Infinity;
        const currentBest = iterBest.summary.netReturn;
        if (currentBest > prevBest + epsilon) {
          this.stagnationStreak.set(fid, 0);
          this.bestNetReturn.set(fid, currentBest);
        } else {
          this.stagnationStreak.set(fid, (this.stagnationStreak.get(fid) ?? 0) + 1);
        }
      }
    }
  }

  trackIteration(
    evaluations: CandidateBacktestEvaluation[],
    compareEvaluations: (a: CandidateBacktestEvaluation, b: CandidateBacktestEvaluation) => number
  ): string[] {
    const epsilon = 1e-6;
    const newlyRetired: string[] = [];
    const bestByFamily = new Map<string, CandidateBacktestEvaluation>();

    for (const evaluation of evaluations) {
      const fid = evaluation.candidate.familyId;
      const current = bestByFamily.get(fid);
      if (!current || compareEvaluations(current, evaluation) > 0) {
        bestByFamily.set(fid, evaluation);
      }
    }

    for (const [fid, iterBest] of bestByFamily) {
      if (this.retired.has(fid)) {
        continue;
      }

      this.iterationCounts.set(fid, (this.iterationCounts.get(fid) ?? 0) + 1);
      const prevBest = this.bestNetReturn.get(fid) ?? -Infinity;
      const improved = iterBest.summary.netReturn > prevBest + epsilon;

      if (improved) {
        this.stagnationStreak.set(fid, 0);
        this.bestNetReturn.set(fid, iterBest.summary.netReturn);
      } else {
        const streak = (this.stagnationStreak.get(fid) ?? 0) + 1;
        this.stagnationStreak.set(fid, streak);
        if (streak >= this.stagnationThreshold) {
          this.retired.add(fid);
          newlyRetired.push(fid);
        }
      }

      const count = this.iterationCounts.get(fid) ?? 0;
      if (count >= this.iterationBudget && !this.retired.has(fid)) {
        this.retired.add(fid);
        newlyRetired.push(fid);
      }
    }

    return newlyRetired;
  }

  getStagnationStreak(): Map<string, number> { return this.stagnationStreak; }
  getIterationCounts(): Map<string, number> { return this.iterationCounts; }

  hasActiveFamily(familyIds: Iterable<string>): boolean {
    for (const fid of familyIds) {
      if (!this.retired.has(fid)) return true;
    }
    return false;
  }

  getSummary(): string {
    const entries = [...this.iterationCounts.entries()]
      .map(([fid, iter]) => {
        const stag = this.stagnationStreak.get(fid) ?? 0;
        const best = this.bestNetReturn.get(fid) ?? 0;
        const status = this.retired.has(fid) ? "RETIRED" : "active";
        return `${fid}(${status} iter=${iter} stag=${stag} best=${(best * 100).toFixed(2)}%)`;
      })
      .join(", ");
    return entries;
  }
}
