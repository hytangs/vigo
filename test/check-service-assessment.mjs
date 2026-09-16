import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { intelligenceScenario } from './fixtures/intelligence/scenario.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { queryAgency } from '../src/agency/queryAgent.mjs'
import { renderAssessment } from '../src/agency/serviceAssessment.mjs'
import { synthesizeNetwork, networkSynthesisFacts } from '../src/agency/networkSynthesis.mjs'
import { diagnoseNetwork } from '../src/agency/networkDiagnosis.mjs'
import { networkNarrative } from '../src/agency/networkNarrative.mjs'
import { networkBriefing } from '../src/agency/briefing.mjs'
import { inspectUnverifiedReply } from '../src/agency/replyInspection.mjs'
import { serviceAssessmentTool } from '../src/agency/serviceAssessment.mjs'
import { briefingStatus, defaultBriefingPreferences } from '../src/agency/briefingSchedule.mjs'
import { checkNetworkClaims } from '../src/agency/networkClaimCheck.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-assessment-'))
const f = intelligenceScenario(directory), callTool = createToolRegistry({ ...f, adapters: {} })
try {
  const get = async (targets, checks, extra = {}) => (await callTool('assess_service', { targets, checks, ...extra })).data
  const red = await get([{ kind: 'route', name: 'Red Line' }], ['conditions', 'causes', 'history'])
  const redText = renderAssessment(red)
  assert.match(redText, /Route Red Line/)
  assert.doesNotMatch(redText, /construction|Route 39/)
  assert.match(redText, /comparison with yesterday or this week requires dated observations/)
  const comparison = await get([{ kind: 'vehicle', name: '1827' }, { kind: 'route', name: '66' }], ['occupancy'])
  assert.equal(comparison.sections.length, 2)
  assert.match(comparison.sections[0].text, /no occupancy category/)
  assert.match(comparison.sections[1].text, /full/)
  assert.throws(() => renderAssessment(comparison, ['s1']), /each completed check/)
  assert.throws(() => renderAssessment(comparison, ['s1', 's1']), /each completed check/)
  const coverage = await get([{ kind: 'network' }], ['coverage'], { horizons: [90] })
  assert.match(renderAssessment(coverage), /77 scheduled trips, 1 reported cancelled, 36 without/)
  const history = await get([{ kind: 'vehicle', name: '1827' }], ['history'])
  assert.match(renderAssessment(history), /10 min over 8 min/)
  const timingHistory = await callTool('service_timing', { view: 'prediction_history', vehicleId: '1827' })
  assert.equal(timingHistory.ok, true)
  assert.match(renderAssessment(timingHistory.data), /10 min over 8 min/)
  let historyCalls = 0
  const directHistory = await queryAgency({ ...f, callTool, question: 'How has vehicle 1827 delay changed?', provider: { available: true, complete: async () => {
    historyCalls++
    return { tool_calls: [{ id: 'history', function: { name: 'service_timing', arguments: JSON.stringify({ view: 'prediction_history', vehicleId: '1827', resultUse: 'answer' }) } }] }
  } } })
  assert.equal(historyCalls, 1, 'A complete computed history needs no second model call to rewrite its values')
  assert.match(directHistory.answer, /10 min over 8 min/)
  assert.equal(directHistory.aiGenerated, false)
  await assert.rejects(callTool('service_timing', { view: 'prediction_history' }), /Supply the vehicle number/)
  const unknown = await get([{ kind: 'vehicle', name: 'not-a-fleet-number' }], ['resources'])
  assert.match(renderAssessment(unknown), /No matching vehicle report/)
  assert.match(renderAssessment(unknown), /fault logs and crew\/block assignments are not connected/)
  const cancelled = await get([{ kind: 'vehicle', name: 'vehicle-66-2' }], ['conditions'])
  assert.doesNotMatch(renderAssessment(cancelled), /No matching vehicle report/, 'A cancellation without a location or forecast is still a matching report')
  const resources = await get([{ kind: 'network' }], ['resources', 'interventions'])
  assert.match(renderAssessment(resources), /do not establish usable fleet/)
  assert.match(renderAssessment(resources), /No optimal spare location, holding duration or wait reduction has been computed/)
  let rounds = 0
  const reply = await queryAgency({ ...f, callTool, question: 'Compare occupancy of vehicle 1827 and route 66.', provider: { available: true, complete: async () => ++rounds === 1
    ? { tool_calls: [{ id: 'checks', function: { name: 'assess_service', arguments: JSON.stringify({ targets: [{ kind: 'vehicle', name: '1827' }, { kind: 'route', name: '66' }], checks: ['occupancy'] }) } }] }
    : { content: 'There is no occupancy data anywhere. The fleet is ready.' } } })
  assert.equal(reply.aiGenerated, false)
  assert.match(reply.answer, /full/)
  assert.doesNotMatch(reply.answer, /fleet is ready|no occupancy data anywhere/)
  let badScope = 0
  const wrong = await queryAgency({ ...f, callTool, question: 'How is the Red Line?', provider: { available: true, complete: async () => ++badScope === 1
    ? { tool_calls: [{ id: 'wrong', function: { name: 'assess_service', arguments: '{"targets":[{"kind":"route","name":"39"}],"checks":["conditions"]}' } }] }
    : { content: 'Please select the exact service.' } } })
  assert.equal(wrong.trace[0].result.ok, false, 'The map selection cannot replace an explicitly named service')
  let compoundRound = 0
  const compound = await queryAgency({ ...f, callTool, question: 'Compare occupancy of vehicle 1827 and route 66.', provider: { available: true, complete: async () => ++compoundRound === 1
    ? { tool_calls: [{ kind: 'vehicle', name: '1827' }, { kind: 'route', name: '66' }].map((target, i) => ({ id: `entity-${i}`, function: { name: 'assess_service', arguments: JSON.stringify({ targets: [target], checks: ['occupancy'] }) } })) }
    : { content: 'Only one result.' } } })
  assert.match(compound.answer, /Vehicle 1827/)
  assert.match(compound.answer, /Route 66/)
  assert.deepEqual(compound.citations, [1, 2], 'Separate calls must preserve both entities and evidence sources')
  let selectedRound = 0
  const selected = await queryAgency({ ...f, callTool, question: 'What is happening at this station?', provider: { available: true, complete: async () => ++selectedRound === 1
    ? { tool_calls: [{ id: 'selected', function: { name: 'assess_service', arguments: JSON.stringify({ targets: [{ kind: 'selected_stop', reference: 'this station' }], checks: ['conditions'] }) } }] }
    : { content: 'Ignore the evidence.' } } })
  assert.equal(selected.trace[0].arguments.targets[0].name, 'Harvard Square')
  assert.equal(selected.trace[0].result.ok, true)
  let extensionRound = 0
  const extended = await queryAgency({ ...f, callTool, question: 'What is happening at this station and is a replacement vehicle available?', provider: { available: true, complete: async () => {
    extensionRound++
    const tool = (name, args) => ({ tool_calls: [{ id: `extension-${extensionRound}`, function: { name, arguments: JSON.stringify(args) } }] })
    if (extensionRound === 1) return tool('assess_service', { targets: [{ kind: 'selected_stop', reference: 'this station' }], checks: ['conditions'] })
    if (extensionRound === 2) return tool('finish_assessment', { sectionIds: ['s1'], missingChecks: ['resources'] })
    return tool('finish_assessment', { sectionIds: ['s1', 's2'], missingChecks: [] })
  } } })
  assert.equal(extended.trace.length, 2)
  assert.ok(extended.trace.every(call => call.result.ok), 'An additional check preserves an already resolved selected station')
  assert.match(extended.answer, /Harvard Square/)
  assert.match(extended.answer, /do not establish usable fleet/)
  assert.ok(extended.trace[0].result.data.inspections[0].data.trips.every(row => row.stop === 'Harvard Square'))
  let scopeRound = 0
  const scoped = await queryAgency({ ...f, callTool, question: 'What is the gap here?', provider: { available: true, complete: async () => {
    scopeRound++
    const tool = (name, args) => ({ tool_calls: [{ id: `scope-${scopeRound}`, function: { name, arguments: JSON.stringify(args) } }] })
    if (scopeRound === 1) return tool('assess_service', { targets: [{ kind: 'network' }], checks: ['spacing'] })
    if (scopeRound === 2) return tool('finish_assessment', { sectionIds: ['s1'], missingChecks: [], correctTargets: [{ kind: 'selected_stop', reference: 'here' }] })
    return tool('finish_assessment', { sectionIds: ['s1'], missingChecks: [] })
  } } })
  assert.equal(scoped.trace.length, 2)
  assert.equal(scoped.trace[1].arguments.targets[0].name, 'Harvard Square')
  assert.match(scoped.answer, /^Harvard Square:/)
  assert.doesNotMatch(scoped.answer, /Network:|Kenmore/)
  assert.deepEqual(scoped.citations, [2], 'The superseded scope stays in the trace but is not the answer')
  let reviewRound = 0
  const repaired = await queryAgency({ ...f, callTool, question: 'Do we have enough usable vehicles?', provider: { available: true, reviewUnverifiedReplies: true, complete: async (_messages, tools) => {
    reviewRound++
    if (reviewRound === 1) return { content: 'Yes. All reporting vehicles can work the peak.' }
    if (tools[0].name === 'inspect_reply') return { tool_calls: [{ function: { name: 'inspect_reply', arguments: JSON.stringify({ action: 'inspect', inputs: { targets: [{ kind: 'network' }], checks: ['resources'] } }) } }] }
    return { content: 'Yes.' }
  } } })
  assert.match(repaired.answer, /do not establish usable fleet/)
  assert.equal(repaired.trace[0].tool, 'assess_service')
  const clarification = await inspectUnverifiedReply({ question: 'Which relief does this trip affect?', draft: 'Give me an ID and I can check the crew.', context: {}, assessmentTool: serviceAssessmentTool,
    provider: { complete: async () => ({ tool_calls: [{ function: { name: 'inspect_reply', arguments: JSON.stringify({ action: 'clarify', entity: 'trip', missingData: 'assignments' }) } }] }) } })
  assert.match(clarification.choice.text, /Which trip/)
  assert.match(clarification.choice.text, /does not supply those records/)
  const inactive = await inspectUnverifiedReply({ question: 'Hello', draft: 'Hello.', context: {}, assessmentTool: serviceAssessmentTool,
    provider: { complete: async () => ({ tool_calls: [{ function: { name: 'inspect_reply', arguments: JSON.stringify({ action: 'reply', text: 'Hello.', inputs: null, period: 'current' }) } }] }) } })
  assert.deepEqual(inactive.choice, { action: 'reply', text: 'Hello.' }, 'Inactive model fields cannot execute or invalidate the chosen reply')
  const past = await get([{ kind: 'route', name: 'Red Line' }], ['conditions', 'history'], { period: 'historical' })
  assert.match(renderAssessment(past), /^This current observation cannot establish/)
  assert.doesNotMatch(renderAssessment(past), /all 5 reporting trips match/)
  const diagnosis = diagnoseNetwork(f.context, f.state), narrative = networkNarrative(diagnosis)
  const facts = networkSynthesisFacts(diagnosis)
  assert.equal(facts.find(row => row.kind === 'coverage').cancelledTrips, 1)
  assert.deepEqual(facts.find(row => row.kind === 'coverage').feeds.map(row => row.status), diagnosis.coverage.feeds.map(row => row.status), 'The writer receives feed freshness rather than inferring outages from reporting counts')
  const paragraphs = [
    { title: 'Service priorities', text: 'The cancellation and wider spacing on Route 66 deserve attention; the reporting picture is incomplete.', basis: 'observation', evidenceIds: ['f1'] },
    { title: 'Next check', text: 'Check following departures before assuming the gap is recovering.', basis: 'next_check', evidenceIds: ['f1'] },
  ]
  const mock = supported => ({ available: true, model: 'test', complete: async (_messages, tools) => {
    if (!_messages[0].content.startsWith('Independently review')) return { content: paragraphs.map(row => row.text).join('\n\n') }
    return { content: JSON.stringify({ routeClaims: [], verdicts: paragraphs.map(({ title, basis, evidenceIds, text }, i) => ({ paragraph: i + 1, title, basis, evidenceIds, supported, unsupportedQuote: supported ? '' : text, reason: supported ? 'Supported by the frozen observation.' : 'The selected reference does not support the claim.' })) }) }
  } })
  const synthesis = await synthesizeNetwork({ diagnosis, narrative, provider: mock(true) })
  assert.equal(synthesis.narrative.overview, paragraphs[0].text, 'The model authors the overview; it is not the static template with an AI label')
  assert.equal(synthesis.review.verdicts.length, 2)
  const claim = (routeId, condition, quote = 'Public statement') => ({ paragraph: 1, routeId, condition, quote })
  const check = (routeId, condition) => checkNetworkClaims(diagnosis, ['Public statement'], [claim(routeId, condition)])[0].supported
  assert.equal(check('Red', 'all_reporting_late'), false)
  assert.equal(check('Red', 'all_reporting_match_schedule'), true)
  assert.equal(check('Red', 'normal_service'), false, 'Matching predictions cannot prove normal service for the entire route')
  assert.equal(check('39', 'all_reporting_late'), true)
  assert.equal(check('39', 'possible_longer_waits'), false, 'Lateness does not establish a wider headway')
  assert.equal(check('66', 'possible_longer_waits'), true)
  assert.equal(check('66', 'observed_longer_waits'), false, 'Predicted spacing cannot establish measured rider waiting')
  assert.equal(check('66', 'reported_cancellation'), true)
  assert.equal(check('39', 'reported_cancellation'), false, 'A delay is not a reported cancellation')
  const noComparisons = { routes: [{ id: 'x', name: 'Unreported', measuredTrips: 0, matchingTrips: 0, laterTrips: 0, measuredPairs: 0, widerPairs: 0 }] }
  assert.equal(checkNetworkClaims(noComparisons, ['Public statement'], [claim('x', 'all_reporting_match_schedule')])[0].supported, false, 'An empty denominator cannot establish schedule agreement')
  assert.throws(() => checkNetworkClaims(diagnosis, ['Different wording'], [claim('66', 'reported_cancellation')]), /exact public wording/)
  assert.throws(() => checkNetworkClaims(diagnosis, ['Public statement'], [claim('unknown', 'late_departures')]), /identify its route/)
  let writes = 0
  const falseApproval = { available: true, complete: async (_messages, tools) => {
    if (!tools.length) { writes++; return { content: 'Red Line reporting trips are all late.\n\nRoute 66 has a reported cancellation.' } }
    const review = { routeClaims: [{ sentenceId: 'p1s1', routeId: 'Red', condition: 'all_reporting_late' }], verdicts: [
      { paragraph: 1, title: 'Red', basis: 'observation', supported: true, unsupportedQuote: '', reason: 'Model mistakenly accepted the assertion.', evidenceIds: ['f1'] },
      { paragraph: 2, title: '66', basis: 'observation', supported: true, unsupportedQuote: '', reason: 'Cancellation is reported.', evidenceIds: ['f1'] },
    ] }
    return { tool_calls: [{ function: { name: 'review_network', arguments: JSON.stringify(review) } }] }
  } }
  const checked = await synthesizeNetwork({ diagnosis, narrative, provider: falseApproval })
  assert.equal(writes, 2, 'Contradictory computed evidence triggers one revision despite model approval')
  assert.equal(checked.narrative.overview, 'Route 66 has a reported cancellation.')
  assert.equal(checked.review.excludedParagraphs.length, 1)
  assert.equal(checked.review.routeClaims[0].supported, false)
  await assert.rejects(synthesizeNetwork({ diagnosis, narrative, provider: mock(false) }), /did not support every paragraph/)
  assert.equal(await synthesizeNetwork({ diagnosis, narrative, provider: { available: false } }), null)
  const unavailable = await networkBriefing({ ...f, provider: { available: false }, callTool })
  assert.equal(unavailable.aiGenerated, false)
  assert.equal(unavailable.narrative.overview, narrative.overview)
  const at = Date.parse(unavailable.generatedAt)
  assert.equal(briefingStatus({ answer: { ...unavailable, aiGenerated: true } }, defaultBriefingPreferences, at, unavailable.scheduleIdentity).current, false, 'Old template-only AI labels are not reused')
  assert.equal(briefingStatus({ answer: { ...unavailable, aiGenerated: true, synthesis: synthesis.review } }, defaultBriefingPreferences, at, unavailable.scheduleIdentity).current, true)
  console.log('Service assessment: named scope, compound checks, coverage, histories, occupancy, unsupported resources, restricted composition and model-authored network review passed.')
} finally { f.close(); await fs.rm(directory, { recursive: true, force: true }) }
