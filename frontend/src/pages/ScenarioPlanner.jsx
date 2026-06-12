import { useScenario } from '../hooks/useScenario'
import { Button, Pill } from '../components/ui'
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
            <Pill tone="neutral">{scenario.work.length} work items</Pill>
          )}
          {scenario.scenarioCategory && (
            <Pill tone="neutral">
              {scenario.scenarioCategory === 'earliest_ship' ? '→ earliest ship' : '◎ target date'}
            </Pill>
          )}
        </div>
        <Button onClick={scenario.dismiss} title="Dismiss and start a new scenario">
          ← New scenario
        </Button>
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
        generationStatus={scenario.generationStatus}
      />

      {/* Action bar */}
      <div className="flex items-center justify-between px-6 py-3 border-t border-border shrink-0">
        <span />
        <div className="flex items-center gap-2">
          <Button size="lg" disabled title="Available in a future update">
            Export to CSV
          </Button>
          <Button size="lg" disabled title="Available in a future update">
            Write to Source
          </Button>
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
