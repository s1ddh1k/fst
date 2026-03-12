type RateLimitState = {
  remainingSec: number | null;
  updatedAtMs: number;
};

type RemainingReqInfo = {
  group: string;
  sec: number | null;
};

const groupStates = new Map<string, RateLimitState>();

const DEFAULT_GROUP = "default";
const MIN_GAP_MS = 120;

function now(): number {
  return Date.now();
}

function getState(group: string): RateLimitState {
  return groupStates.get(group) ?? { remainingSec: null, updatedAtMs: 0 };
}

function setState(group: string, state: RateLimitState): void {
  groupStates.set(group, state);
}

function millisUntilNextSecond(updatedAtMs: number): number {
  const elapsed = now() - updatedAtMs;
  return Math.max(0, 1000 - elapsed);
}

export function parseRemainingReqHeader(headerValue: string | null): RemainingReqInfo {
  if (!headerValue) {
    return { group: DEFAULT_GROUP, sec: null };
  }

  const parts = headerValue.split(";").map((part) => part.trim());
  let group = DEFAULT_GROUP;
  let sec: number | null = null;

  for (const part of parts) {
    const [key, rawValue] = part.split("=").map((item) => item.trim());

    if (key === "group" && rawValue) {
      group = rawValue;
    }

    if (key === "sec" && rawValue) {
      const parsed = Number.parseInt(rawValue, 10);
      sec = Number.isNaN(parsed) ? null : parsed;
    }
  }

  return { group, sec };
}

export async function waitForQuota(
  group: string,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  const state = getState(group);

  if (state.updatedAtMs > 0) {
    const sinceUpdate = now() - state.updatedAtMs;

    if (sinceUpdate < MIN_GAP_MS) {
      await sleep(MIN_GAP_MS - sinceUpdate);
    }
  }

  if (state.remainingSec !== null && state.remainingSec <= 0) {
    const waitMs = millisUntilNextSecond(state.updatedAtMs);

    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }
}

export async function registerResponseQuota(
  headerValue: string | null,
  sleep: (ms: number) => Promise<void>
): Promise<string> {
  const parsed = parseRemainingReqHeader(headerValue);

  setState(parsed.group, {
    remainingSec: parsed.sec,
    updatedAtMs: now()
  });

  if (parsed.sec !== null && parsed.sec <= 1) {
    const waitMs = millisUntilNextSecond(now());

    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  return parsed.group;
}

export async function registerRateLimitHit(
  group: string,
  attempt: number,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  const state = getState(group);
  const waitMs = Math.max(millisUntilNextSecond(state.updatedAtMs), 1000 * attempt);

  setState(group, {
    remainingSec: 0,
    updatedAtMs: now()
  });

  await sleep(waitMs);
}
