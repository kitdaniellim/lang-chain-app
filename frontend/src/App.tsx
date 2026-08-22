import { useEffect, useState } from "react";
import { ApiError, USE_MOCK, getHealth } from "./api/client";
import type { HealthResponse } from "./api/types";
import { AddInvoiceDrawer } from "./components/AddInvoiceDrawer";
import { ChatPanel } from "./components/ChatPanel";
import { HealthChip } from "./components/HealthChip";
import { InvoiceTable } from "./components/InvoiceTable";
import { useInvoiceQuery } from "./lib/useInvoiceQuery";

const HEALTH_POLL_MS = 30_000;

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return "Unexpected error";
}

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);

  const invoices = useInvoiceQuery();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);

  // Poll /health so the database chip stays honest while the app is open.
  useEffect(() => {
    const controller = new AbortController();

    async function poll() {
      try {
        const response = await getHealth(controller.signal);
        if (controller.signal.aborted) return;
        setHealth(response);
        setHealthError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setHealth(null);
        setHealthError(messageOf(cause));
      } finally {
        if (!controller.signal.aborted) setHealthLoading(false);
      }
    }

    void poll();
    const timer = window.setInterval(() => void poll(), HEALTH_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  const llmConfigured = health?.llm_configured ?? false;
  // File import maps columns heuristically without a key, so only an unreachable API blocks the drawer.
  const addDisabledReason = health
    ? null
    : "Adding invoices is unavailable until the API responds to /health.";

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__brand">
          <h1 className="app-header__title">lang-chain-app</h1>
          <p className="app-header__tagline">Invoice extraction and natural-language querying</p>
        </div>
        {USE_MOCK && (
          <p className="health-chip health-chip--warn">
            <span className="health-chip__dot" />
            mock data
          </p>
        )}
        <HealthChip health={health} loading={healthLoading} error={healthError} />
        <button
          type="button"
          className="btn chat-toggle"
          aria-expanded={chatOpen}
          aria-controls="chat-panel"
          onClick={() => setChatOpen((open) => !open)}
        >
          {chatOpen ? "Hide chat" : "Show chat"}
        </button>
      </header>

      <div className="app__body">
        <main className="app__main">
          <InvoiceTable
            invoices={invoices.items}
            total={invoices.total}
            baseTotal={invoices.baseTotal}
            page={invoices.page}
            pageSize={invoices.pageSize}
            loading={invoices.loading}
            error={invoices.error}
            filters={invoices.filters}
            filtersActive={invoices.filtersActive}
            onFilterChange={invoices.setFilter}
            onClearFilters={invoices.clearFilters}
            onPageChange={invoices.setPage}
            onPageSizeChange={invoices.setPageSize}
            onRetry={invoices.refresh}
            onAddInvoice={() => setDrawerOpen(true)}
            addDisabledReason={addDisabledReason}
          />
        </main>

        <div id="chat-panel" className={`chat-column${chatOpen ? "" : " chat--collapsed"}`}>
          <ChatPanel llmConfigured={llmConfigured} model={health?.model ?? null} />
        </div>
      </div>

      <AddInvoiceDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        llmConfigured={llmConfigured}
        onSaved={invoices.refreshAfterSave}
      />
    </div>
  );
}
