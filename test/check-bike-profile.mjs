import assert from 'node:assert/strict'
import { bikeStress } from '../src/server/bike-stress.mjs'
import { DatabaseSync } from 'node:sqlite'
import { bikeDirections, bikeNodeAllowed, bikeAttributes, bikeWayWindows, createBikeWriter } from '../src/server/bike-profile.mjs'
import { weeklyBikeCondition, compileBikeTurnWindows } from '../src/server/bike-conditions.mjs'

// OSM facility directions refer to way geometry, independently of driving side.
// Check access and both consumers of facility quality together.
for (const [extra,directions,facility,stress] of [
  [{oneway:'yes','cycleway:left':'track','cycleway:left:oneway':'-1'},[true,true],[0,2],[4,3]],
  [{oneway:'-1','cycleway:right':'lane','cycleway:right:oneway':'yes'},[true,true],[1,0],[3,4]],
  [{oneway:'-1','cycleway:right':'track','cycleway:right:oneway':'-1'},[false,true],[0,2],[4,3]],
  [{oneway:'yes',cycleway:'opposite_track'},[true,true],[0,2],[4,3]],
  [{oneway:'-1',cycleway:'opposite_track'},[true,true],[2,0],[3,4]],
  [{oneway:'yes',driving_side:'right','cycleway:left':'lane'},[true,false],[1,0],[3,4]],
  [{oneway:'-1',driving_side:'left','cycleway:left':'track'},[false,true],[0,2],[4,3]],
  [{junction:'roundabout','cycleway:left':'lane'},[true,false],[1,0],[3,4]],
  [{'cycleway:both':'lane','cycleway:both:oneway':'yes'},[true,true],[1,0],[3,4]],
  [{'cycleway:both':'track','cycleway:both:oneway':'-1'},[true,true],[0,2],[4,3]],
  [{oneway:'yes','cycleway:both':'track','cycleway:both:oneway':'no'},[true,true],[2,2],[3,3]],
  [{cycleway:'track','cycleway:backward':'no'},[true,true],[2,0],[3,4]],
  [{'cycleway:left':'track'},[true,true],[1,1],[4,4]],
  [{'cycleway:left':'track',driving_side:'left'},[true,true],[2,0],[3,4]],
  [{oneway:'yes','cycleway:left':'shared_lane','cycleway:left:oneway':'-1'},[true,false],[0,1],[4,4]],
  [{oneway:'yes','cycleway:left':'track','cycleway:left:oneway':'-1','oneway:bicycle':'yes'},[true,false],[0,2],[4,3]],
  [{oneway:'yes','cycleway:left':'track','cycleway:left:oneway':'-1','bicycle:backward':'no'},[true,false],[0,2],[4,3]],
]) {
  const tags={highway:'primary',...extra}, label=JSON.stringify(tags)
  assert.deepEqual(Object.values(bikeDirections(tags)),directions,label)
  assert.deepEqual(['forward','backward'].map(d=>(bikeAttributes(tags,d)>>3)&3),facility,label)
  assert.deepEqual(['forward','backward'].map(d=>bikeStress(tags,d,true)),stress,label)
  const db=new DatabaseSync(':memory:')
  try {
    const writer=createBikeWriter(db,{carAllowed:()=>true})
    writer.way(1,tags,[1,2,3],{get:id=>({lon:id*.001,lat:0})})
    writer.finish()
    const rows=db.prepare('SELECT * FROM bike_edges').all()
    assert.equal(rows.length,directions.filter(Boolean).length*2,label)
    for (const r of rows) {
      const index=r.from_node<r.to_node?0:1
      assert.equal((r.attributes>>3)&3,facility[index],label)
      assert.equal(r.stress,stress[index],label)
    }
  } finally {db.close()}
}

