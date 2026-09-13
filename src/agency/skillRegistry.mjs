const definitions = [
  { id: 'network-health-summary', name: 'Network health', description: 'Summarize the current observation, coverage, and service events.', requiredInputs: [], outputType: 'Network summary', tools: ['network_overview', 'anomaly_scan'] },
  { id: 'disruption-triage', name: 'Disruption triage', description: 'Collect service events and their source evidence for one route.', requiredInputs: ['routeId'], outputType: 'Route evidence', tools: ['realtime_status', 'service_alerts'] },
  { id: 'rider-communication', name: 'Rider information', description: 'Turn a selected event into a channel-specific draft for human review.', requiredInputs: ['eventId', 'channel'], outputType: 'Rider draft', tools: ['draft_rider_message'] },
  { id: 'headway-control-advisor', name: 'Headway control', description: 'Reserved for a future external operations model. No model is installed.', requiredInputs: ['routeId', 'controlModel'], outputType: 'Control recommendation', tools: [], source: 'external', status: 'unavailable' },
]

export function createSkillRegistry() {
  const skills = definitions.map((item) => ({ version: '1.0', source: 'vigo', status: 'ready', enabled: item.status !== 'unavailable', ...item }))
  return {
    list: () => structuredClone(skills),
    setEnabled(id, enabled) {
      const skill = skills.find((item) => item.id === id)
      if (!skill) throw new Error('Unknown skill.')
      if (skill.status !== 'ready') throw new Error('This integration is not installed.')
      if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean.')
      skill.enabled = enabled
      return { ...skill }
    },
    async run(id, input, callTool) {
      const skill = skills.find((item) => item.id === id)
      if (!skill || !skill.enabled || skill.status !== 'ready') throw new Error('This skill is unavailable or disabled.')
      for (const key of skill.requiredInputs) if (!input?.[key]) throw new Error(`${key} is required.`)
      const results = []
      for (const tool of skill.tools) results.push({ tool, result: await callTool(tool, input ?? {}) })
      return { skill: { ...skill }, results }
    },
  }
}
