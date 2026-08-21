import type { HealthResponse } from "../api/types";

interface HealthChipProps {
  health: HealthResponse | null;
  loading: boolean;
  error: string | null;
}

const DATABASE_LABELS: Record<HealthResponse["database"], string> = {
  postgres: "Postgres",
  sqlite: "SQLite",
};

/** Header chip: backend reachability, database kind, and whether Claude has a key. */
export function HealthChip({ health, loading, error }: HealthChipProps) {
  if (loading && !health) {
    return (
      <p className="health-chip" aria-live="polite">
        <span className="health-chip__dot" />
        <span className="health-chip__muted">Checking API…</span>
      </p>
    );
  }

  if (error || !health) {
    return (
      <p className="health-chip health-chip--bad" aria-live="polite" title={error ?? undefined}>
        <span className="health-chip__dot" />
        <span>API unreachable</span>
      </p>
    );
  }

  const tone = health.llm_configured ? "health-chip--ok" : "health-chip--warn";
  return (
    <p className={`health-chip ${tone}`} aria-live="polite">
      <span className="health-chip__dot" />
      <span>{DATABASE_LABELS[health.database]}</span>
      <span className="health-chip__sep" aria-hidden="true">
        |
      </span>
      <span>
        Claude: {health.llm_configured ? "ready" : "key missing"}
        {health.llm_configured && <span className="health-chip__muted"> ({health.model})</span>}
      </span>
    </p>
  );
}
