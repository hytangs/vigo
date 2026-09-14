import type { QueryAnswer } from '../agency/types'
import { humanField, toolNames } from '../agency/presentation'

export function AgencyRuntimeFacts({ runtime, expanded = false }: { runtime: NonNullable<QueryAnswer['runtime']>; expanded?: boolean }) {
  const connection = runtime.modelConnection
  const called = runtime.networkToolCalls.map(call => `${toolNames[call.tool] || humanField(call.tool)}${call.completed ? '' : ' (incomplete)'}`)
  return <details className="agency-source-details" open={expanded}>
    <summary>Model & data</summary>
    <dl className="agency-facts">
      <div><dt>Model</dt><dd>{connection.model || 'Not recorded'}</dd></div>
      <div><dt>Inference hosting</dt><dd>Not independently verified</dd></div>
      <div><dt>Model endpoint</dt><dd>{connection.endpoint || 'Not recorded'}{connection.transport ? ` · ${connection.transport.toUpperCase()}` : ''}{connection.endpointLocation === 'loopback' ? ' · loopback' : ''}</dd></div>
      <div><dt>External model API</dt><dd>{connection.externalModelApi === 'not-configured-directly' ? 'None configured directly; forwarding is unverified' : connection.externalModelApi === 'unverified' ? 'Not verified; the endpoint may forward requests' : 'Not recorded'}</dd></div>
      <div><dt>Network-capable tools</dt><dd>{runtime.networkTools.length ? runtime.networkTools.map(tool => <div key={tool.tool}>{tool.label}{tool.endpoint ? ` · ${tool.endpoint}` : ''}</div>) : 'None enabled for this answer'}</dd></div>
      <div><dt>Called in this answer</dt><dd>{called.length ? called.join(', ') : 'No network-capable tool calls recorded'}</dd></div>
    </dl>
    <p className="agency-caption">Configuration captured for this answer. Model requests include your question, supplied conversation context and tool results. Tool calls may use cached data. Feed refresh and other application traffic are outside this record. Hosting, forwarding, retention, training use and security are not verified by these settings.</p>
  </details>
}
