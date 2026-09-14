import { realizeInvestigation } from '../src/agency/briefingInterpretation.mjs'
import assert from 'node:assert/strict'
import { investigateBriefing } from '../src/agency/briefingInvestigation.mjs'
import { inspectService } from '../src/agency/serviceInvestigationEvidence.mjs'

const diagnosis = { generatedAt: '2026-09-14T12:00:00Z', timezone: 'Etc/UTC', window: {to:1789389000}, network: {measuredTrips:10,laterTrips:5,medianDeviationSeconds:60,p90DeviationSeconds:600,cancelledTrips:0}, coverage:{measuredRoutes:3,unknownTrips:5}, routes:[{id:'R',name:'River',laterTrips:3},{id:'S',name:'Station',laterTrips:2}], limits:['No actual progression is established.'], concentrations:[{id:'area',name:'Shared stop',routeIds:['R','S'],stopIds:['A','B'],tripCount:3,maxDelaySeconds:600}] }
const narrative={overview:'Computed overview',sections:[{id:'area',title:'Shared stop',routeIds:['R','S'],text:'Computed observation'}],elsewhere:'',coverage:'Coverage'}
const plan={focusId:'area',hypotheses:['localized_corridor_disruption','independent_late_trips'],checks:['surrounding_service']}
// Fact 1 is a missing-notice limitation; facts 2/3 are measured prediction comparisons.
const response={rankedHypotheses:[{hypothesis:'independent_late_trips',status:'plausible',supportingEvidenceIds:[2,3],conflictingEvidenceIds:[]}],watchNext:'follow_same_trips'}
const message=(name,args)=>({tool_calls:[{function:{name,arguments:JSON.stringify(args)}}]})
const providerFor = (draft=response, proposed=plan) => ({available:true,model:'fixture',complete:async (_messages,tools,_signal,options)=>{
  assert.equal(options.toolChoice.function.name,tools[0].name)
  return message(tools[0].name,tools[0].name==='plan_investigation'?proposed:draft)
}})
let calls=[]
const evidence = {
  alerts:{sourceAvailable:true,matchingNotices:0,notices:[]},
  prediction_progression:{trips:[{routeId:'R',upstreamDelayMinutes:10,entryDelayMinutes:10,predictedChangeWithinAreaMinutes:0}],totalTrips:1},
  surrounding_service:{areaDefined:true,inside:{trips:2,late:2},outside:{trips:8,late:4}},
}
const callTool=async(name,args)=>{calls.push({name,args});return{ok:true,data:evidence[args.aspect],provenance:['fixture:source'],generatedAt:diagnosis.generatedAt,warnings:[]}}
const result=await investigateBriefing({diagnosis,narrative,provider:providerFor(),callTool})
assert.deepEqual(calls.map(call=>call.args.aspect),['alerts','prediction_progression','surrounding_service'])
assert.ok(calls.every(call=>call.name==='inspect_service'&&call.args.routeIds.join()==='R,S'))
assert.deepEqual(result.explanation.evidenceIds,[2,3])
assert.deepEqual(result.narrative,narrative,'Model ranking cannot rewrite computed numerical observations')
assert.match(result.explanation.text,/River.*10 minutes/)
assert.equal(result.facts[0].usableForAssessment,false,'No notice is not evidence against an incident')
for (const invalid of [ {...plan,focusId:'other-city'}, {...plan,hypotheses:['accident']}, {...plan,checks:['shell']}, {...plan,checks:Array(3).fill('surrounding_service')} ]) {
  calls=[]
  await assert.rejects(investigateBriefing({diagnosis,narrative,provider:providerFor(response,invalid),callTool}))
  assert.equal(calls.length,0,'Invalid plans must execute no tools')
}
const ranking = response.rankedHypotheses[0]
for (const row of [ {...ranking,supportingEvidenceIds:[99]}, {...ranking,supportingEvidenceIds:[1]}, {...ranking,status:'confirmed'}, {...ranking,confidence:.68}, {...ranking,hypothesis:'terminal_or_dispatch_issue'}, {...ranking,supportingEvidenceIds:[]}, {...ranking,conflictingEvidenceIds:[2]} ]) {
  await assert.rejects(investigateBriefing({diagnosis,narrative,provider:providerFor({...response,rankedHypotheses:[row]}),callTool}),error=>{
    assert.equal(error.completedTrace.length,3,'Checked evidence survives an invalid final assessment')
    return true
  })
}
await assert.rejects(investigateBriefing({diagnosis,narrative,provider:providerFor({...response,rankedHypotheses:[ranking,ranking]}),callTool}))
const empty=await investigateBriefing({diagnosis,narrative,provider:{available:false},callTool})
assert.equal(empty,null)
const failed=await investigateBriefing({diagnosis,narrative,provider:providerFor(),callTool:async()=>{throw Error('Unavailable')}})
assert.equal(failed.incomplete,true)
assert.equal(failed.trace.length,3)
const context={routeIndex:new Map([['R',{}]]),stopIndex:new Map([['A',{}]])}
const state={generatedAt:diagnosis.generatedAt,feeds:[],events:[],measurements:{departures:[]}}
const alerts=await inspectService({context,state,snapshot:null},{routeIds:['R'],stopIds:['A'],aspect:'alerts'})
assert.equal(alerts.sourceAvailable,false,'No alert feed is unknown, not evidence that no incident exists')
const notices = {...state,feeds:[{kind:'alerts',status:'fresh'}],events:[
  {type:'service-alert',title:'Elevator unavailable',routeIds:['R'],evidence:{alertEffect:'ACCESSIBILITY_ISSUE'}},
  {type:'service-alert',title:'Traffic delays',routeIds:['R'],evidence:{alertEffect:'SIGNIFICANT_DELAYS'}},
  {type:'service-alert',title:'No effect',routeIds:['R'],evidence:{alertEffect:'NO_EFFECT'}},
  {type:'service-alert',title:'Other route',routeIds:['Other'],evidence:{alertEffect:'SIGNIFICANT_DELAYS'}},
]}
const scoped=await inspectService({context,state:notices},{routeIds:['R'],stopIds:['A'],aspect:'alerts'})
assert.deepEqual(scoped.notices.map(notice=>notice.title),['Traffic delays'],'Access notices cannot explain a vehicle delay; unrelated routes remain separate')
assert.equal(scoped.otherNotices,2)
await assert.rejects(inspectService({context,state},{routeIds:['Other'],aspect:'alerts'}),/this City/)
console.log('Briefing investigation: bounded forms, exact scope, mandatory upstream/notice checks, retained evidence, access-notice separation, unavailable evidence and fabricated confirmations rejected.')

assert.equal(await investigateBriefing({diagnosis:{...diagnosis,network:{...diagnosis.network,laterTrips:0}},narrative,provider:providerFor(),callTool:()=>{throw Error('Unexpected investigation')}}),null, 'No delay hypothesis investigation is needed for an observation without late predictions')

const reordered=realizeInvestigation([{...ranking,hypothesis:'localized_corridor_disruption',status:'weakened'},ranking],result.facts,response.watchNext,narrative)
assert.equal(reordered.explanation.hypothesis,'independent_late_trips','A weakened candidate cannot precede a model-assessed plausible explanation')

assert.equal(reordered.explanation.rankingVerified, false)
assert.doesNotMatch(reordered.explanation.text, /evidence currently favors/)
