#!/usr/bin/env python3
"""Audit NDW matches against original OSM XML, using VIGO's actual PBF compiler.

Raw inputs and outputs belong in an ignored local evidence directory. Dependencies:
osmium, Node, Cargo. OSM is © OpenStreetMap contributors, ODbL. This is bounded
sample coverage, not national ground truth or a live-service availability test.
"""
import argparse, collections, gzip, hashlib, json, os, pathlib, subprocess, xml.etree.ElementTree as ET
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--osm',required=True);p.add_argument('--configuration',required=True)
p.add_argument('--measurements',required=True);p.add_argument('--clock',required=True);p.add_argument('--output',required=True)
a=p.parse_args();root=pathlib.Path(__file__).resolve().parents[1];out=pathlib.Path(a.output).resolve();out.mkdir(parents=True,exist_ok=True)
inputs={k:pathlib.Path(getattr(a,k)).resolve() for k in ['osm','configuration','measurements']}
for k in ['configuration','measurements']:
 data=inputs[k].read_bytes();(out/(k+'.xml')).write_bytes(gzip.decompress(data) if data[:2]==b'\x1f\x8b' else data)
subprocess.run(['osmium','cat',str(inputs['osm']),'-o',str(out/'roads.osm.pbf'),'--overwrite'],check=True)
js="""import {buildNationalOsmStore,buildNationalOsmDriveStore,disposeNationalOsmStore} from './src/server/national-osm-store.mjs';
const d=process.env.VIGO_AUDIT_OUTPUT;
await buildNationalOsmStore({pbfPath:d+'/roads.osm.pbf',outputPath:d+'/roads.sqlite'});
const result=buildNationalOsmDriveStore(d+'/roads.sqlite');disposeNationalOsmStore(d+'/roads.sqlite');console.log(JSON.stringify(result));"""
with (out/'build.log').open('w') as log:subprocess.run(['node','--input-type=module','-'],input=js,text=True,cwd=root,env={**os.environ,'VIGO_AUDIT_OUTPUT':str(out)},stdout=log,stderr=log,check=True)
cargo=os.environ.get('CARGO',str(pathlib.Path.home()/'.cargo/bin/cargo'))
with (out/'matches.json').open('w') as log:
 subprocess.run([cargo,'run','--release','-p','vigo-traffic','--example','match_ndw','--',str(out/'roads.sqlite.drive-accelerator-v2.bin'),str(out/'configuration.xml'),str(out/'measurements.xml'),a.clock],cwd=root,stdout=log,check=True)
result=json.loads((out/'matches.json').read_text());osm=ET.parse(inputs['osm']).getroot()
nodes={n.attrib['id']:(float(n.attrib['lon']),float(n.attrib['lat'])) for n in osm.findall('node')}
key=lambda p:tuple(round(v,7) for v in p)
edges=collections.defaultdict(list)
for w in osm.findall('way'):
 tags={t.attrib['k']:t.attrib['v'] for t in w.findall('tag')}
 if tags.get('highway') not in {'motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','unclassified','residential','living_street','service','road','track'}:continue
 # Direction is checked independently against the original XML, not the CSR.
 refs=[r.attrib['ref'] for r in w.findall('nd')];oneway=tags.get('oneway:motor_vehicle',tags.get('oneway','')).lower()
 if not oneway and (tags.get('junction') in ['roundabout','circular'] or tags.get('highway') in ['motorway','motorway_link']):oneway='yes'
 for s,t in zip(refs,refs[1:]):
  if s not in nodes or t not in nodes:continue
  directions=[]
  if oneway not in ['-1','reverse']:directions.append((s,t))
  if oneway not in ['yes','1','true']:directions.append((t,s))
  for x,y in directions:edges[key(nodes[x]),key(nodes[y])].append({'wayId':w.attrib['id'],'name':tags.get('name'),'oneway':oneway})
audits=[]
for r in result['results']:
 if 'edges' not in r:continue
 ways={}
 for i,e in enumerate(r['edges']):
  original=edges[key(e['from']),key(e['to'])]
  assert original, f"Matched edge is absent or reverses OSM direction: {r['site']} {e}"
  if i:assert key(r['edges'][i-1]['to'])==key(e['from']), 'Disconnected match'
  for way in original:ways[way['wayId']]=way
 # This retained Amsterdam pair has explicit road-name evidence in NDW metadata.
 if r['site'] in ['ABM01_1084_1086','ABM01__1086_1084']:
  assert {w['name'] for w in ways.values()}=={'Heemstedestraat'}
 audits.append({'site':r['site'],'edges':len(r['edges']),'ways':list(ways.values())})
assert audits,'No accepted real-network matches to validate'
summary={k:v for k,v in result.items() if k!='results'}
summary.update({'osmAttribution':'OpenStreetMap contributors, ODbL','osmTimestamp':osm.find('meta').attrib if osm.find('meta') is not None else None,'inputs':{k:{'path':str(v),'sha256':hashlib.sha256(v.read_bytes()).hexdigest()} for k,v in inputs.items()},'rejected':dict(collections.Counter(r['rejected'] for r in result['results'] if 'rejected' in r)),'audits':audits})
(out/'audit.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps({k:v for k,v in summary.items() if k not in ['audits','inputs']}))
