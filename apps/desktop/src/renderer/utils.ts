import type { DictionaryKey, Locale } from "./types";
import { dictionaries } from "./i18n";

export function createTranslator(locale: Locale) {
  return (key: DictionaryKey, values: Record<string, string | number> = {}) => {
    const template = dictionaries[locale][key] ?? dictionaries.ko[key];
    return template.replace(/\{(\w+)\}/g, (_, token) => String(values[token] ?? ""));
  };
}

export function formatNumber(locale: Locale, value: number | null | undefined) {
  return Number(value ?? 0).toLocaleString(locale, { maximumFractionDigits: 2 });
}

export function formatPercent(locale: Locale, value: number) {
  return `${(value * 100).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}%`;
}

export function formatDateTime(locale: Locale, value: string | Date | null | undefined) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString(locale, { hour12: false });
}

export function formatStatus(locale: Locale, status: string) {
  const t = createTranslator(locale);

  if (status === "running") return t("statusRunning");
  if (status === "ready") return t("statusReady");
  if (status === "stopped") return t("statusStopped");
  if (status === "error") return t("statusError");

  return status;
}

export function getStrategyAccent(strategyNames: string[]) {
  const accents = ["accent-teal", "accent-amber", "accent-ink"];
  const hash = strategyNames.join("-").split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return accents[hash % accents.length];
}
