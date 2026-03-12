import type { Locale, Recommendation, RecommendationSnapshot } from "../types";
import { RecommendationBoard } from "./RecommendationBoard";
import type { TFunction } from "./shared";

type StrategiesPageProps = {
  t: TFunction;
  locale: Locale;
  market: string;
  onMarketChange: (market: string) => void;
  timeframe: string;
  recommendations: Recommendation[];
  snapshots: RecommendationSnapshot[];
  apiHealthy: boolean;
  pendingAction: string;
  onStartSession: (rank: number) => void;
};

export function StrategiesPage(props: StrategiesPageProps) {
  const { recommendations, apiHealthy, pendingAction, onStartSession } = props;

  return (
    <section className="hub-stage">
      <RecommendationBoard
        t={props.t}
        locale={props.locale}
        market={props.market}
        onMarketChange={props.onMarketChange}
        apiHealthy={apiHealthy}
        pendingAction={pendingAction}
        recommendations={recommendations}
        onStartSession={onStartSession}
      />
    </section>
  );
}
