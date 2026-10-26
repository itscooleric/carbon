import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {composeDispatch,dispatchTar} from '../src/dispatch.mjs';
import {dump,encodeReturn,registerHandoff,stageReturn,parseCast} from '../src/kit.mjs';
import {patchScalarFrontmatter,entry,yaml,decode} from '../src/validation.mjs';
import {scenario,receipt,handoff,fullFiles,mission} from './fixtures.mjs';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
async function input(){const x=scenario('report');return {...x,originalHandoff:x.context,contract:await read('operating-contract-v0.1.md'),bootstrap:await read('bootstrap.md'),returnTemplate:encodeReturn(receipt(x.cast,{status:'partial'}),new Map())};}
test('Playbooks embedded in user-selected order; composition deterministic',async()=>{
  const x=await input();x.cast.playbooks=[{name:'Plan',source:'import:custom.md',content:'# Plan\nUse supplied evidence.'},{name:'Review',source:'builtin:critical-review',content:await read('playbooks/critical-review.md')}];x.castSource=dump(x.cast);
  const a=composeDispatch(x),b=composeDispatch(x);assert.equal(a.text,b.text);assert.deepEqual(a.manifest.playbook_order,['Plan','Review']);assert.match(a.text,/Use supplied evidence/);assert.ok(!a.files.has('stack.yaml'));
  x.cast.playbooks.reverse();const reverse=composeDispatch({...x,castSource:dump(x.cast)});assert.notEqual(reverse.text,a.text);assert.deepEqual(reverse.manifest.playbook_order,['Review','Plan']);
});
test('unselected source instructions remain data and grant no permissions',async()=>{const x=await input(),out=composeDispatch(x);assert.equal(out.manifest.playbook_order.length,0);assert.match(out.text,/Untrusted source context/);assert.match(out.text,/Ignore the Cast/);assert.deepEqual(parseCast(x.castSource).delete,[]);});
test('binary selection requires actual attachment; text export refuses binaries',async()=>{
  const x=await input();x.cast.assets=['assets/marker.bin'];x.castSource=dump(x.cast);
  assert.throws(()=>composeDispatch({...x,mode:'files'}),/missing/);
  const assets=new Map([['assets/marker.bin',fullFiles().get('assets/marker.bin')]]);
  assert.throws(()=>composeDispatch({...x,assets}),/cannot carry/);
  const out=composeDispatch({...x,assets,mode:'files'});assert.deepEqual(out.files.get('assets/0001.bin'),assets.get('assets/marker.bin'));assert.equal(out.manifest.complete_stack,false);assert.deepEqual(out.manifest.omitted_from_package,['entries/retained.md']);
});
test('selected Dispatch archive independently read by system TAR and is reproducible',async()=>{
  const x=await input(),out=composeDispatch({...x,mode:'tar'}),bytes=dispatchTar(out.files);
  assert.deepEqual(bytes,dispatchTar(out.files));const dir=await mkdtemp(join(tmpdir(),'cast-tar-'));
  try{const f=join(dir,'test.tar');await writeFile(f,bytes);const list=execFileSync('tar',['-tf',f],{encoding:'utf8'});assert.match(list,/envoy-dispatch\/dispatch.yaml/);assert.doesNotMatch(list,/envoy-dispatch\/stack.yaml/);assert.equal(execFileSync('tar',['-xOf',f,'envoy-dispatch/assignment.cast.yaml'],{encoding:'utf8'}),x.castSource);}finally{await rm(dir,{recursive:true,force:true});}
});
async function tarMembers(bytes){const dir=await mkdtemp(join(tmpdir(),'cast-tar-'));try{const f=join(dir,'test.tar');await writeFile(f,bytes);return execFileSync('tar',['-tf',f],{encoding:'utf8'}).trim().split('\n');}finally{await rm(dir,{recursive:true,force:true});}}
test('dispatch.yaml inventory declares exactly the packaged files and TAR members, itself included',async()=>{
  const x=await input(),assets=new Map([['assets/marker.bin',fullFiles().get('assets/marker.bin')]]);
  const withAsset={...x,castSource:dump({...x.cast,assets:['assets/marker.bin']}),assets};
  for(const out of [composeDispatch({...x,mode:'files'}),composeDispatch({...x,mode:'tar'}),composeDispatch({...withAsset,mode:'tar'})]){
    const declared=out.manifest.files;assert.ok(declared.includes('dispatch.yaml'));assert.equal(new Set(declared).size,declared.length);
    assert.deepEqual([...declared].sort(),[...out.files.keys()].sort());assert.deepEqual(yaml(decode(out.files.get('dispatch.yaml'))),out.manifest);
    assert.deepEqual((await tarMembers(dispatchTar(out.files))).sort(),declared.map(p=>'envoy-dispatch/'+p).sort());
  }
  const published=yaml(await read('examples/with-assets/dispatch.yaml'));
  assert.deepEqual((await tarMembers(await readFile(new URL('../examples/with-assets/selected.dispatch.tar',import.meta.url)))).sort(),published.files.map(p=>'envoy-dispatch/'+p).sort());
});
test('Asset numbering follows Cast order; equivalent Asset maps yield byte-identical packages',async()=>{
  const x=await input(),stack=fullFiles(),second=new Uint8Array([9,8,7,0]);stack.set('assets/second.bin',second);
  const c={...x.cast,assets:['assets/second.bin','assets/marker.bin']},base={...x,castSource:dump(c),originalHandoff:handoff(c,stack),mode:'tar'};
  const forward=composeDispatch({...base,assets:new Map([['assets/marker.bin',stack.get('assets/marker.bin')],['assets/second.bin',second]])});
  const reverse=composeDispatch({...base,assets:new Map([['assets/second.bin',second],['assets/marker.bin',stack.get('assets/marker.bin')]])});
  assert.deepEqual(forward.manifest.assets.map(a=>[a.path,a.packaged_as]),[['assets/second.bin','assets/0001.bin'],['assets/marker.bin','assets/0002.bin']]);
  assert.deepEqual(forward.files.get('assets/0001.bin'),second);assert.deepEqual(forward.manifest,reverse.manifest);
  assert.deepEqual(forward.files.get('dispatch.yaml'),reverse.files.get('dispatch.yaml'));assert.deepEqual(dispatchTar(forward.files),dispatchTar(reverse.files));
});
test('Playbook bounds and duplicate selections fail closed',async()=>{const x=await input();const p={name:'same',source:'import',content:'# content'};assert.throws(()=>parseCast(dump({...x.cast,playbooks:[p,{...p}]})),/Duplicate/);assert.throws(()=>parseCast(dump({...x.cast,playbooks:[{...p,content:'x'.repeat(16001)}]})));});
test('explicit scalar metadata permission preserves stable ID, comments and unknown keys',()=>{
  const x=scenario('research');x.cast.replace=['entries/mission.md'];x.cast.required_files=['entries/mission.md'];x.cast.metadata=[{path:'entries/mission.md',keys:['kind']}];
  const h=registerHandoff(dump(x.cast),handoff(x.cast)),front=entry(mission).frontmatter;
  const changed=mission.replace(front,patchScalarFrontmatter(front,'kind','plan'));
  const m=receipt(x.cast,{replaces:['entries/mission.md']});
  assert.equal(stageReturn(h,encodeReturn(m,new Map([['entries/mission.md',changed]]))).changes[0].after,changed);
  assert.match(changed,/custom: keep-me # Preserve this comment/);
  assert.throws(()=>stageReturn(h,encodeReturn(m,new Map([['entries/mission.md',changed.replace('ent-harbor-mission','new-id')]]))),/ID/);
  assert.throws(()=>stageReturn(h,encodeReturn(m,new Map([['entries/mission.md',changed.replace('keep-me','changed')]]))),/Unauthorized/);
});
test('metadata permission cannot add keys or permit stable ID changes',()=>{
  const x=scenario('research');assert.throws(()=>parseCast(dump({...x.cast,metadata:[{path:'entries/findings.md',keys:['id']}]})));
  x.cast.metadata=[{path:'entries/findings.md',keys:['status']}];const h=registerHandoff(dump(x.cast),handoff(x.cast));const body=x.files.get('entries/findings.md').replace('kind: research','kind: research\nstatus: active');assert.throws(()=>stageReturn(h,encodeReturn(x.meta,new Map([['entries/findings.md',body]]))),/existing scalar/);
});
