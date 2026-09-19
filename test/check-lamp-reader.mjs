import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readLampStudy } from '../src/agency/lampStudy.mjs'
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-lamp-'))
try {
  assert.equal((await readLampStudy(directory)).status, 'not_installed')
  await fs.mkdir(path.join(directory, 'lamp'))
  const file=path.join(directory,'lamp','study.json')
  await fs.writeFile(file,'{}')
  await assert.rejects(readLampStudy(directory),/incomplete/)
  const metric={cases:8,maeSeconds:12,p90AbsoluteErrorSeconds:24,biasSeconds:2}
  const study={version:1,dataset:'MBTA LAMP subway performance',generatedAt:'2026-09-14T12:00:00Z',range:{start:'2026-09-01',trainEnd:'2026-09-03',end:'2026-09-05'},comparison:{coverage:.8,scoredTestSegments:8,eligibleTestSegments:10,historical:metric,scheduled:{...metric,maeSeconds:30}},routes:[{routeId:'R',historical:metric,scheduled:metric}],segments:[{routeId:'R',directionId:0,fromName:'Alpha',toName:'Beta',historical:metric,scheduled:metric,predictedSeconds:120,scheduledSeconds:150}],sources:{index:'https://performancedata.mbta.com/',archiveCatalog:'https://cdn.mbta.com/archive/archived_feeds.txt',dictionary:'https://github.com/mbta/lamp/blob/main/Data_Dictionary.md'},limits:['Retrospective'],filters:{inputRows:20,eligibleSegments:12}}
  await fs.writeFile(file,JSON.stringify(study))
  const all=await readLampStudy(directory)
  assert.equal(all.status,'available'); assert.equal(all.rows.length,1)
  assert.deepEqual(all.comparison,study.comparison)
  const absent=await readLampStudy(directory,{routeIds:['Other']})
  assert.equal(absent.status,'route_not_covered'); assert.deepEqual(absent.rows,[])
  assert.equal(absent.comparisonScope,'Entire study, before route filtering','Route selection cannot relabel whole-study accuracy')
  assert.deepEqual(absent.comparison,study.comparison)
  const limited=await readLampStudy(directory,{limit:0})
  assert.equal(limited.rows.length,0); assert.equal(limited.totalSegments,1)
  await fs.writeFile(file,' '.repeat(8_000_001))
  await assert.rejects(readLampStudy(directory),/size/)
} finally { await fs.rm(directory,{recursive:true,force:true}) }
console.log('LAMP report: missing/corrupt/oversized studies, exact route selection, conditional coverage and study-wide metric scope passed.')
