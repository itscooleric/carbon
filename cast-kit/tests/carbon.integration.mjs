/** Optional exact-source integration: CARBON_ROOT=/path/to/pinned-carbon npm run test:carbon */
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {registerStack,registerHandoff,stageReturn,acceptInCarbon,dump,encodeReturn,contextFor} from '../src/kit.mjs';
import {composeDispatch,dispatchTar} from '../src/dispatch.mjs';
import {encode,decode,entry,patchScalarFrontmatter} from '../src/validation.mjs';
import {scenario,cast,receipt,handoff,fullFiles,report,accepted,unchecked} from './fixtures.mjs';
if(!process.env.CARBON_ROOT)throw new Error('Set CARBON_ROOT to the inspected Carbon checkout; no provider tests are implied.');
const load=p=>import(pathToFileURL(resolve(process.env.CARBON_ROOT,p)));
const {Stack}=await load('src/core/stack.js');
const {parseHandoff,propose,registerDispatch}=await load('src/core/handoff.js');
const {readTar,writeTar}=await load('src/archives/tar.js');
for(const kind of ['research','registry','report','restricted'])test('Carbon acceptance '+kind+': preserved omitted bytes and one revision',()=>{
  const x=scenario(kind),base=new Stack(fullFiles(),['empty']),h=registerStack(base,x.castSource,x.context),old=new Map([...base.files].map(([p,b])=>[p,b.slice()]));
  parseHandoff(x.context);
  const result=acceptInCarbon(base,h,x.source,{approved:true});assert.equal(result.next.manifest.revision,5);
  for(const p of ['assets/marker.bin','entries/retained.md','entries/source.md','entries/mission.md'])assert.deepEqual(result.next.files.get(p),old.get(p));
  assert.ok(result.next.directories.has('empty'));assert.match(result.next.text('stack.yaml'),/# Preserve this manifest comment/);assert.match(result.next.text('stack.yaml'),/custom: keep-me/);
  assert.throws(()=>acceptInCarbon(result.next,h,x.source,{approved:true}),/Stale/);
});
test('old Carbon Return route rejects new envelope and still accepts its original format',()=>{
  const x=scenario('research'),base=new Stack(fullFiles()),trusted=registerDispatch(base,x.context);
  assert.throws(()=>parseHandoff(x.source),/header/);
  const legacy=x.context.replace(base.text('entries/findings.md'),x.files.get('entries/findings.md'));
  assert.equal(propose(base,trusted,legacy).next.manifest.revision,5);
});
test('new-file ID collision in omitted content fails before acceptance',()=>{
  const x=scenario('report'),base=new Stack(fullFiles()),h=registerStack(base,x.castSource,x.context);
  const malicious=encodeReturn(x.meta,new Map([['entries/report.md',report.replace('ent-harbor-report','ent-retained')]]));
  assert.throws(()=>acceptInCarbon(base,h,malicious,{approved:true}),/Duplicate/);assert.equal(base.manifest.revision,4);
});
test('case-variant delete/create cannot replace a managed Entry identity; rejection leaves the Stack unchanged',()=>{
  const c={...cast('report'),delete:['entries/findings.md'],required_files:[]},base=new Stack(fullFiles(),['empty']),old=new Map([...base.files].map(([p,b])=>[p,b.slice()]));
  const h=registerStack(base,dump(c),handoff(c)),impostor='---\nid: ent-impostor\nkind: research\n---\n# Replaced identity\n';
  for(const target of ['entries/FINDINGS.md','ENTRIES/findings.md']){
    const m=receipt(c,{deletes:['entries/findings.md'],creates:[target]});
    assert.throws(()=>acceptInCarbon(base,h,unchecked(m,new Map([[target,impostor]])),{approved:true}),/collision/);
    assert.throws(()=>registerStack(base,dump({...c,create:[target]}),handoff({...c,create:[target]})),/collision/);
  }
  assert.equal(base.manifest.revision,4);assert.deepEqual([...base.files.keys()],[...old.keys()]);for(const [p,b] of old)assert.deepEqual(base.files.get(p),b);assert.ok(base.directories.has('empty'));
  const ok=encodeReturn(receipt(c,{deletes:['entries/findings.md'],creates:['entries/report.md']}),new Map([['entries/report.md',report]]));
  const {next}=acceptInCarbon(base,h,ok,{approved:true});assert.equal(next.manifest.revision,5);assert.ok(!next.files.has('entries/findings.md'));assert.equal(next.text('entries/report.md'),report);
});
test('explicit rename updates entrypoint and deletion requires exact allowlist',()=>{
  const c={...cast(),required_files:[],rename:[['entries/mission.md','entries/mission-moved.md']],delete:['entries/findings.md']};const base=new Stack(fullFiles()),h=registerStack(base,dump(c),handoff(c));
  const source=encodeReturn(receipt(c,{renames:c.rename,deletes:c.delete}),new Map());const {next}=acceptInCarbon(base,h,source,{approved:true});assert.equal(next.manifest.entrypoint,'entries/mission-moved.md');assert.equal(next.manifest.revision,5);assert.ok(!next.files.has('entries/findings.md'));
});
test('plan -> research -> accepted report -> fresh investigation -> unrelated session',()=>{
  const files=fullFiles();const plan='---\nid: ent-plan\nkind: plan\nstatus: proposed # retain review trail\n---\n# Plan\n'+accepted+'\nAccepted decision: use supplied source only. Evidence: entries/source.md.\nPending: assess fields, then investigate licensing.\n';files.set('entries/plan.md',encode(plan));
  let base=new Stack(files),c=cast('report');c.read.push('entries/plan.md');c.replace=['entries/plan.md'];c.metadata=[{path:'entries/plan.md',keys:['status']}];
  c.playbooks=[{name:'Research',source:'builtin',content:'# Research\nPreserve sources and limitations.'},{name:'Planning',source:'builtin',content:'# Planning\nKeep accepted decisions and pending work.'}];
  let h=registerStack(base,dump(c),handoff(c,base.files));
  const updated=plan.replace(entry(plan).frontmatter,patchScalarFrontmatter(entry(plan).frontmatter,'status','active'))+'\nResearch proposal for review: report at entries/report.md; receipt checkpoint-plan-first.\nPending: investigate licensing.\n';
  const first=encodeReturn(receipt(c,{checkpoint_id:'checkpoint-plan-first',creates:['entries/report.md'],replaces:['entries/plan.md']}),new Map([['entries/report.md',report],['entries/plan.md',updated]]));
  base=acceptInCarbon(base,h,first,{approved:true}).next;assert.equal(base.manifest.revision,5);
  c={...c,assignment_id:'cast-license',dispatch_id:'dispatch-license',base_revision:5,objective:'Investigate whether supplied source establishes a license.',read:[...c.read,'entries/report.md'],create:['entries/investigation.md'],required_files:['entries/investigation.md']};
  h=registerStack(base,dump(c),handoff(c,base.files));
  const investigation='---\nid: ent-license-investigation\nkind: investigation\n---\n# License evidence\nSupplied source and accepted report do not establish a license.\nSource: entries/source.md; entries/report.md. Need publisher license terms.\n';
  const pending=updated.replace(entry(updated).frontmatter,patchScalarFrontmatter(entry(updated).frontmatter,'status','blocked'))+'\nPending: obtain publisher terms; do not infer permission to acquire data.\n';
  const second=encodeReturn(receipt(c,{checkpoint_id:'checkpoint-plan-second',status:'blocked',summary:'License evidence absent; complete investigation note proposed.',blockers:['Publisher terms missing.'],next:['Obtain approved source terms.'],creates:['entries/investigation.md'],replaces:['entries/plan.md']}),new Map([['entries/investigation.md',investigation],['entries/plan.md',pending]]));
  base=acceptInCarbon(base,h,second,{approved:true}).next;assert.equal(base.manifest.revision,6);
  const resume={...c,assignment_id:'cast-resume',dispatch_id:'dispatch-resume',base_revision:6,create:[],required_files:[],read:[...c.read,'entries/investigation.md']};
  const fresh=registerHandoff(dump(resume),handoff(resume,base.files)),ctx=contextFor(fresh);
  assert.match(ctx.files['entries/plan.md'],/Accepted decision: use supplied source only/);assert.match(ctx.files['entries/plan.md'],/obtain publisher terms/);assert.match(ctx.files['entries/plan.md'],/id: ent-plan/);assert.match(ctx.files['entries/plan.md'],/# retain review trail/);assert.match(ctx.files['entries/investigation.md'],/entries\/report.md/);assert.deepEqual(base.files.get('assets/marker.bin'),fullFiles().get('assets/marker.bin'));
});
test('published planning fixtures equal actual Carbon acceptance and partial TAR cannot replace Stack',async()=>{
  const {planningFixture}=await import('./planning-fixture.mjs'),p=planningFixture();let base=new Stack(p.original);
  for(const [x,expected] of [[p.first,p.expected5],[p.second,p.expected6]]){const h=registerStack(base,x.castSource,x.context);base=acceptInCarbon(base,h,x.source,{approved:true}).next;for(const [path,bytes] of expected)assert.deepEqual(base.files.get(path),bytes);}
  const {readFile}=await import('node:fs/promises');const bytes=new Uint8Array(await readFile(new URL('../examples/with-assets/selected.dispatch.tar',import.meta.url)));assert.throws(()=>readTar(bytes),/stack.yaml/);
  const roundtrip=readTar(writeTar(base));assert.equal(roundtrip.manifest.revision,6);assert.deepEqual(roundtrip.files.get('assets/marker.bin'),p.original.get('assets/marker.bin'));
});
