// Exhaustive simple-path oracle on small directed graphs. Positive costs mean
// an optimum without turn restrictions never needs to revisit a node.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'

// The Rust bike search, through the routing kernel's BikeKernel binding.
const { BikeKernel } = createRequire(import.meta.url)('../crates/vigo-runtime/vigo-routing-kernel.node')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-bike-oracle-'))
let state = 904, checked = 0
const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32)
const nodes = Array.from({length:6}, (_,i) => [Math.round(Math.cos(i*Math.PI/3)*100000)/1e7, Math.round(Math.sin(i*Math.PI/3)*100000)/1e7])
function meters(a,b) {
  const rad=Math.PI/180
  return 6371008.8*2*Math.asin(Math.sqrt(Math.sin((a[1]-b[1])*rad/2)**2+Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin((a[0]-b[0])*rad/2)**2))
}
try {
  for (let seed=0;seed<24;seed++) {
    const file=path.join(directory,`${seed}.sqlite`), db=new DatabaseSync(file)
    db.exec(`CREATE TABLE metadata(key TEXT,value TEXT); INSERT INTO metadata VALUES('bikeProfileVersion','1');
      CREATE TABLE bike_nodes(node_id INTEGER PRIMARY KEY,lon_e7 INTEGER,lat_e7 INTEGER);
      CREATE TABLE bike_edges(from_node INTEGER,to_node INTEGER,distance_cm INTEGER,way_id INTEGER,attributes INTEGER);
      CREATE TABLE bike_turns(via_node INTEGER,from_way INTEGER,to_way INTEGER,only_turn INTEGER);`)
    nodes.forEach(([x,y],i)=>db.prepare('INSERT INTO bike_nodes VALUES(?,?,?)').run(i,Math.round(x*1e7),Math.round(y*1e7)))
    const edges=nodes.map(()=>[])
    for(let i=0;i<nodes.length;i++) for(let j=0;j<nodes.length;j++) {
      if(i===j || (j!==(i+1)%6 && random()>.35)) continue
      const distance=Math.ceil(meters(nodes[i],nodes[j])*100)/100, major=random()<.5
      edges[i].push({to:j,distance,major})
      db.prepare('INSERT INTO bike_edges VALUES(?,?,?,?,?)').run(i,j,Math.round(distance*100),i*6+j,
        (30<<8)|(major ? (80<<14)|6 : (15<<14)|(2<<3)))
    }
    db.close()
    const kernel=new BikeKernel(file)
    for(const profile of ['fast','balanced','quiet']) for(const multiplier of [.9,1.5,5]) {
      const limit=meters(nodes[0],nodes[5])*multiplier
      let best=Infinity
      function visit(node,seen,distance,cost) {
        if(distance>limit || cost>=best) return
        if(node===5){best=cost;return}
        for(const edge of edges[node]) if(!(seen & (1<<edge.to))) {
          const factor=profile==='fast' ? 1 : .8+(edge.major ? 2.425*(profile==='quiet' ? 2.5 : 1) : 0)
          visit(edge.to,seen|(1<<edge.to),distance+edge.distance,cost+edge.distance/5*factor)
        }
      }
      visit(0,1,0,0)
      const result=JSON.parse(kernel.route(JSON.stringify({origin:nodes[0],destination:nodes[5],bike:{profile},
        maxWalkMeters:0,walkingSpeedKph:4.8,maxDistanceMeters:limit})))
      assert.equal(result.status,Number.isFinite(best)?'ready':'blocked',`${seed}/${profile}/${multiplier}`)
      if(Number.isFinite(best)) {
        assert(Math.abs(result.cost-best)<1e-6,`${seed}/${profile}/${multiplier}: ${result.cost} != ${best}`)
        assert(result.legs.reduce((n,l)=>n+l.meters,0)<=limit+1e-6)
      }
      checked++
    }
  }
  console.log(`Bicycle search matches exhaustive directed-graph optima (${checked} preference/distance-cap cases).`)
} finally { fs.rmSync(directory,{recursive:true,force:true,maxRetries:20,retryDelay:50}) }
