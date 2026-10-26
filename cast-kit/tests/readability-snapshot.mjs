/**
 * Pins observable Cast Kit behavior for the readability refactor (issue #6).
 * Run `node cast-kit/tests/readability-snapshot.mjs > cast-kit/tests/readability.snapshot.json`
 * only from a known-good module version; `readability.test.mjs` compares against the saved file.
 * Covers the four Return scenarios and recovery (partial and full handles), acceptance
 * records, Dispatch composition, and the exact thrown message (fail-closed order) for a
 * battery of hostile inputs. No provider or network calls.
 */
import {parseCast,parseReturn,encodeReturn,readHandoff,registerHandoff,registerStack,stageReturn,acceptInCarbon,contextFor,dump,LIMITS} from '../src/kit.mjs';
import {composeDispatch,dispatchTar} from '../src/dispatch.mjs';
import {yaml,path,encode,decode,entry,patchScalarFrontmatter} from '../src/validation.mjs';
import {scenario,recovery,cast,receipt,handoff,fullFiles,report,mission,unchecked} from './fixtures.mjs';
import {readFile} from 'node:fs/promises';
const host=()=>({files:fullFiles(),manifest:{id:'stk-harbor-demo',revision:4},directories:new Set(['entries','assets'])});
const plain=stage=>({meta:stage.meta,changes:stage.changes,files:[...stage.files],warnings:stage.warnings});
const message=fn=>{try{fn();return null;}catch(e){return e.message;}};
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
export async function snapshot() {
  const out={stage:{},context:{},acceptance:{},errors:{},dispatch:{}};
  for(const kind of ['research','registry','report','restricted']){
    const x=scenario(kind);
    out.stage[kind+':partial']=plain(stageReturn(registerHandoff(x.castSource,x.context),x.source));
    const stack=host();
    out.stage[kind+':full']=plain(stageReturn(registerStack(stack,x.castSource,x.context),x.source,stack));
    out.context[kind]=contextFor(registerHandoff(x.castSource,x.context));
    const calls=[],fake={...host(),change:c=>{calls.push({writes:[...c.writes].map(([p,b])=>[p,decode(b)]),deletes:c.deletes,moves:c.moves});return {manifest:{revision:5}};}};
    const r=acceptInCarbon(fake,registerStack(fake,x.castSource,x.context),x.source,{approved:true});
    out.acceptance[kind]={acceptance:r.acceptance,receiptIsSource:r.receipt===x.source,previousIsStack:r.previous===fake,calls};
  }
  const r=recovery();
  out.stage['recovery:first']=plain(stageReturn(registerHandoff(r.castSource,r.context),r.first));
  out.stage['recovery:second']=plain(stageReturn(registerHandoff(r.castSource,r.context),r.second));
  const rn={...cast(),required_files:[],delete:['entries/findings.md'],rename:[['entries/mission.md','entries/mission-moved.md']]};
  out.stage['rename-delete:partial']=plain(stageReturn(registerHandoff(dump(rn),handoff(rn)),encodeReturn(receipt(rn,{deletes:rn.delete,renames:rn.rename}),new Map())));
  const md=scenario('research');md.cast.replace=['entries/mission.md'];md.cast.required_files=['entries/mission.md'];md.cast.metadata=[{path:'entries/mission.md',keys:['kind']}];
  const front=entry(mission).frontmatter,changed=mission.replace(front,patchScalarFrontmatter(front,'kind','plan'));
  out.stage['metadata:partial']=plain(stageReturn(registerHandoff(dump(md.cast),handoff(md.cast)),encodeReturn(receipt(md.cast,{replaces:['entries/mission.md']}),new Map([['entries/mission.md',changed]]))));
  const x=scenario('research'),h=registerHandoff(x.castSource,x.context),impostor='---\nid: ent-impostor\nkind: research\n---\n# Replaced identity\n';
  const rep=scenario('report'),hr=registerHandoff(rep.castSource,rep.context);
  const E=out.errors;
  for(const [name,mutate] of [
    ['missing footer',s=>s.slice(0,s.lastIndexOf('<!-- envoy-cast:complete'))],['truncated body',s=>s.slice(0,-150)],['trailing prose',s=>s+'done'],
    ['missing file',s=>s.replace(/<!-- envoy-cast:file[\s\S]*?<!-- envoy-cast:end[^\n]+\n\n/,'')],['wrong path encoding',s=>s.replace('entries%2Ffindings.md','entries/findings.md')],
    ['wrong count',s=>s.replace('files="1"','files="0"')],['whole packet CRLF',s=>s.replaceAll('\n','\r\n')],['extra frame',s=>s+s.slice(s.indexOf('<!-- envoy-cast:file'))],
    ['duplicate metadata',s=>s.replace('format: envoy.return/v0.1','format: envoy.return/v0.1\nformat: envoy.return/v0.1')],['unknown field',s=>s.replace('format: envoy.return/v0.1','format: envoy.return/v0.1\napproved: true')],
    ['wrong version',s=>s.replace('format: envoy.return/v0.1','format: envoy.return/v0.2')],['bad status',s=>s.replace('status: complete','status: done')],
    ['self parent',s=>s.replace('parent_checkpoint: null','parent_checkpoint: checkpoint-cast-harbor-research-1')],['bad boundary',s=>s.replaceAll('harbor-return-boundary-0001','short')],
    ['oversize',s=>'x'.repeat(LIMITS.packet+1)],['handoff header',s=>x.context]
  ])E['parseReturn:'+name]=message(()=>parseReturn(mutate(x.source)));
  E['parseReturn:reordered']=message(()=>parseReturn(scenario('registry').source.replace('path="entries%2Fentity.md"','path="entries%2Ffindings.md"')));
  E['encodeReturn:boundary in body']=message(()=>encodeReturn({...receipt(),creates:['entries/report.md']},new Map([['entries/report.md',receipt().boundary]])));
  E['encodeReturn:inventory mismatch']=message(()=>encodeReturn(receipt(),new Map([['entries/report.md','x']])));
  E['encodeReturn:overlap']=message(()=>encodeReturn(receipt(cast(),{deletes:['entries/findings.md'],replaces:['entries/findings.md']}),new Map()));
  E['encodeReturn:false completion']=message(()=>encodeReturn(receipt(cast(),{questions:['Still missing source']}),new Map()));
  E['encodeReturn:manifest write']=message(()=>encodeReturn({...x.meta,replaces:['stack.yaml']},new Map([['stack.yaml','revision: 999']])));
  E['encodeReturn:rename same']=message(()=>encodeReturn(receipt(cast(),{renames:[['entries/a.md','entries/a.md']]}),new Map()));
  E['encodeReturn:rename shape']=message(()=>encodeReturn(receipt(cast(),{renames:[['entries/a.md']]}),new Map()));
  for(const [name,ops] of [
    ['delete + case-variant create',{deletes:['entries/findings.md'],creates:['entries/FINDINGS.md']}],['delete + case-variant directory create',{deletes:['entries/findings.md'],creates:['ENTRIES/FINDINGS.md']}],
    ['delete + case-variant replace',{deletes:['entries/findings.md'],replaces:['Entries/Findings.md']}],['rename source + case-variant create',{renames:[['entries/findings.md','entries/moved.md']],creates:['entries/Findings.md']}],
    ['rename target + case-variant replace',{renames:[['entries/mission.md','entries/moved.md']],replaces:['entries/MOVED.md']}],['case-only rename',{renames:[['entries/findings.md','entries/FINDINGS.md']]}],
    ['deleted file reused as directory',{deletes:['entries/findings.md'],creates:['entries/findings.md/child.md']}]
  ]){const m=receipt(cast(),{...ops,status:'partial'}),files=new Map([...(ops.creates||[]),...(ops.replaces||[])].map(p=>[p,impostor]));E['encode collide:'+name]=message(()=>encodeReturn(m,files));E['parse collide:'+name]=message(()=>parseReturn(unchecked(m,files)));}
  for(const [k,v] of [['assignment_id','another'],['dispatch_id','dispatch-another'],['stack_id','another'],['base_revision',3],['objective','Other objective.']])E['stage identity:'+k]=message(()=>stageReturn(h,encodeReturn({...x.meta,[k]:v},x.files)));
  E['stage:unauthorized delete']=message(()=>stageReturn(h,encodeReturn({...x.meta,replaces:[],deletes:['entries/source.md']},new Map())));
  E['stage:unauthorized create']=message(()=>stageReturn(h,encodeReturn({...x.meta,creates:['entries/unapproved.md'],replaces:[]},new Map([['entries/unapproved.md',report]]))));
  E['stage:unauthorized replace']=message(()=>stageReturn(h,encodeReturn({...x.meta,replaces:['entries/source.md']},new Map([['entries/source.md',x.files.get('entries/findings.md')]]))));
  E['stage:unauthorized rename']=message(()=>stageReturn(h,encodeReturn({...x.meta,replaces:[],renames:[['entries/mission.md','entries/moved.md']]},new Map())));
  E['stage:missing required']=message(()=>stageReturn(hr,encodeReturn({...rep.meta,creates:[]},new Map())));
  E['stage:frontmatter id']=message(()=>stageReturn(h,encodeReturn(x.meta,new Map([['entries/findings.md',x.files.get('entries/findings.md').replace('ent-harbor-findings','other-id')]]))));
  E['stage:frontmatter drop']=message(()=>stageReturn(h,encodeReturn(x.meta,new Map([['entries/findings.md','# no frontmatter\n']]))));
  E['stage:new id required']=message(()=>stageReturn(hr,encodeReturn(rep.meta,new Map([['entries/report.md','# plain']]))));
  E['stage:duplicate id']=message(()=>stageReturn(hr,encodeReturn(rep.meta,new Map([['entries/report.md',report.replace('ent-harbor-report','ent-harbor-source')]]))));
  E['stage:unknown handle']=message(()=>stageReturn({},x.source));
  E['stage:collision']=message(()=>{const c={...cast('report'),delete:['entries/findings.md'],required_files:[]},hh=registerHandoff(dump(c),handoff(c));stageReturn(hh,unchecked(receipt(c,{deletes:['entries/findings.md'],creates:['entries/FINDINGS.md']}),new Map([['entries/FINDINGS.md',impostor]])));});
  {const mh=registerHandoff(dump(md.cast),handoff(md.cast)),m=receipt(md.cast,{replaces:['entries/mission.md']});
    E['metadata:id change']=message(()=>stageReturn(mh,encodeReturn(m,new Map([['entries/mission.md',changed.replace('ent-harbor-mission','new-id')]]))));
    E['metadata:comment change']=message(()=>stageReturn(mh,encodeReturn(m,new Map([['entries/mission.md',changed.replace('keep-me','changed')]]))));
    const sc={...x.cast,metadata:[{path:'entries/findings.md',keys:['status']}]},sh=registerHandoff(dump(sc),handoff(sc));
    E['metadata:added key']=message(()=>stageReturn(sh,encodeReturn(x.meta,new Map([['entries/findings.md',x.files.get('entries/findings.md').replace('kind: research','kind: research\nstatus: active')]]))));}
  {const stack=host(),fh=registerStack(stack,x.castSource,x.context);
    const broken=host();broken.files.get('assets/marker.bin')[0]=17;E['full:conflicting bytes']=message(()=>stageReturn(fh,x.source,broken));
    const other=host();other.directories.add('empty');E['full:directory state']=message(()=>stageReturn(fh,x.source,other));
    const moved=host();moved.manifest.revision=5;E['full:revision']=message(()=>stageReturn(fh,x.source,moved));
    const extra=host();extra.files.set('entries/new.md',encode('x'));E['full:inventory']=message(()=>stageReturn(fh,x.source,extra));
    const rs=host(),rh=registerStack(rs,rep.castSource,rep.context);
    E['full:duplicate omitted id']=message(()=>stageReturn(rh,encodeReturn(rep.meta,new Map([['entries/report.md',report.replace('ent-harbor-report','ent-retained')]])),rs));
    E['accept:no approval']=message(()=>acceptInCarbon(host(),h,x.source));
    E['accept:partial handle']=message(()=>acceptInCarbon(host(),h,x.source,{approved:true}));
    E['accept:unknown handle']=message(()=>acceptInCarbon(host(),{},x.source,{approved:true}));
    E['accept:zero ops']=message(()=>acceptInCarbon(stack,fh,encodeReturn({...x.meta,replaces:[]},new Map()),{approved:true}));
    E['accept:checkpoint only']=message(()=>acceptInCarbon(stack,fh,encodeReturn({...x.meta,status:'partial',replaces:[]},new Map()),{approved:true}));
    E['accept:stale']=message(()=>acceptInCarbon({...stack,manifest:{id:'stk-harbor-demo',revision:5}},fh,x.source,{approved:true}));}
  E['register:empty context']=message(()=>registerHandoff(x.castSource,''));
  E['register:inventory']=message(()=>registerHandoff(x.castSource,x.context.replace('  - entries/source.md\n','')));
  E['register:identity']=message(()=>registerHandoff(dump({...x.cast,base_revision:3}),x.context));
  E['register:read scope']=message(()=>registerHandoff(dump({...x.cast,read:x.cast.read.slice(0,-1),replace:[],required_files:[]}),x.context));
  for(const extra of [{create:['entries/FINDINGS.md']},{create:['ENTRIES/new.md']},{rename:[['entries/mission.md','entries/Source.md']]},
    {create:['archive/report.md'],rename:[['entries/mission.md','Archive/Report.md']]},{rename:[['entries/mission.md','archive/x.md'],['entries/source.md','archive/x.md']]},{create:['archive/a.md'],rename:[['entries/mission.md','archive/a.md/b.md']]}]){
    const c={...cast(),required_files:[],delete:['entries/findings.md'],...extra};E['register collide:'+JSON.stringify(extra)]=message(()=>registerHandoff(dump(c),handoff(c)));E['registerStack collide:'+JSON.stringify(extra)]=message(()=>registerStack(host(),dump(c),handoff(c)));}
  {const c={...cast(),required_files:[],create:['ARCHIVE/report.md']},stack=host();stack.directories.add('archive');E['registerStack:directory collide']=message(()=>registerStack(stack,dump(c),handoff(c)));
    E['registerStack:stale']=message(()=>registerStack({...host(),manifest:{id:'stk-harbor-demo',revision:5}},x.castSource,x.context));
    const s2=host();s2.files.set('entries/extra.md',encode('x'));E['registerStack:inventory']=message(()=>registerStack(s2,x.castSource,x.context));
    const s3=host();s3.files.set('entries/source.md',encode('changed'));E['registerStack:conflict']=message(()=>registerStack(s3,x.castSource,x.context));}
  E['readHandoff:trailing']=message(()=>readHandoff(x.context+'extra'));
  E['readHandoff:return']=message(()=>readHandoff(x.source));
  E['readHandoff:framing']=message(()=>readHandoff(x.context.replace('framing: exact-v1','framing: exact-v2')));
  E['readHandoff:scope']=message(()=>readHandoff(x.context.replace('scope: selected-text','scope: full-text')));
  E['readHandoff:dispatch id']=message(()=>readHandoff(x.context.replace('dispatch_id: dispatch-harbor-research','dispatch_id: other')));
  E['readHandoff:truncated']=message(()=>readHandoff(x.context.slice(0,-40)));
  const c0=cast();
  for(const [name,mut] of [['empty objective',{objective:''}],['version',{format:'envoy.cast/v0.2'}],['permission type',{permissions:{...c0.permissions,write_files:'yes'}}],['unknown key',{extra:1}],
    ['asset entry',{assets:['entries/findings.md']}],['nine playbooks',{playbooks:Array.from({length:9},(_,i)=>({name:'p'+i,source:'s',content:'# c'}))}],['dup playbook',{playbooks:[{name:'same',source:'s',content:'# c'},{name:'same',source:'s',content:'# c'}]}],
    ['empty playbook',{playbooks:[{name:'p',source:'s',content:'  '}]}],['metadata id key',{metadata:[{path:'entries/findings.md',keys:['id']}]}],['metadata dup path',{metadata:[{path:'entries/findings.md',keys:['a']},{path:'entries/findings.md',keys:['b']}]}],
    ['metadata not replace',{metadata:[{path:'entries/mission.md',keys:['kind']}]}],['required not scoped',{required_files:['entries/other.md']}],['no completion',{completion:[]}],['mission unreadable',{mission:'entries/other.md'}],['bad id',{assignment_id:'-x'}],['bad revision',{base_revision:-1}],
    ['non markdown create',{create:['entries/report.txt'],required_files:[]}],['replace unreadable',{replace:['entries/retained.md'],required_files:[]}],['rename self',{rename:[['entries/mission.md','entries/mission.md']]}],['permissions keys',{permissions:{network:false}}],['transmit type',{permissions:{...c0.permissions,transmit_to:[1]}}]
  ]){const c={...c0,...mut};E['parseCast:'+name]=message(()=>parseCast(dump(c)));}
  {const c={...c0};delete c.mission;E['parseCast:missing key']=message(()=>parseCast(dump(c)));}
  for(const value of ['../outside.md','/absolute.md','C:/drive.md','x\\escape.md','a//b.md','a/./b.md','a/../b.md','a/NUL.md','a/.git/x.md','a/trailing .','a/\u202eevil.md','cafe\u0301.md',''])E['path:'+JSON.stringify(value)]=message(()=>path(value));
  for(const source of ['a: 1\na: 2\n','a: &anchor value\nb: *anchor\n','a: !evil value\n','__proto__: value\n','a: {<<: value}\n','- list\n','a: '+'['.repeat(30)+'0'+']'.repeat(30),'a: [unterminated','a: '+'x'.repeat(LIMITS.yaml)])E['yaml:'+JSON.stringify(source).slice(0,40)]=message(()=>yaml(source));
  // Dispatch composition
  const contract=await read('operating-contract-v0.1.md'),bootstrap=await read('bootstrap.md');
  const input=kind=>{const s=scenario(kind);return {castSource:s.castSource,originalHandoff:s.context,contract,bootstrap,returnTemplate:encodeReturn(receipt(s.cast,{status:'partial',accepted:[],evidence:[],decisions:[],completed:[],verification:[],capabilities:[]}),new Map())};};
  const text=composeDispatch(input('research'));
  out.dispatch.researchText=text.text;out.dispatch.researchManifest=text.manifest;out.dispatch.researchWarnings=text.warnings;out.dispatch.researchFiles=[...text.files].map(([p,b])=>[p,decode(b)]);
  const bin=scenario('report');bin.cast.assets=['assets/marker.bin'];
  const pkg=composeDispatch({...input('report'),castSource:dump(bin.cast),mode:'tar',assets:new Map([['assets/marker.bin',fullFiles().get('assets/marker.bin')]])});
  out.dispatch.withAssetsManifest=pkg.manifest;out.dispatch.withAssetsWarnings=pkg.warnings;out.dispatch.withAssetsTar=Buffer.from(dispatchTar(pkg.files)).toString('base64');
  const DE={};
  DE['mode']=message(()=>composeDispatch({...input('report'),mode:'zip'}));
  DE['contract']=message(()=>composeDispatch({...input('report'),contract:' '}));
  DE['template identity']=message(()=>composeDispatch({...input('report'),returnTemplate:input('research').returnTemplate}));
  DE['asset missing']=message(()=>composeDispatch({...input('report'),castSource:dump(bin.cast),mode:'files'}));
  DE['asset text']=message(()=>composeDispatch({...input('report'),castSource:dump(bin.cast),assets:new Map([['assets/marker.bin',fullFiles().get('assets/marker.bin')]])}));
  DE['asset unexpected']=message(()=>composeDispatch({...input('report'),mode:'files',assets:new Map([['assets/marker.bin',fullFiles().get('assets/marker.bin')]])}));
  DE['asset bytes']=message(()=>composeDispatch({...input('report'),castSource:dump(bin.cast),mode:'files',assets:new Map([['assets/marker.bin','text']])}));
  DE['tar no manifest']=message(()=>dispatchTar(new Map([['a.md',encode('x')]])));
  DE['tar stack']=message(()=>dispatchTar(new Map([['dispatch.yaml',encode('x')],['stack.yaml',encode('x')]])));
  DE['tar long path']=message(()=>dispatchTar(new Map([['dispatch.yaml',encode('x')],['a'.repeat(90)+'.md',encode('x')]])));
  DE['tar not bytes']=message(()=>dispatchTar(new Map([['dispatch.yaml','x']])));
  out.dispatch.errors=DE;
  return out;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href)process.stdout.write(JSON.stringify(await snapshot(),null,1)+'\n');
