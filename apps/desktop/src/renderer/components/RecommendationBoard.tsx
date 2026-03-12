import type { Locale, Recommendation } from "../types";
import { formatPercent, getStrategyAccent } from "../utils";
import type { TFunction } from "./shared";

type RecommendationBoardProps = {
  t: TFunction;
  locale: Locale;
  market: string;
  apiHealthy: boolean;
  pendingAction: string;
  recommendations: Recommendation[];
  onStartSession: (rank: number) => void;
};

export function RecommendationBoard(props: RecommendationBoardProps) {
  const { t, locale, market, apiHealthy, pendingAction, recommendations } = props;

  return (
    <section className="recommendation-stage panel-surface">
      <div className="section-head">
        <div>
          <h2 id="recommendations-title">{t("recommendationsTitle")}</h2>
          <p id="recommendations-copy" className="panel-caption">
            {t("recommendationsCopy")}
          </p>
        </div>
      </div>
      <div id="recommendations" className="recommendation-grid">
        {recommendations.length ? (
          recommendations.map((item) => (
            <article
              className={`recommendation-card ${getStrategyAccent(item.strategyNames)}`}
              key={item.id}
            >
              <div className="card-topline">
                <span className="rank-badge">#{item.rank}</span>
                <span className="status-badge">{t("recommendationCandidate")}</span>
              </div>
              <div className="recommendation-sigil">
                <span></span>
                <span></span>
                <span></span>
              </div>
              <h3>{item.strategyNames.join(" + ").replaceAll("-", " ")}</h3>
              <div className="recommendation-metrics">
                <div className="metric-box">
                  <span>{t("avgReturn")}</span>
                  <strong>{formatPercent(locale, item.avgTestReturn)}</strong>
                </div>
                <div className="metric-box">
                  <span>{t("avgMdd")}</span>
                  <strong>{formatPercent(locale, item.avgTestDrawdown)}</strong>
                </div>
                <div className="metric-box">
                  <span>{t("markets")}</span>
                  <strong>{item.marketCount}</strong>
                </div>
              </div>
              <p className="recommendation-rankline">
                {t("rankLabel").toUpperCase()} {item.rank}
              </p>
              <p>{t("recommendationCopy", { market })}</p>
              <button
                className="action-button"
                onClick={() => props.onStartSession(item.rank)}
                disabled={pendingAction !== ""}
              >
                {pendingAction === "start-session" ? t("startSessionBusy") : t("startSession")}
              </button>
            </article>
          ))
        ) : (
          <div className="empty-panel">
            <p>{apiHealthy ? t("emptyRecommendations") : t("apiRecommendationsError")}</p>
          </div>
        )}
      </div>
    </section>
  );
}
