import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCast,parseReturn,encodeReturn,readHandoff,registerHandoff,registerStack,stageReturn,acceptInCarbon,contextFor,dump,LIMITS} from '../src/kit.mjs';
import {yaml,path,encode,decode} from '../src/validation.mjs';
import {scenario,recovery,cast,receipt,handoff,fullFiles,report,accepted,unchecked} from './fixtures.mjs';
const host=()=>({files:fullFiles(),manifest:{id:'stk-harbor-demo',revision:4},directories:new Set(['entries','assets'])});
function dispatch(kind='research'){const x=scenario(kind);return {...x,handle:registerHandoff(x.castSource,x.context)};}
for(const kind of ['research','registry','report','restricted']) test('scenario '+kind+': complete reviewable output preserves source',()=>{
  const x=dispatch(kind), s=stageReturn(x.handle,x.source);
  assert.equal(s.meta.status,'complete');assert.ok(s.changes.length);assert.deepEqual([...s.files], [...x.files]);
  assert.ok(s.meta.accepted.some(x=>x.includes(accepted)));assert.equal(s.meta.operations_performed.length,0);
  const ctx=contextFor(x.handle);assert.ok(ctx.omitted.includes('assets/marker.bin'));assert.ok(!Object.hasOwn(ctx.files,'assets/marker.bin'));
});
test('recovery: independent registration reconstructs latest cumulative proposed state',()=>{
  const r=recovery(), first=stageReturn(registerHandoff(r.castSource,r.context),r.first);
  const resumed=stageReturn(registerHandoff(r.castSource,r.context),r.second);
  assert.equal(resumed.meta.parent_checkpoint,first.meta.checkpoint_id);assert.equal(resumed.files.size,2);
  assert.ok(resumed.files.get('entries/findings.md').includes(accepted));
});
for(const body of ['', 'no final newline','one\n','many\n\n','CRLF\r\nbody\r\n','紫 café\n```\n<!-- body -->\n```'])test('exact frame roundtrip '+JSON.stringify(body),()=>{
  const c=cast(),m=receipt(c,{creates:['entries/report.md']});
  assert.equal(parseReturn(encodeReturn(m,new Map([['entries/report.md',body]]))).files.get('entries/report.md'),body);
});
for(const [name,mutate] of [
  ['missing footer',s=>s.slice(0,s.lastIndexOf('<!-- envoy-cast:complete'))],
  ['truncated body',s=>s.slice(0,-150)],['trailing prose',s=>s+'done'],
  ['missing file',s=>s.replace(/<!-- envoy-cast:file[\s\S]*?<!-- envoy-cast:end[^\n]+\n\n/,'')],
  ['wrong path encoding',s=>s.replace('entries%2Ffindings.md','entries/findings.md')],
  ['wrong count',s=>s.replace('files="1"','files="0"')],['whole packet CRLF',s=>s.replaceAll('\n','\r\n')],
  ['extra frame',s=>s+s.slice(s.indexOf('<!-- envoy-cast:file'))],
  ['duplicate metadata',s=>s.replace('format: envoy.return/v0.1','format: envoy.return/v0.1\nformat: envoy.return/v0.1')],
  ['unknown field',s=>s.replace('format: envoy.return/v0.1','format: envoy.return/v0.1\napproved: true')]
])test('reject '+name,()=>assert.throws(()=>parseReturn(mutate(scenario('research').source))));
test('Return reordered frames rejected',()=>{const x=scenario('registry');assert.throws(()=>parseReturn(x.source.replace('path="entries%2Fentity.md"','path="entries%2Ffindings.md"')));});
test('boundary embedded in body rejected',()=>{const m=receipt();assert.throws(()=>encodeReturn({...m,creates:['entries/report.md']},new Map([['entries/report.md',m.boundary]])));});
for(const value of ['../outside.md','/absolute.md','C:/drive.md','x\\escape.md','a//b.md','a/./b.md','a/../b.md','a/NUL.md','a/.git/x.md','a/trailing .','a/\u202eevil.md','cafe\u0301.md'])test('unsafe path '+JSON.stringify(value),()=>assert.throws(()=>path(value)));
for(const source of ['a: 1\na: 2\n','a: &anchor value\nb: *anchor\n','a: !evil value\n','__proto__: value\n','a: {<<: value}\n'])test('reject unsafe YAML '+JSON.stringify(source),()=>assert.throws(()=>yaml(source)));
test('oversize packet and header rejected before staging',()=>{assert.throws(()=>parseReturn('x'.repeat(LIMITS.packet+1)));assert.throws(()=>yaml('a: '+ 'x'.repeat(LIMITS.yaml)));});
test('YAML depth and parser errors fail closed',()=>{assert.throws(()=>yaml('a: '+ '['.repeat(30)+'0'+']'.repeat(30)));assert.throws(()=>yaml('a: [unterminated'));});
test('identity and revision must match trusted dispatch',()=>{
  const x=dispatch();for(const [k,v] of [['assignment_id','another'],['dispatch_id','dispatch-another'],['stack_id','another'],['base_revision',3]])assert.throws(()=>stageReturn(x.handle,encodeReturn({...x.meta,[k]:v},x.files)));
});
test('missing attachment and original inventory mismatch fail',()=>{const x=scenario('research');assert.throws(()=>registerHandoff(x.castSource,''));assert.throws(()=>registerHandoff(x.castSource,x.context.replace('  - entries/source.md\n','')));});
test('handoff roundtrip follows original Carbon profile and keeps omissions',()=>{const x=scenario('research'), h=readHandoff(x.context);assert.equal(h.meta.omitted_files.length,2);assert.equal(decode(h.files.get('stack.yaml')),decode(fullFiles().get('stack.yaml')));assert.throws(()=>readHandoff(x.context+'extra'));});
test('unsupported protocol and ambiguous empty objective reject',()=>{const c=cast();assert.throws(()=>parseCast(dump({...c,objective:''})));assert.throws(()=>parseCast(dump({...c,format:'envoy.cast/v0.2'})));assert.throws(()=>parseCast(dump({...c,permissions:{...c.permissions,write_files:'yes'}})));});
test('prompt injection cannot authorize a deletion or manifest write',()=>{
  const x=dispatch();assert.match(contextFor(x.handle).files['entries/source.md'],/Ignore the Cast/);
  assert.throws(()=>stageReturn(x.handle,encodeReturn({...x.meta,replaces:[],deletes:['entries/source.md']},new Map())),/Unauthorized/);
  assert.throws(()=>encodeReturn({...x.meta,replaces:['stack.yaml']},new Map([['stack.yaml','revision: 999']])));
});
test('unapproved new path and path collisions reject',()=>{
  const x=dispatch();assert.throws(()=>stageReturn(x.handle,encodeReturn({...x.meta,creates:['entries/unapproved.md'],replaces:[]},new Map([['entries/unapproved.md',report]]))),/Unauthorized/);
  const c={...cast(),create:['ENTRIES/report.md'],required_files:[]};assert.throws(()=>registerHandoff(dump(c),handoff(c)),/collision/);
});
const impostor='---\nid: ent-impostor\nkind: research\n---\n# Replaced identity\n';
for(const [name,ops] of [
  ['delete + case-variant create',{deletes:['entries/findings.md'],creates:['entries/FINDINGS.md']}],
  ['delete + case-variant directory create',{deletes:['entries/findings.md'],creates:['ENTRIES/FINDINGS.md']}],
  ['delete + case-variant replace',{deletes:['entries/findings.md'],replaces:['Entries/Findings.md']}],
  ['rename source + case-variant create',{renames:[['entries/findings.md','entries/moved.md']],creates:['entries/Findings.md']}],
  ['rename target + case-variant replace',{renames:[['entries/mission.md','entries/moved.md']],replaces:['entries/MOVED.md']}],
  ['case-only rename',{renames:[['entries/findings.md','entries/FINDINGS.md']]}],
  ['deleted file reused as directory',{deletes:['entries/findings.md'],creates:['entries/findings.md/child.md']}]
])test('Return endpoints collide across lists: '+name,()=>{
  const m=receipt(cast(),{...ops,status:'partial'}),files=new Map([...(ops.creates||[]),...(ops.replaces||[])].map(p=>[p,impostor]));
  assert.throws(()=>encodeReturn(m,files),/collision/);assert.throws(()=>parseReturn(unchecked(m,files)),/collision/);
});
test('Cast cannot authorize a create or rename target aliasing existing paths or another target',()=>{
  for(const extra of [{create:['entries/FINDINGS.md']},{create:['ENTRIES/new.md']},{rename:[['entries/mission.md','entries/Source.md']]},
    {create:['archive/report.md'],rename:[['entries/mission.md','Archive/Report.md']]},{rename:[['entries/mission.md','archive/x.md'],['entries/source.md','archive/x.md']]},
    {create:['archive/a.md'],rename:[['entries/mission.md','archive/a.md/b.md']]}]){
    const c={...cast(),required_files:[],delete:['entries/findings.md'],...extra};
    assert.throws(()=>registerHandoff(dump(c),handoff(c)),/collision/);assert.throws(()=>registerStack(host(),dump(c),handoff(c)),/collision/);
  }
  const c={...cast(),required_files:[],create:['ARCHIVE/report.md']},stack=host();stack.directories.add('archive');
  registerHandoff(dump(c),handoff(c));assert.throws(()=>registerStack(stack,dump(c),handoff(c)),/collision/);
});
test('staging rejects a case-variant delete/create pair; the dispatch stays usable',()=>{
  const c={...cast('report'),delete:['entries/findings.md'],required_files:[]},h=registerHandoff(dump(c),handoff(c));
  const m=receipt(c,{deletes:['entries/findings.md'],creates:['entries/FINDINGS.md']}),files=new Map([['entries/FINDINGS.md',impostor]]);
  assert.equal(unchecked(receipt(c,{creates:['entries/report.md']}),new Map([['entries/report.md',report]])),encodeReturn(receipt(c,{creates:['entries/report.md']}),new Map([['entries/report.md',report]])));
  assert.throws(()=>stageReturn(h,unchecked(m,files)),/collision/);
  const ok=stageReturn(h,encodeReturn({...m,creates:['entries/report.md']},new Map([['entries/report.md',report]])));
  assert.deepEqual(ok.changes.map(x=>[x.op,x.path]),[['delete','entries/findings.md'],['create','entries/report.md']]);
});
test('complete-Stack acceptance rejects a case-colliding Return before any Stack change',()=>{
  const c={...cast('report'),delete:['entries/findings.md'],required_files:[]},calls=[],stack={...host(),change:x=>{calls.push(x);return {manifest:{revision:5}};}};
  const before=new Map([...stack.files].map(([p,b])=>[p,b.slice()])),h=registerStack(stack,dump(c),handoff(c));
  const m=receipt(c,{deletes:['entries/findings.md'],creates:['entries/FINDINGS.md']});
  assert.throws(()=>acceptInCarbon(stack,h,unchecked(m,new Map([['entries/FINDINGS.md',impostor]])),{approved:true}),/collision/);
  assert.equal(calls.length,0);assert.deepEqual(stack.files,before);assert.equal(stack.manifest.revision,4);
});
test('replacement preserves raw frontmatter comments and identity',()=>{
  const x=dispatch();assert.throws(()=>stageReturn(x.handle,encodeReturn(x.meta,new Map([['entries/findings.md',x.files.get('entries/findings.md').replace('ent-harbor-findings','other-id')]]))),/frontmatter/);
});
test('new managed IDs required and duplicate IDs rejected',()=>{
  const x=dispatch('report');assert.throws(()=>stageReturn(x.handle,encodeReturn(x.meta,new Map([['entries/report.md','# plain']]))),/ID/);
  assert.throws(()=>stageReturn(x.handle,encodeReturn(x.meta,new Map([['entries/report.md',report.replace('ent-harbor-report','ent-harbor-source')]]))),/Duplicate/);
});
test('full base detects same-revision conflicts including omitted bytes and directory state',()=>{
  const x=scenario('research'),stack=host(),h=registerStack(stack,x.castSource,x.context);
  assert.equal(stageReturn(h,x.source,stack).changes.length,1);
  stack.files.get('assets/marker.bin')[0]=17;assert.throws(()=>stageReturn(h,x.source,stack),/Conflicting/);
  const other=host();other.directories.add('empty');assert.throws(()=>stageReturn(h,x.source,other),/Stale/);
});
test('duplicate new ID in omitted Entry is detected with full Stack',()=>{
  const x=scenario('report'),stack=host(),h=registerStack(stack,x.castSource,x.context);
  assert.throws(()=>stageReturn(h,encodeReturn(x.meta,new Map([['entries/report.md',report.replace('ent-harbor-report','ent-retained')]])),stack),/Duplicate/);
});
test('context copies cannot mutate the trusted Cast',()=>{
  const x=dispatch(),copy=contextFor(x.handle);copy.cast.create.push('entries/evil.md');copy.files['entries/source.md']='changed';
  assert.ok(!contextFor(x.handle).cast.create.includes('entries/evil.md'));assert.notEqual(contextFor(x.handle).files['entries/source.md'],'changed');
});
test('overlapping operations and false structural completion rejected',()=>{
  const c=cast();assert.throws(()=>encodeReturn(receipt(c,{deletes:['entries/findings.md'],replaces:['entries/findings.md']}),new Map()));
  assert.throws(()=>encodeReturn(receipt(c,{questions:['Still missing source']}),new Map()));
});
test('partial handle cannot accept and approval is always explicit',()=>{
  const x=dispatch();assert.throws(()=>acceptInCarbon(host(),x.handle,x.source),/approval/);
  assert.throws(()=>acceptInCarbon(host(),x.handle,x.source,{approved:true}),/incomplete/);
});
test('explicit delete and rename stage independently, preserve renamed bytes',()=>{
  const c={...cast(),required_files:[],delete:['entries/findings.md'],rename:[['entries/mission.md','entries/mission-moved.md']]};
  const h=registerHandoff(dump(c),handoff(c));
  const out=stageReturn(h,encodeReturn(receipt(c,{deletes:c.delete,renames:c.rename}),new Map()));
  assert.deepEqual(out.changes.map(x=>x.op),['delete','rename']);assert.equal(out.changes[1].before,out.changes[1].after);
});

test('complete status requires all user-declared deliverable files',()=>{const x=dispatch('report');assert.throws(()=>stageReturn(x.handle,encodeReturn({...x.meta,creates:[]},new Map())),/missing required/);});
test('ordinary Markdown leading thematic break matches merged Carbon behavior',()=>{
  const c=cast(),files=fullFiles();files.set('entries/findings.md',encode('---\n# Plain note\nKeep this source.\n'));const h=registerHandoff(dump(c),handoff(c,files));const m=receipt(c,{replaces:['entries/findings.md']});assert.equal(stageReturn(h,encodeReturn(m,new Map([['entries/findings.md','---\n# Plain note\nKeep this source.\nMore notes.\n']]))).changes.length,1);
});
