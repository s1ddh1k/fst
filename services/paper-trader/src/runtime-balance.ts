export function resolveAvailablePaperCash(params: {
  startingBalance: number;
  currentBalance?: number;
  openNotional?: number;
}): number {
  const equity = params.currentBalance ?? params.startingBalance;
  const reservedNotional = Math.max(0, params.openNotional ?? 0);

  return Math.max(0, equity - reservedNotional);
}

export function applyPaperSellNetValue(currentCash: number, netValue: number): number {
  return currentCash + netValue;
}
