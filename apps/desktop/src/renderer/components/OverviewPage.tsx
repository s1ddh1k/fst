import type { Locale, Recommendation, RecommendationSnapshot, Session } from "../types";
import { formatDateTime, formatNumber, formatPercent, formatStatus } from "../utils";
import type { TFunction } from "./shared";

type OverviewPageProps = {
  t: TFunction;
  locale: Locale;
  apiHealthy: boolean;
  apiMessage: string;
  recommendations: Recommendation[];
  snapshots: RecommendationSnapshot[];
  sessions: Session[];
  opsSnapshot: FstDesktopOpsSnapshot | null;
};

export function OverviewPage(props: OverviewPageProps) {
  const { t, locale, apiHealthy, apiMessage, recommendations, snapshots, sessions, opsSnapshot } = props;
  const leadSnapshot = snapshots[0] ?? null;
  const leadSession = sessions[0] ?? null;

  return (
    <section className="hub-stage">
      <div
        className={`api-banner api-banner-ledger ${apiHealthy ? "api-banner-success" : "api-banner-danger"}`}
      >
        {apiHealthy ? t("overviewHealthyBanner") : t("apiDownBanner", { message: apiMessage })}
      </div>

      <div className="overview-stack">
        <section className="panel-surface">
          <div className="section-head">
            <div>
              <h2>{t("overviewInsightsTitle")}</h2>
              <p className="panel-caption">{t("overviewInsightsCopy")}</p>
            </div>
          </div>
          <OverviewHighlights
            t={t}
            locale={locale}
            recommendations={recommendations}
            snapshots={snapshots}
            sessions={sessions}
            opsSnapshot={opsSnapshot}
          />
        </section>

        <section className="hub-grid">
          <section className="panel-surface">
            <div className="section-head">
              <div>
                <h2>{t("overviewSnapshotTitle")}</h2>
                <p className="panel-caption">{t("overviewSnapshotCopy")}</p>
              </div>
            </div>
            {leadSnapshot ? (
              <div className="detail-grid">
                <div>
                  <span className="meta-label">{t("labelActiveRegime")}</span>
                  <strong>{leadSnapshot.regimeName}</strong>
                </div>
                <div>
                  <span className="meta-label">{t("snapshotLead")}</span>
                  <strong>{leadSnapshot.bestStrategyName ?? "-"}</strong>
                </div>
                <div>
                  <span className="meta-label">{t("snapshotUpdated")}</span>
                  <strong>{formatDateTime(locale, leadSnapshot.updatedAt)}</strong>
                </div>
                <div>
                  <span className="meta-label">{t("snapshotBest")}</span>
                  <strong>{formatPercent(locale, leadSnapshot.bestAvgTestReturn)}</strong>
                </div>
              </div>
            ) : (
              <div className="empty-panel">
                <p>{t("emptySnapshots")}</p>
              </div>
            )}
          </section>

          <section className="panel-surface">
            <div className="section-head">
              <div>
                <h2>{t("overviewSessionTitle")}</h2>
                <p className="panel-caption">{t("overviewSessionCopy")}</p>
              </div>
            </div>
            {leadSession ? (
              <div className="detail-grid">
                <div>
                  <span className="meta-label">{t("strategy")}</span>
                  <strong>{leadSession.strategyName}</strong>
                </div>
                <div>
                  <span className="meta-label">{t("status")}</span>
                  <strong>{formatStatus(locale, leadSession.status)}</strong>
                </div>
                <div>
                  <span className="meta-label">{t("marketCode")}</span>
                  <strong>{leadSession.marketCode}</strong>
                </div>
                <div>
                  <span className="meta-label">{t("currentBalance")}</span>
                  <strong>{formatNumber(locale, leadSession.currentBalance)}</strong>
                </div>
              </div>
            ) : (
              <div className="empty-panel">
                <p>{t("emptySessions")}</p>
              </div>
            )}
          </section>
        </section>
      </div>
    </section>
  );
}

function OverviewHighlights(props: {
  t: TFunction;
  locale: Locale;
  recommendations: Recommendation[];
  snapshots: RecommendationSnapshot[];
  sessions: Session[];
  opsSnapshot: FstDesktopOpsSnapshot | null;
}) {
  const { t, locale, recommendations, snapshots, sessions, opsSnapshot } = props;

  return (
    <div className="overview-highlights">
      <article className="detail-block detail-block-highlight">
        <span className="meta-label">{t("overviewHighlightStrategy")}</span>
        <strong>
          {recommendations[0]?.strategyNames.join(" + ").replaceAll("-", " ") ?? t("latestNone")}
        </strong>
        <p>
          {recommendations[0]
            ? `${t("avgReturn")} ${formatPercent(locale, recommendations[0].avgTestReturn)}`
            : t("emptyRecommendations")}
        </p>
      </article>
      <article className="detail-block detail-block-highlight">
        <span className="meta-label">{t("overviewHighlightSession")}</span>
        <strong>{sessions[0] ? `#${sessions[0].id}` : t("latestNone")}</strong>
        <p>
          {sessions[0]
            ? `${sessions[0].marketCode} / ${formatStatus(locale, sessions[0].status)}`
            : t("emptySessions")}
        </p>
      </article>
      <article className="detail-block detail-block-highlight">
        <span className="meta-label">{t("overviewHighlightSnapshot")}</span>
        <strong>{snapshots[0]?.universeName ?? t("latestNone")}</strong>
        <p>
          {snapshots[0]
            ? `${t("snapshotUpdated")} ${formatDateTime(locale, snapshots[0].updatedAt)}`
            : t("emptySnapshots")}
        </p>
      </article>
      <article className="detail-block detail-block-highlight">
        <span className="meta-label">{t("overviewHighlightRuntime")}</span>
        <strong>
          {opsSnapshot?.paperTrader.managed ? t("statusEmbedded") : t("statusExternal")}
        </strong>
        <p>
          {opsSnapshot?.paperTrader.logPath
            ? opsSnapshot.paperTrader.logPath
            : t("runtimeExternal")}
        </p>
      </article>
    </div>
  );
}
