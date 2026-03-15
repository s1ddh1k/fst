import { useEffect, useState } from "react";

import { localeStorageKey } from "./config";
import { useDesktopData } from "./hooks/useDesktopData";
import type { Locale, Recommendation, ScoredValidation } from "./types";
import { createTranslator, formatNumber, formatPercent, formatStatus, getStrategyAccent } from "./utils";

function getInitialLocale(): Locale {
  const stored = window.localStorage.getItem(localeStorageKey);
  return stored === "en" ? "en" : "ko";
}

function extractValidation(item: Recommendation): ScoredValidation | null {
  if (item.strategyType !== "single_scored" || !item.parametersJson) {
    return null;
  }

  const params = item.parametersJson as Record<string, unknown>;
  if (typeof params.bootstrapPassRate !== "number") return null;

  return {
    bootstrapPassRate: params.bootstrapPassRate as number,
    randomPassRate: params.randomPassRate as number,
    avgTestTradeCount: (params.avgTestTradeCount as number) ?? 0
  };
}

export function App() {
  const [locale, setLocale] = useState<Locale>(getInitialLocale);
  const [market, setMarket] = useState("KRW-BTC");
  const [timeframe, setTimeframe] = useState("5m");
  const [balance, setBalance] = useState("1000000");
  const t = createTranslator(locale);
  const data = useDesktopData({ timeframe, market, balance, t });

  useEffect(() => {
    document.documentElement.lang = locale;
    window.localStorage.setItem(localeStorageKey, locale);
  }, [locale]);

  const positions =
    data.sessionDetail?.positions.length
      ? data.sessionDetail.positions
      : data.sessionDetail?.position
        ? [{ ...data.sessionDetail.position, marketCode: data.sessionDetail.position.marketCode ?? data.sessionDetail.session.marketCode }]
        : [];
  const primaryPosition = data.sessionDetail?.position ?? positions[0] ?? null;
  const compactOrders = data.sessionDetail?.recentOrders.slice(0, 5) ?? [];

  return (
    <div className="app-shell">
      <main className="app-main">
        {/* Header */}
        <header className="app-header">
          <div className="header-left">
            <span className="app-logo">fst</span>
            <p className="header-tagline">{t("appTagline")}</p>
          </div>
          <div className="header-right">
            <span className={`conn-dot ${data.apiHealthy ? "conn-ok" : "conn-down"}`} />
            <span className="conn-label">
              {data.apiHealthy ? t("connectionOk") : t("connectionDown")}
            </span>
            <div className="locale-toggle">
              <button className={locale === "ko" ? "active" : ""} onClick={() => setLocale("ko")}>한</button>
              <button className={locale === "en" ? "active" : ""} onClick={() => setLocale("en")}>EN</button>
            </div>
          </div>
        </header>

        {/* Error banner */}
        {data.apiMessage ? (
          <div className="error-banner">{data.apiMessage}</div>
        ) : null}
        {data.actionError ? (
          <div className="error-banner">{t("actionError")}: {data.actionError}</div>
        ) : null}

        {/* Step 1: Pick strategy */}
        <section className="step-section">
          <div className="step-header">
            <span className="step-number">1</span>
            <div>
              <h2>{t("step1Title")}</h2>
              <p className="step-copy">{t("step1Copy")}</p>
            </div>
          </div>

          <div className="strategy-grid">
            {data.recommendations.length ? (
              data.recommendations.map((item) => {
                const validation = extractValidation(item);
                const isScored = item.strategyType === "single_scored";
                return (
                  <article className={`strategy-card ${getStrategyAccent(item.strategyNames)}`} key={item.id}>
                    <div className="card-top">
                      <span className="rank-pill">#{item.rank}</span>
                      {isScored ? (
                        <span className="type-pill type-scored">{t("scoredBadge")}</span>
                      ) : (
                        <span className="type-pill">{t("strategyCardCandidate")}</span>
                      )}
                    </div>
                    <h3 className="strategy-name">{item.strategyNames.join(" + ").replaceAll("-", " ")}</h3>
                    <div className="strategy-metrics">
                      <div className="metric">
                        <span>{t("avgReturn")}</span>
                        <strong className={item.avgTestReturn >= 0 ? "positive" : "negative"}>
                          {formatPercent(locale, item.avgTestReturn)}
                        </strong>
                      </div>
                      <div className="metric">
                        <span>{t("avgMdd")}</span>
                        <strong className="negative">{formatPercent(locale, item.avgTestDrawdown)}</strong>
                      </div>
                      <div className="metric">
                        <span>{t("marketCount")}</span>
                        <strong>{item.marketCount}</strong>
                      </div>
                    </div>
                    {validation ? (
                      <div className="validation-row">
                        <span className={`val-badge ${validation.bootstrapPassRate > 0 && validation.randomPassRate >= 0.9 ? "val-pass" : "val-fail"}`}>
                          {validation.bootstrapPassRate > 0 && validation.randomPassRate >= 0.9 ? t("validationPassed") : validation.bootstrapPassRate === 0 ? t("validationNA") : t("validationFailed")}
                        </span>
                        <span className="val-detail">{t("bootstrapLabel")} {formatPercent(locale, validation.bootstrapPassRate)}</span>
                        <span className="val-detail">{t("randomLabel")} {formatPercent(locale, validation.randomPassRate)}</span>
                      </div>
                    ) : null}
                    <button
                      className="start-button"
                      onClick={() => void data.startSession(item.rank)}
                      disabled={data.pendingAction !== ""}
                    >
                      {data.pendingAction === "start" ? t("startInvestingBusy") : t("startInvesting")}
                    </button>
                  </article>
                );
              })
            ) : (
              <div className="empty-state">
                <p>{data.apiHealthy ? t("noStrategies") : t("noStrategiesOffline")}</p>
              </div>
            )}
          </div>
        </section>

        {/* Step 2: My investments */}
        <section className="step-section">
          <div className="step-header">
            <span className="step-number">2</span>
            <div>
              <h2>{t("step2Title")}</h2>
              <p className="step-copy">{t("step2Copy")}</p>
            </div>
          </div>

          {data.sessions.length ? (
            <div className="investment-layout">
              <div className="investment-list">
                {data.sessions.map((item) => (
                  <article
                    className={`investment-row ${data.activeSessionId === item.id ? "active" : ""}`}
                    key={item.id}
                    onClick={() => void data.selectSession(item.id)}
                  >
                    <div className="investment-row-top">
                      <span className="rank-pill">#{item.id}</span>
                      <span className={`status-pill status-${item.status}`}>
                        {formatStatus(locale, item.status)}
                      </span>
                    </div>
                    <p className="investment-strategy">{item.strategyName.replaceAll("-", " ")}</p>
                    <p className="investment-market">{item.marketCode}</p>
                    <strong className="investment-balance">{formatNumber(locale, item.currentBalance)}</strong>
                  </article>
                ))}
              </div>

              <div className="investment-detail">
                {data.sessionDetail ? (
                  <>
                    <div className="detail-head">
                      <h3>{t("investmentTitle", { id: data.sessionDetail.session.id })}</h3>
                      <button
                        className="run-button"
                        onClick={() => void data.runSession()}
                        disabled={data.pendingAction !== "" || data.isDetailLoading}
                      >
                        {data.pendingAction === "run" ? t("runInvestmentBusy") : t("runInvestment")}
                      </button>
                    </div>

                    <div className="detail-metrics">
                      <div className="metric">
                        <span>{t("currentBalance")}</span>
                        <strong>{formatNumber(locale, data.sessionDetail.session.currentBalance)}</strong>
                      </div>
                      <div className="metric">
                        <span>{t("unrealizedPnl")}</span>
                        <strong className={positions.reduce((s, p) => s + p.unrealizedPnl, 0) >= 0 ? "positive" : "negative"}>
                          {formatNumber(locale, positions.reduce((s, p) => s + p.unrealizedPnl, 0))}
                        </strong>
                      </div>
                      <div className="metric">
                        <span>{t("realizedPnl")}</span>
                        <strong className={positions.reduce((s, p) => s + p.realizedPnl, 0) >= 0 ? "positive" : "negative"}>
                          {formatNumber(locale, positions.reduce((s, p) => s + p.realizedPnl, 0))}
                        </strong>
                      </div>
                      <div className="metric">
                        <span>{t("quantity")}</span>
                        <strong>{formatNumber(locale, primaryPosition?.quantity)}</strong>
                      </div>
                      <div className="metric">
                        <span>{t("markPrice")}</span>
                        <strong>{formatNumber(locale, primaryPosition?.markPrice)}</strong>
                      </div>
                      <div className="metric">
                        <span>{t("avgEntryPrice")}</span>
                        <strong>{formatNumber(locale, primaryPosition?.avgEntryPrice)}</strong>
                      </div>
                    </div>

                    {positions.length > 1 ? (
                      <div className="multi-positions">
                        {positions.map((pos, i) => (
                          <div className="position-pill" key={`${pos.marketCode ?? "pos"}-${i}`}>
                            <span>{pos.marketCode}</span>
                            <span>{formatNumber(locale, pos.quantity)}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {compactOrders.length ? (
                      <div className="order-list">
                        {compactOrders.map((order, i) => (
                          <div className={`order-row order-${order.side.toLowerCase()}`} key={`${order.side}-${i}`}>
                            <span className="order-side">{order.side}</span>
                            <span>{order.marketCode ?? data.sessionDetail!.session.marketCode}</span>
                            <span>{formatNumber(locale, order.executedPrice)}</span>
                            <span>{formatNumber(locale, order.quantity)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="empty-hint">{t("noOrders")}</p>
                    )}
                  </>
                ) : data.isDetailLoading ? (
                  <p className="empty-hint">{t("investmentDetailLoading")}</p>
                ) : (
                  <p className="empty-hint">{t("investmentDetailHint")}</p>
                )}
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <p>{t("noInvestments")}</p>
              <p className="empty-sub">{t("noInvestmentsHint")}</p>
            </div>
          )}
        </section>

        {/* Settings (collapsed) */}
        <details className="settings-section">
          <summary>{t("settingsTitle")}</summary>
          <div className="settings-grid">
            <label className="compact-field">
              <span>{t("balanceLabel")}</span>
              <input
                type="number"
                min="100000"
                step="100000"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
              />
            </label>
          </div>
        </details>
      </main>
    </div>
  );
}
