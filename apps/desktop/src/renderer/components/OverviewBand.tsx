import type { Locale, Recommendation, Session } from "../types";
import { formatDateTime } from "../utils";
import type { TFunction } from "./shared";

type OverviewBandProps = {
  t: TFunction;
  locale: Locale;
  recommendations: Recommendation[];
  sessions: Session[];
  opsSnapshot: FstDesktopOpsSnapshot | null;
};

export function OverviewBand(props: OverviewBandProps) {
  const { t, locale, recommendations, sessions, opsSnapshot } = props;

  return (
    <section className="overview-band">
      <article className="hero-stat hero-stat-emphasis">
        <span className="meta-label" id="label-recommendations">
          {t("labelRecommendations")}
        </span>
        <strong id="recommendation-count">{recommendations.length}</strong>
        <p id="stats-recommendations-copy">{t("statsRecommendationsCopy")}</p>
      </article>
      <article className="hero-stat">
        <span className="meta-label" id="label-live-sessions">
          {t("labelLiveSessions")}
        </span>
        <strong id="session-count">{sessions.length}</strong>
        <p id="stats-sessions-copy">{t("statsSessionsCopy")}</p>
      </article>
      <article className="hero-stat hero-stat-log">
        <span className="meta-label" id="label-collector-log">
          {t("labelCollectorLog")}
        </span>
        <strong id="collector-log-label">
          {opsSnapshot?.logs.collector
            ? `${opsSnapshot.logs.collector.name} · ${formatDateTime(locale, opsSnapshot.logs.collector.updatedAt)}`
            : t("latestNone")}
        </strong>
        <p id="stats-collector-copy">{t("statsCollectorCopy")}</p>
      </article>
      <article className="hero-stat hero-stat-log">
        <span className="meta-label" id="label-paper-log">
          {t("labelPaperLog")}
        </span>
        <strong id="paper-log-label">
          {opsSnapshot?.logs.paper
            ? `${opsSnapshot.logs.paper.name} · ${formatDateTime(locale, opsSnapshot.logs.paper.updatedAt)}`
            : t("latestNone")}
        </strong>
        <p id="stats-paper-copy">{t("statsPaperCopy")}</p>
      </article>
    </section>
  );
}