// Bicycle access stays two-way while the traffic/facility direction reverses.
// A static edge must not mask its timed facility, stress, or pushing permission.
{
  const db=new DatabaseSync(':memory:')
  try {
    const writer=createBikeWriter(db,{carAllowed:()=>true,walkableWay:t=>t.foot==='yes',
      walkingDirections:()=>({forward:true,backward:true})})
    writer.way(1,{highway:'primary',oneway:'yes','oneway:bicycle':'no',cycleway:'lane',
      'oneway:conditional':'-1 @ (Mo 08:00-09:00)',foot:'yes',
      'foot:conditional':'no @ (Mo 08:00-09:00)'},[1,2],{get:id=>({lon:id*.001,lat:0})})
    assert.equal(db.prepare('SELECT count(*) n FROM bike_edges').get().n,0)
    const rows=db.prepare(`SELECT e.*,w.start_minute,w.end_minute FROM bike_timed_edges e
      JOIN bike_edge_windows w USING(window_id)`).all()
    for (let minute=0;minute<10080;minute++) {
      const active=rows.filter(r=>r.start_minute<=minute&&minute<r.end_minute)
      assert.equal(active.length,2,`one variant per direction at minute ${minute}`)
      for (const r of active) {
        const reversed=minute>=480&&minute<540, lane=(r.from_node===1)!==reversed
        assert.equal((r.attributes>>3)&3,Number(lane))
        assert.equal(r.stress,(lane?3:4)|(reversed?0:8))
      }
    }
    writer.finish()
    assert.deepEqual(db.prepare('SELECT stress FROM bike_timed_edges ORDER BY rowid').all().map(r=>r.stress),
      [...new Map(rows.map(r=>[`${r.from_node}:${r.window_id}`,r.stress])).values()])
  } finally {db.close()}
}

// Junction summaries are independent of way order and repeated shape nodes.
for (const order of [[1,2,3],[1,3,2],[2,1,3],[2,3,1],[3,1,2],[3,2,1]]) {
  const db=new DatabaseSync(':memory:')
  try {
    const writer=createBikeWriter(db,{carAllowed:t=>t.highway!=='cycleway'})
    const tags={1:{highway:'primary',cycleway:'opposite_lane'},2:{highway:'tertiary'},3:{highway:'cycleway'}}
    for (const id of order) writer.way(id,tags[id],[id*10,1,id*10+1,1],{get:n=>({lon:n*.001,lat:0})})
    writer.finish()
    const rows=db.prepare('SELECT * FROM bike_edges').all()
    for (const r of rows) {
      const backward=r.way_id===1 && ((r.from_node===1&&r.to_node===10)||(r.from_node===11&&r.to_node===1))
      // The loop also has a forward edge 11->1; inspect the unambiguous first segment.
      if (r.way_id===1 && (r.from_node===11||r.to_node===11)) continue
      assert.equal(r.stress,backward?3:4,JSON.stringify({order,r}))
    }
  } finally {db.close()}
}

// Long, valid OSM segments retain their original endpoints and directions.
for (const timed of [false,true]) {
  const db=new DatabaseSync(':memory:')
  const writer=createBikeWriter(db)
  const nodes=new Map([[1,{lon:0,lat:0}],[2,{lon:.2,lat:.2}]])
  writer.way(1,{highway:'cycleway',oneway:'yes',...(timed?{'bicycle:conditional':'no @ (Mo 08:00-09:00)'}:{})},[1,2],{get:id=>nodes.get(id)})
  writer.finish()
  const rows=db.prepare(`SELECT * FROM ${timed?'bike_timed_edges':'bike_edges'}`).all()
  assert.equal(rows.length,1,'A segment longer than 10 km must survive import')
  assert.equal(rows[0].from_node,1);assert.equal(rows[0].to_node,2)
  assert(rows[0].distance_cm>3_000_000&&rows[0].distance_cm<3_200_000)
  assert.equal(db.prepare('SELECT count(*) n FROM bike_nodes').get().n,2)
  db.close()
}

