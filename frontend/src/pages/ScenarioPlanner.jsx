import { useScenario } from '../hooks/useScenario'
import ScenarioWizard from '../components/scenario/ScenarioWizard'
import ScenarioChat from '../components/scenario/ScenarioChat'
import ScenarioViewer from '../components/scenario/ScenarioViewer'

export default function ScenarioPlanner() {
  const scenario = useScenario()

  // No active session → show wizard
  if (!scenario.sessionId && scenario.stage === null) {
    return (
      <main className="flex flex-col flex-1 min-h-0">
        <ScenarioHeader />
        <ScenarioWizard onGenerate={scenario.beginGeneration} />
      </main>
    )
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
          {scenario.scenarioCategory && (
            <span className="text-xs text-muted bg-surface-2 border border-border rounded px-2 py-0.5">
              {scenario.scenarioCategory === 'earliest_ship' ? '→ earliest ship' : '◎ target date'}
            </span>
          )}
        </div>
        <button
          onClick={scenario.dismiss}
          title="Dismiss and start a new scenario"
          className="text-xs text-muted hover:text-foreground border border-border rounded px-3 py-1.5 transition-colors"
        >
          ← New scenario
        </button>
      </div>

      {/* Discussion chat — only shown post-generation */}
      {(scenario.stage === 'discussion' || scenario.stage === 'generation_failed') && (
        <ScenarioChat
          messages={scenario.messages}
          stage={scenario.stage}
          showEscape={false}
          sending={scenario.sending}
          isGenerating={false}
          error={scenario.error}
          onSend={scenario.sendMessage}
          onRetry={scenario.retryGeneration}
          pendingAction={scenario.pendingAction}
          applyingAction={scenario.applyingAction}
          onApplyAction={scenario.applyAction}
          onDismissAction={scenario.dismissAction}
        />
      )}

      {/* Data viewer — always shown when session exists */}
      <ScenarioViewer
        products={scenario.products}
        assets={scenario.assets}
        work={scenario.work}
        isGenerating={scenario.isGenerating}
        hasData={scenario.hasData}
        generationMode={scenario.generationMode}
        preflightWarnings={scenario.preflightWarnings}
      />

      {/* Action bar */}
      <div className="flex items-center justify-between px-6 py-3 border-t border-border shrink-0">
        <span />
        <div className="flex items-center gap-2">
          <DisabledButton label="Export to CSV" />
          <DisabledButton label="Write to Source" />
        </div>
      </div>
    </main>
  )
}


function ScenarioHeader() {
  return (
    <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
      <span className="text-foreground font-semibold text-sm">◈ Scenario Planner</span>
    </div>
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
      <a href="/estimates" className="text-sm text-accent hover:text-accent/80 transition-colors">
        Go to Estimates →
      </a>
    </main>
  )
}
