import { InMemoryEventStore } from "../../../../packages/shared/src/index.js";

export function createEventStore(): InMemoryEventStore {
  return new InMemoryEventStore();
}
