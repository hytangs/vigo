import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAddressIndexWriter, openAddressIndex, rankAddressResults } from '../src/server/address-index.mjs'
import { openAddressIndexWorker } from '../src/server/address-index-worker.mjs'
import { searchAddresses } from '../src/server/address-search.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-address-index-'))
const bounds = [-123,47,-122,48], center = [-122.33,47.60]
const file = path.join(root, 'addresses.sqlite')
let index, clipped
try {
  const writer = createAddressIndexWriter(file, { name: 'Seattle', bounds })
  const point = (properties, coordinate = [-122.3493,47.6205]) => writer.add({ properties, geometry: { type: 'Point', coordinates: coordinate } })
  point({name:'Space Needle',tourism:'attraction'})
  point({name:'Space Needle',tourism:'attraction','addr:housenumber':'400','addr:street':'Broad Street','addr:city':'Seattle'},[-122.3494,47.6206])
  point({name:'Space Needle of Renton','addr:city':'Renton'},[-122.218,47.490])
  point({name:'Space Needle Loop',highway:'footway'})
  point({'addr:housenumber':'4000','addr:street':'Broad Street','addr:city':'Seattle'})
  point({name:'Seattle Public Library','addr:street':'4th Avenue','addr:housenumber':'1000','addr:city':'Seattle'})
  point({name:'Metropolitan Institute of Technology',amenity:'university'})
  point({name:'MIT Museum',tourism:'museum'})
  point({name:'Art Museum',railway:'station'})
  point({name:'Art Museum',tourism:'museum','addr:street':'Art Street','addr:housenumber':'1'})
  point({name:'Pennsylvania Terminal',alt_name:'Penn Station',railway:'station'})
  point({name:'Outside landmark'},[-71,42])
  writer.add({properties:{'addr:housenumber':'12','addr:street':'Tiny Lane'},geometry:{type:'Polygon',coordinates:[[[-122.3,47.6],[-122.2999,47.6],[-122.2999,47.6001],[-122.3,47.6001],[-122.3,47.6]]]}})
  const metadata = writer.finish()
  assert.equal(metadata.count,12,'The index excludes features outside the City bounds')
  index = openAddressIndex(file, { bounds, center, name:'Seattle' })
  const exact = index.search('Space Needle')
  assert.equal(exact[0].label,'Space Needle')
  assert.match(exact[0].detail,/400 Broad Street/,'Duplicate places retain the complete address')
  assert.equal(exact.filter(r=>r.label==='Space Needle').length,1,'Nearby node/area duplicates collapse')
  assert.equal(index.search('Spa Nee')[0].label,'Space Needle','Partial tokens autocomplete without a remote lookup')
  assert.equal(index.search('Spcae Needle')[0].label,'Space Needle','A transposed letter still finds the place')
  assert.equal(index.search('SPL')[0].label,'Seattle Public Library','Place initials are searchable')
  assert.equal(index.search('MIT')[0].label,'Metropolitan Institute of Technology','Exact initials precede places merely starting with the abbreviation')
  assert.equal(index.search('Penn Station')[0].label,'Pennsylvania Terminal','An exact alternate name ranks as highly as the official name')
  const museum = index.search('Art Museum')
  assert.equal(museum[0].kind,'place','The landmark precedes its namesake station')
  assert(museum.some(item=>item.kind==='station'&&item.detail.startsWith('Transit stop')),'A nearby station remains a distinct, labelled destination')
  const address = index.search('400 Broad St')
  assert.equal(address.length,1,'A numbered street search never substitutes house 4000 for 400')
  assert.equal(address[0].label,'400 Broad Street')
  assert.equal(index.search('1000 4th Ave Seattle')[0].label,'1000 4th Avenue','Street abbreviations and a City suffix match')
  const tiny = index.search('12 Tiny Lane')[0].coordinate
  assert(Math.abs(tiny[0]+122.29995)<1e-8&&Math.abs(tiny[1]-47.60005)<1e-8,'Small building centroids retain coordinate precision')
  assert.deepEqual(index.search('notaplace" OR *'),[],'Untrusted query syntax cannot broaden the FTS expression')
  clipped = openAddressIndex(file,{bounds:[-122.25,47.45,-122.2,47.5],center})
  assert.equal(clipped.search('Space Needle').length,1,'The reader independently applies its configured region bounds')
  const local = await searchAddresses('Space Needle',bounds,{index,center,fetcher:()=>{throw Error('Must not call geocoder')}})
  assert.equal(local.source,'local')
  assert.equal(local.results[0].label,'Space Needle')
  const threaded = openAddressIndexWorker(file,{bounds,center,name:'Seattle'})
  try {
    assert.deepEqual(await threaded.search('Space Needle'),index.search('Space Needle'),'The worker returns the same ranked results')
    const cancel = new AbortController()
    const leaving = threaded.search('Broad',{signal:cancel.signal})
    const staying = threaded.search('Art Museum')
    cancel.abort()
    await assert.rejects(leaving,{name:'AbortError'})
    assert.deepEqual(await staying,index.search('Art Museum'),'A cancelled caller does not disturb the next lookup')
    const viaSearch = await searchAddresses('Space Needle',bounds,{index:threaded,center,fetcher:()=>{throw Error('Must not call geocoder')}})
    assert.equal(viaSearch.source,'local')
  } finally { threaded.close() }
  const late = openAddressIndexWorker(file,{bounds,center,name:'Seattle'},{deadlineMs:0})
  try { assert.deepEqual(await late.search('Space Needle'),[],'A lookup past its deadline counts as no local match') } finally { late.close() }
  assert.throws(()=>openAddressIndexWorker(path.join(root,'missing.sqlite'),{bounds}),'An unusable index stops startup')
  let fallbackCalls=0
  const fallback = await searchAddresses('Unmapped landmark',bounds,{index,center,endpoint:'https://index-test.example/api/',fetcher:async()=>{fallbackCalls++;return{ok:true,json:async()=>({features:[]})}}})
  assert.equal(fallback.source,'photon');assert.equal(fallbackCalls,1,'A missing local place can still use the bounded provider')
  assert.deepEqual(rankAddressResults([{label:'Wrong house',address:'4000 Broad Street',coordinate:center}], '400 Broad St'),[])
  assert.equal(rankAddressResults([{label:'Central Park West',address:'Central Park West',coordinate:center},{label:'Central Park',coordinate:center}], 'Central Park')[0].label,'Central Park','Street metadata cannot outrank an exact landmark name')
  assert.equal(rankAddressResults([{label:'Penn Station Eagle',kind:'place',coordinate:center},{label:'New York Penn Station',kind:'station',coordinate:center}], 'Penn Station')[0].label,'New York Penn Station','A station search prefers the station over a namesake landmark')
  console.log('Address index: prefixes, typos, abbreviations, initials, house numbers, deduplication, precise coordinates, region isolation, query safety, and local/provider dispatch passed.')
} finally { index?.close();clipped?.close();await fs.rm(root,{recursive:true,force:true}) }
