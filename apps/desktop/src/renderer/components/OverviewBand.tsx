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
  const latestPaperLog = opsSnapshot?.logs.paper
    ? `${opsSnapshot.logs.paper.name} · ${formatDateTime(locale, opsSnapshot.logs.paper.updatedAt)}`
    : t("latestNone");

  return (
    <section className="overview-band">
      <article className="hero-stat hero-stat-emphasis hero-stat-numeric">
        <span className="meta-label" id="label-recommendations">
          {t("labelRecommendations")}
        </span>
        <strong id="recommendation-count">{recommendations.length}</strong>
        <p id="stats-recommendations-copy">{t("statsRecommendationsCopy")}</p>
      </article>
      <article className="hero-stat hero-stat-numeric">
        <span className="meta-label" id="label-live-sessions">
          {t("labelLiveSessions")}
        </span>
        <strong id="session-count">{sessions.length}</strong>
        <p id="stats-sessions-copy">{t("statsSessionsCopy")}</p>
      </article>
      <article className="hero-stat hero-stat-log">
        <span className="meta-label" id="label-paper-log">
          {t("labelPaperApi")}
        </span>
        <strong id="paper-log-label">
          {opsSnapshot?.paperTrader.status === "starting"
            ? t("statusSyncing")
            : opsSnapshot?.paperTrader.managed
              ? t("runtimeEmbeddedHealthy")
              : t("runtimeExternal")}
        </strong>
        <p id="stats-paper-copy">{latestPaperLog}</p>
      </article>
    </section>
  );
}
