import type { DictionaryKey } from "../types";

export type TFunction = (
  key: DictionaryKey,
  values?: Record<string, string | number>
) => string;