// Road estimates are separate from the ordinary comfort profile and apply
// directional lanes only when their direction is actually known.
for (const [tags,cars,forward,backward] of [
  [{highway:'cycleway'},false,1,1], [{highway:'residential'},true,1,1],
  [{highway:'residential',maxspeed:'80'},true,4,4], [{highway:'residential',lanes:'4'},true,4,4],
  [{highway:'tertiary'},true,3,3], [{highway:'tertiary',lanes:'2'},true,2,2],
  [{highway:'primary',lanes:'2',maxspeed:'20 mph'},true,4,4],
  [{highway:'primary',lanes:'2',maxspeed:'20 mph',cycleway:'lane'},true,2,2],
  [{highway:'primary',cycleway:'lane'},true,3,3],
  [{highway:'primary','cycleway:right':'lane'},true,4,4],
  [{highway:'primary','cycleway:right':'lane',driving_side:'right'},true,3,4],
  [{highway:'primary','cycleway:left':'lane',driving_side:'left'},true,3,4],
  [{highway:'primary','cycleway:right':'lane','cycleway:right:oneway':'no'},true,3,3],
  [{highway:'primary',cycleway:'opposite_lane'},true,4,3],
  [{highway:'primary',cycleway:'opposite_lane',oneway:'-1'},true,3,4],
  [{highway:'primary',lts:'2'},true,18,18],
  [{highway:'primary',lts:'2','lts:backward':'4'},true,18,20],
]) {
  assert.equal(bikeStress(tags,'forward',cars),forward,JSON.stringify(tags))
  assert.equal(bikeStress(tags,'backward',cars),backward,JSON.stringify(tags))
}
for (const value of ['', '0','5','1.5','unknown']) assert.throws(()=>bikeStress({highway:'primary',lts:value},'forward',true),/lts must be/)
for (const signal of [false,true]) {
  const stressDb=new DatabaseSync(':memory:')
  try {
    const writer=createBikeWriter(stressDb,{carAllowed:t=>t.highway==='primary',
      walkableWay:t=>t.foot!=='no',walkableNode:t=>t.foot!=='no',
      walkingDirections:t=>({forward:true,backward:t['foot:backward']!=='no'})})
    const getNode={get:id=>({lon:id*.001,lat:0})}
    writer.node(2,signal ? {highway:'traffic_signals'} : {})
    writer.node(5,{foot:'no',bicycle:'yes'})
    writer.way(10,{highway:'cycleway'},[1,2,3,4],getNode)
    writer.way(20,{highway:'primary',bicycle:'no'},[6,2,7],getNode)
    writer.way(30,{highway:'cycleway',lts:'2'},[2,8],getNode)
    writer.way(40,{highway:'primary',foot:'no'},[4,5],getNode)
    writer.way(50,{highway:'cycleway','foot:backward':'no'},[9,10],getNode)
    assert.equal(writer.finish().bikeStressVersion,1)
    const rows=stressDb.prepare('SELECT from_node,to_node,stress FROM bike_edges WHERE way_id=10 ORDER BY from_node,to_node').all()
    assert.equal(rows.find(r=>r.from_node===1&&r.to_node===2).stress,signal ? 9 : 12)
    assert.equal(rows.find(r=>r.from_node===2&&r.to_node===3).stress,signal ? 9 : 12)
    // Junction 4 independently touches the high-stress way 40; its effect
    // reaches 3->4, without recursively changing the preceding 2->3 segment.
    assert.equal(rows.find(r=>r.from_node===3&&r.to_node===4).stress,12)
    assert(stressDb.prepare('SELECT stress FROM bike_edges WHERE way_id=30').all().every(r=>r.stress===10),'Explicit LTS survives intersections')
    assert(stressDb.prepare('SELECT stress FROM bike_edges WHERE way_id=40').all().every(r=>r.stress===4),'Walking permission does not follow bicycle permission')
    assert.equal(stressDb.prepare('SELECT stress FROM bike_edges WHERE way_id=50 AND from_node=10').get().stress,1)
    assert.equal(stressDb.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE name='bike_junction_stress'").get().n,0)
  } finally {stressDb.close()}
}

assert.deepEqual(weeklyBikeCondition('Mo-Fr 07:00-09:00'), Array.from({length:5}, (_,i)=>[i*1440+420,i*1440+540]))
assert.deepEqual(weeklyBikeCondition('Su 23:00-02:00'), [[0,120],[10020,10080]])
assert.deepEqual(weeklyBikeCondition('Fr-Mo'), [[0,1440],[5760,10080]])
assert.deepEqual(weeklyBikeCondition('Mo,We 07:00-08:00,17:00-18:00'), [[420,480],[1020,1080],[3300,3360],[3900,3960]])
assert.deepEqual(weeklyBikeCondition('24/7'), [[0,10080]])
for (const unsupported of ['PH', 'sunset-sunrise', 'Mo 08:00-09:00; Mo 10:00-11:00',
  'Mo-Fr 08:00-09:00 AND wet', 'Dec 25', '08:60-09:00', '24:00-01:00', '08:00-08:00', 'Mo-Fr 08:00-09:00 "school"']) {
  assert.equal(weeklyBikeCondition(unsupported), null, unsupported)
}
const precedence = compileBikeTurnWindows('no_left_turn', 'none @ (Mo 08:00-09:00); only_right_turn @ (Mo 08:30-08:45)')
assert.deepEqual(precedence.get('no_left_turn'), [[0,480],[540,10080]])
assert.deepEqual(precedence.get('only_right_turn'), [[510,525]])
assert.equal(compileBikeTurnWindows('no_left_turn', 'none @ (PH)'), null)
assert.equal(compileBikeTurnWindows('', 'no_left_turn @ ((Mo 08:00-09:00))'), null)
assert.equal(compileBikeTurnWindows('', 'no_left_turn @ (Mo 08:00-09:00; Tu 08:00-09:00)'), null)
// Independently evaluate every minute, including overnight and wraparound.
const overnight = compileBikeTurnWindows('no_left_turn', 'none @ (Su 23:00-02:00); only_right_turn @ (Mo 01:00-03:00)')
for (let minute=0;minute<10080;minute++) {
  let expected = minute<120 || minute>=10020 ? 'none' : 'no_left_turn'
  if (minute>=60 && minute<180) expected='only_right_turn'
  const active = [...overnight].filter(([,intervals])=>intervals.some(([a,b])=>a<=minute&&minute<b)).map(([rule])=>rule)
  assert.deepEqual(active,expected==='none'?[]:[expected],`weekly minute ${minute}`)
}

const both = { forward: true, backward: true }
const neither = { forward: false, backward: false }
assert.deepEqual(bikeDirections({highway:'footway','bicycle:forward':'yes'}),{forward:true,backward:false})
assert.deepEqual(bikeDirections({highway:'residential','bicycle:forward':'yes','access:conditional':'no @ (PH)'}),{forward:true,backward:false})
assert.deepEqual(bikeDirections({highway:'residential',bicycle:'dismount','foot:conditional':'no @ (PH)'}),neither)
assert.deepEqual(bikeWayWindows({highway:'residential',bicycle:'yes','access:conditional':'no @ (PH)'}),[])
assert.deepEqual(bikeWayWindows({highway:'residential','access:conditional':'no @ (PH)'}),[])
const reversal = bikeWayWindows({highway:'residential',oneway:'yes','oneway:conditional':'-1 @ (Mo 08:00-09:00)'})
assert.deepEqual(reversal.map(({direction,intervals})=>({direction,intervals})),[
  {direction:'forward',intervals:[[0,480],[540,10080]]},
  {direction:'backward',intervals:[[480,540]]},
])
const conditionalAccessWay = {highway:'residential','access:conditional':'no @ (Mo 08:00-10:00)',
  'bicycle:conditional':'yes @ (Mo 09:00-11:00)'}
const timedDirections = bikeWayWindows(conditionalAccessWay)
const timedDismount = bikeWayWindows({highway:'residential',bicycle:'yes',foot:'yes',
  'bicycle:conditional':'dismount @ (Su 23:00-02:00)'})
for (let minute=0; minute<10080; minute++) {
  const active = variants => variants.filter(v=>v.intervals.some(([a,b])=>a<=minute&&minute<b))
  assert.deepEqual(active(timedDirections).map(v=>v.direction).sort(),
    minute>=480&&minute<540 ? [] : ['backward','forward'],`mode precedence at ${minute}`)
  const dismount = active(timedDismount)
  assert.equal(dismount.length,2)
  assert(dismount.every(v=>Boolean(v.attributes&128)===(minute<120||minute>=10020)),`dismount at ${minute}`)
}
const timedDb = new DatabaseSync(':memory:')
try {
  const writer = createBikeWriter(timedDb)
  const getNode = {get:id=>({lon:id*.001,lat:0})}
  writer.way(1,conditionalAccessWay,[1,2],getNode)
  assert.equal(timedDb.prepare('SELECT count(*) n FROM bike_edges').get().n,0,'Legacy edges remain conservative')
  assert.equal(timedDb.prepare('SELECT count(*) n FROM bike_timed_edges').get().n,2)
  assert.equal(timedDb.prepare('SELECT count(DISTINCT window_id) n FROM bike_timed_edges').get().n,1,'Directions share a schedule')
  assert.equal(timedDb.prepare('SELECT count(*) n FROM bike_edge_windows').get().n,2)
  const receipt = writer.finish()
  assert.equal(receipt.bikeEdgeWindowVersion,1)
  assert.equal(receipt.bikeTimedEdgeCount,2)
  assert.equal(receipt.bikeEdgeWindowCount,2)
} finally { timedDb.close() }
for (const highway of ['cycleway', 'residential', 'path', 'track', 'trunk', 'trunk_link']) assert.deepEqual(bikeDirections({ highway }), both)
for (const highway of ['motorway', 'footway', 'pedestrian', 'steps', 'construction']) assert.deepEqual(bikeDirections({ highway }), neither)
assert.deepEqual(bikeDirections({ highway: 'residential', oneway: 'yes' }), { forward: true, backward: false })
assert.deepEqual(bikeDirections({ highway: 'residential', oneway: '-1' }), { forward: false, backward: true })
for (const tags of [{ 'oneway:bicycle': 'no' }, { cycleway: 'opposite_lane' }, { 'cycleway:left': 'track', 'cycleway:left:oneway': 'no' }]) {
  assert.deepEqual(bikeDirections({ highway: 'residential', oneway: 'yes', ...tags }), both)
}
assert.deepEqual(bikeDirections({ highway: 'residential', oneway: 'yes', cycleway: 'opposite_lane', 'oneway:bicycle': 'yes' }), { forward: true, backward: false })
assert.deepEqual(bikeDirections({ highway: 'residential', junction: 'roundabout' }), { forward: true, backward: false })
assert.deepEqual(bikeDirections({ highway: 'cycleway', access: 'no', bicycle: 'designated' }), both)
assert.deepEqual(bikeDirections({ highway: 'cycleway', bicycle: 'no', access: 'yes' }), neither)
assert.deepEqual(bikeDirections({ highway: 'cycleway', bicycle: 'no', 'bicycle:forward':'yes' }), {forward:true,backward:false})
assert.deepEqual(bikeDirections({ highway: 'residential', vehicle: 'private' }), neither)
assert.deepEqual(bikeDirections({ highway: 'trunk', motorroad:'yes' }), neither)
assert.deepEqual(bikeDirections({ highway: 'primary', bicycle:'use_sidepath' }), neither)
assert.deepEqual(bikeDirections({ highway: 'primary', bicycle:'optional_sidepath' }), both)
assert.deepEqual(bikeDirections({ highway: 'residential', 'bicycle:backward': 'no' }), { forward: true, backward: false })
assert.deepEqual(bikeDirections({ highway: 'cycleway', 'bicycle:conditional': 'no @ (sunset-sunrise)' }), neither)
assert.deepEqual(bikeDirections({ highway: 'cycleway', 'bicycle:forward:conditional': 'no @ (sunset-sunrise)' }), {forward:false,backward:true})
assert.deepEqual(bikeDirections({ highway: 'residential', 'oneway:conditional': 'yes @ (Mo-Fr 07:00-09:00)' }), neither)
assert.deepEqual(bikeDirections({ highway: 'footway', bicycle: 'dismount' }), both)
assert.deepEqual(bikeDirections({highway:'residential',oneway:'yes','bicycle:backward':'yes'}),both)
assert(bikeAttributes({highway:'service',access:'destination'},'forward') & (1<<22))
assert.equal(bikeNodeAllowed({ barrier: 'bollard' }), true)
assert.equal(bikeNodeAllowed({ barrier: 'gate', access: 'private' }), false)
assert.equal(bikeNodeAllowed({ barrier: 'gate', bicycle: 'yes' }), true)
assert.equal(bikeNodeAllowed({ barrier: 'gate', bicycle: 'yes', locked: 'yes' }), false)
assert.equal(bikeNodeAllowed({ barrier: 'gate' }), true)
assert.equal(bikeNodeAllowed({ barrier: 'lift_gate', opening_hours:'Mo-Fr 08:00-17:00' }), false)
assert.equal(bikeNodeAllowed({ barrier: 'retaining_wall' }), false)
assert.equal(bikeAttributes({ highway:'residential','bicycle:backward':'dismount' },'backward') & 128,128)
assert.equal(bikeAttributes({ highway: 'footway', bicycle: 'dismount' }, 'forward') & 128, 128)
assert.equal((bikeAttributes({ highway: 'residential', incline: '10%' }, 'backward') >> 8) & 63, 20)
assert.equal((bikeAttributes({ highway: 'residential', maxspeed: '30 mph' }, 'forward') >> 14) & 255, 48)

const db = new DatabaseSync(':memory:')
try {
  const writer = createBikeWriter(db)
  const getNode = { get: id => ({ lon: id * 0.001, lat: 0 }) }
  writer.node(2, { barrier: 'gate', access: 'private' })
  writer.way(10, { highway: 'cycleway' }, [1, 2, 3], getNode)
  assert.equal(db.prepare('SELECT count(*) AS n FROM bike_edges').get().n, 0, 'Blocked nodes must break the way, never bridge it')
  writer.way(20, { highway: 'residential', oneway: 'yes', 'oneway:bicycle': 'no' }, [3,4], getNode)
  assert.equal(db.prepare('SELECT count(*) AS n FROM bike_edges').get().n, 2)
  const relation = { refs: [20, 4, 30], roles: [0,1,2], types: [1,0,1] }
  writer.relation(relation, { type: 'restriction', restriction: 'no_left_turn', except: 'bus;bicycle' }, ['from','via','to'])
  assert.equal(db.prepare('SELECT count(*) AS n FROM bike_turns').get().n, 0)
  writer.relation(relation, { type: 'restriction', restriction: 'no_left_turn' }, ['from','via','to'])
  assert.deepEqual({ ...db.prepare('SELECT * FROM bike_turns').get() }, { via_node: 4, from_way: 20, to_way: 30, only_turn: 0 })
  writer.relation({refs:[20,30,40],roles:[0,1,2],types:[1,1,1]},
    {type:'restriction','restriction:bicycle':'no_left_turn'},['from','via','to'])
  assert.deepEqual({...db.prepare('SELECT * FROM bike_way_turns').get()}, {from_way:20,via_ways:'[30]',to_way:40,only_turn:0})
  writer.relation(relation, {type:'restriction','restriction:conditional':'no_left_turn @ (Mo-Fr 07:00-09:00)'}, ['from','via','to'])
  writer.relation(relation, {type:'restriction','restriction:bicycle:conditional':'only_right_turn @ (Mo-Fr 07:00-09:00)'}, ['from','via','to'])
  assert.equal(db.prepare('SELECT only_turn FROM bike_turns ORDER BY rowid DESC LIMIT 1').get().only_turn, 9)
  writer.relation({refs:[20,21,4,30],roles:[0,0,1,2],types:[1,1,0,1]}, {type:'restriction',restriction:'no_entry'}, ['from','via','to'])
  assert.equal(db.prepare('SELECT count(*) n FROM bike_turns WHERE from_way=21').get().n,1)
  const receipt=writer.finish()
  assert.equal(receipt.bikeConditionalRestrictionCount,2)
  assert.equal(receipt.bikeTurnWindowVersion,1)
  assert.equal(receipt.bikeTimedTurnWindowCount,10)
  assert.equal(receipt.bikeEdgeCount, 2)
} finally { db.close() }

const conditionalDb = new DatabaseSync(':memory:')
try {
  const writer = createBikeWriter(conditionalDb)
  const relation = {refs:[1,2,3],roles:[0,1,2],types:[1,0,1]}
  writer.relation(relation, {type:'restriction',restriction:'no_left_turn','restriction:bicycle:conditional':'none @ (Mo 08:00-09:00)'},['from','via','to'])
  const row=conditionalDb.prepare('SELECT rowid,* FROM bike_turns').get()
  assert.equal(row.only_turn,0,'A bicycle exception must retain the general base restriction outside its window')
  assert.deepEqual(conditionalDb.prepare('SELECT start_minute,end_minute FROM bike_turn_windows WHERE turn_row=?').all(row.rowid).map(r=>Object.values(r)),[[0,480],[540,10080]])
  writer.relation({...relation,types:[1,1,1]}, {type:'restriction','restriction:conditional':'no_left_turn @ (Su 23:00-02:00)'},['from','via','to'])
  assert.equal(conditionalDb.prepare('SELECT count(*) n FROM bike_turn_windows WHERE turn_table=1').get().n,2)
  writer.relation(relation, {type:'restriction','restriction:conditional':'no_left_turn @ (PH)'},['from','via','to'])
  const unknown=conditionalDb.prepare('SELECT max(rowid) id FROM bike_turns').get().id
  assert.equal(conditionalDb.prepare('SELECT count(*) n FROM bike_turn_windows WHERE turn_table=0 AND turn_row=?').get(unknown).n,0,'Unknown conditions retain all-day conservative enforcement')
} finally { conditionalDb.close() }
console.log('Bicycle access, contraflow, barriers, attributes and turn import checks passed.')
