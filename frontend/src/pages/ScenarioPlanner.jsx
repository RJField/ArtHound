import { useScenario } from '../hooks/useScenario'
import ScenarioChat from '../components/scenario/ScenarioChat'
import ScenarioViewer from '../components/scenario/ScenarioViewer'

export default function ScenarioPlanner() {
  const scenario = useScenario()

  if (scenario.error === 'matrix_missing') {
    return <MatrixMissingGate />
  }

  return (
    <main className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-foreground font-semibold text-sm">◈ Scenario Planner</span>
          {scenario.stage === 'discussion' && scenario.hasData && (
            <span className="text-xs text-muted bg-surface-2 border border-border rounded px-2 py-0.5">
              {scenario.work.length} work items
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Saved Scenarios — future feature */}
          <button
            disabled
            title="Saved scenarios are coming in a future update"
            className="text-xs text-muted border border-border rounded px-3 py-1.5 opacity-40 cursor-not-allowed"
          >
            Saved Scenarios ▾
          </button>
        </div>
      </div>

      {/* Chat */}
      <ScenarioChat
        messages={scenario.messages}
        stage={scenario.stage}
        showEscape={scenario.showEscape}
        sending={scenario.sending}
        isGenerating={scenario.isGenerating}
        error={scenario.error}
        onSend={scenario.sendMessage}
        onForceGenerate={scenario.forceGenerate}
        onRetry={scenario.retryGeneration}
      />

      {/* Data viewer */}
      <ScenarioViewer
        products={scenario.products}
        assets={scenario.assets}
        work={scenario.work}
        isGenerating={scenario.isGenerating}
        hasData={scenario.hasData}
      />

      {/* Action bar */}
      <div className="flex items-center justify-between px-6 py-3 border-t border-border shrink-0">
        <button
          onClick={scenario.dismiss}
          disabled={scenario.starting}
          className="text-sm text-muted hover:text-foreground border border-border rounded px-4 py-2 transition-colors disabled:opacity-40"
        >
          Dismiss
        </button>
        <div className="flex items-center gap-2">
          <DisabledButton label="Export to CSV" />
          <DisabledButton label="Write to Source" />
        </div>
      </div>
    </main>
  )
}

function DisabledButton({ label }) {
  return (
    <button
      disabled
      title="Available in a future update"
      className="text-sm text-muted border border-border rounded px-4 py-2 opacity-40 cursor-not-allowed"
    >
      {label}
    </button>
  )
}

function MatrixMissingGate() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8">
      <p className="text-foreground font-medium">Estimation matrix required</p>
      <p className="text-muted text-sm max-w-sm">
        Scenario planning uses your estimation matrix to generate realistic work estimates.
        Set up your matrix in Estimates before using this feature.
      </p>
      <a
        href="/estimates"
        className="text-sm text-accent hover:text-accent/80 transition-colors"
      >
        Go to Estimates →
      </a>
    </main>
  )
}
