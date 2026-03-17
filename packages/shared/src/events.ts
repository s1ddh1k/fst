export type EngineEventKind =
  | "raw_signal"
  | "blocked_signal"
  | "funnel_stage"
  | "order_intent"
  | "order_fill"
  | "ghost_signal";

export type EngineEvent = {
  kind: EngineEventKind;
  at: Date;
  strategyId?: string;
  sleeveId?: string;
  market?: string;
  payload: Record<string, unknown>;
};

export class InMemoryEventStore {
  private readonly events: EngineEvent[] = [];

  append(event: EngineEvent): void {
    this.events.push(event);
  }

  list(): EngineEvent[] {
    return this.events.slice();
  }

  byKind(kind: EngineEventKind): EngineEvent[] {
    return this.events.filter((event) => event.kind === kind);
  }
}
