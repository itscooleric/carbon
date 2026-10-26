/**
 * Offline proof-of-concept UI. Imported text is rendered only with textContent.
 *
 * Bundled by `scripts/build.mjs` into `dist/cast-kit.html` with a sha256 CSP and no
 * network access. The build defines `__EXAMPLES__`, `__RECOVERY__`, `__RECEIPT__`,
 * `__PLAYBOOKS__`, `__CONTRACT__` and `__BOOTSTRAP__` as JSON literals. Every pasted or
 * loaded packet is untrusted: it only ever reaches the DOM through `textContent` or
 * `<textarea>.value`, and every action is wrapped in {@link guard} so a validation error
 * clears the stage and shows `Rejected: <message>` instead of throwing.
 */
import {parseCast,readHandoff,registerHandoff,stageReturn,encodeReturn,dump,LIMITS} from './kit.mjs';
import {composeDispatch,dispatchTar} from './dispatch.mjs';
import {runLoop,mockAdapter} from './loop.mjs';
/** @param {string} id @returns {HTMLElement} */
const $=id=>document.getElementById(id);
/** @type {import('./kit.mjs').StageResult|null} Last successful stageReturn result. */
let staged=null;
/** @type {AbortController|null} Active mock run, used by the Stop button. */
let active=null;
/** @param {string} text Status line text; never HTML. */
function status(text){$('status').textContent=text;}
/** Drop the staged result and clear the review pane. Called on every input change. */
function clearStage(){staged=null;$('review').replaceChildren();}
/**
 * Offer bytes as a download through a short-lived object URL.
 * @param {string} name
 * @param {string|Uint8Array} bytes
 * @param {string} [type='text/plain;charset=utf-8']
 */
function save(name,bytes,type='text/plain;charset=utf-8') {
  const url=URL.createObjectURL(new Blob([bytes],{type}));
  const a=document.createElement('a');
  a.href=url;a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
/**
 * Wrap a UI action so any thrown validation error is shown, not swallowed or escalated.
 * @param {() => (void|Promise<void>)} fn
 * @returns {() => Promise<void>}
 */
function guard(fn){return async()=>{try{await fn();}catch(e){clearStage();status('Rejected: '+e.message);}};}
/**
 * Build a partial Return template that repeats the Cast identity, for a composed Dispatch.
 * @param {import('./kit.mjs').Cast} c
 * @returns {string} Return packet with no files.
 */
function template(c){
  const m=structuredClone(__RECEIPT__);
  for(const k of ['assignment_id','dispatch_id','stack_id','base_revision','objective'])m[k]=c[k];
  m.status='partial';
  m.summary='Replace this summary with actual progress.';
  m.checkpoint_id='checkpoint-'+crypto.randomUUID();
  m.parent_checkpoint=null;
  for(const k of ['accepted','evidence','decisions','completed','questions','blockers','verification','errors','operations_performed'])m[k]=[];
  m.capabilities=[];
  m.next=['Continue the assigned work.'];
  return encodeReturn(m,new Map());
}
// Built-in Playbook checkboxes and example selector are generated from build-time constants.
for(const [name,p] of Object.entries(__PLAYBOOKS__)) {const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.value=name;label.append(box,document.createTextNode(' '+name));$('playbooks').append(label);}
for(const kind of Object.keys(__EXAMPLES__)) {const o=document.createElement('option');o.value=kind;o.textContent=kind;$('example').append(o);}
$('load').onclick=guard(()=>{
  const x=__EXAMPLES__[$('example').value];
  $('cast').value=x.castSource;$('context').value=x.context;$('return').value=x.source;
  $('objective').value=x.cast.objective;$('criterion').value=x.cast.completion.join('\n');
  clearStage();status('Fictional example loaded. Original binary Assets remain in the example Stack.');
});
for(const target of ['cast','context','return']){
  $(target).addEventListener('input',clearStage);
  $(target+'file').onchange=guard(async()=>{const f=$(target+'file').files[0];if(!f)return;if(f.size>LIMITS.packet)throw Error('File exceeds packet limit');$(target).value=await f.text();clearStage();status('Loaded '+f.name);});
}
// Create a Cast from the loaded handoff plus the form's objective, criteria, output path and Playbooks.
$('create').onclick=guard(()=>{
  const h=readHandoff($('context').value), objective=$('objective').value.trim(),completion=$('criterion').value.split('\n').map(x=>x.trim()).filter(Boolean),out=$('outputpath').value.trim();
  const selectedPlaybooks=[...$('playbooks').querySelectorAll('input:checked')].map(x=>({name:x.value,source:'builtin:'+x.value,content:__PLAYBOOKS__[x.value]}));
  const c={
    format:'envoy.cast/v0.1',contract:'envoy.operating/v0.1',
    assignment_id:'cast-'+crypto.randomUUID(),dispatch_id:h.meta.dispatch_id,stack_id:h.meta.stack_id,base_revision:h.meta.base_revision,
    mission:null,objective,read:h.meta.included_files,
    replace:[],create:out?[out]:[],delete:[],rename:[],
    outputs:out?['Complete Markdown report at '+out]:['Conversational answer in Return summary and evidence'],
    constraints:['Preserve sources and accepted decisions.'],
    permissions:{network:false,execute:false,write_files:false,transmit_to:[]},
    completion,return_format:'envoy.return/v0.1',playbooks:selectedPlaybooks,metadata:[],assets:[],required_files:out?[out]:[]
  };
  $('cast').value=dump(c);registerHandoff($('cast').value,$('context').value);clearStage();status('Cast created. Review its scope below. Mission and advanced permissions are editable in YAML.');
});
/** Compose a text Dispatch from the current Cast and context textareas. */
function compose(){const c=parseCast($('cast').value);return composeDispatch({castSource:$('cast').value,originalHandoff:$('context').value,contract:__CONTRACT__,bootstrap:__BOOTSTRAP__,returnTemplate:template(c)});}
$('compose').onclick=guard(()=>{const out=compose();$('dispatch').value=out.text;status('Dispatch prepared. Copy the complete text to an authorized chat; retain the original Stack.');});
$('downloadDispatch').onclick=guard(()=>save('assignment.dispatch.md',compose().text));
$('downloadTar').onclick=guard(()=>save('assignment.dispatch.tar',dispatchTar(compose().files),'application/x-tar'));
// Stage the pasted Return against a fresh partial handle and render before/after text per change.
$('stage').onclick=guard(()=>{
  const handle=registerHandoff($('cast').value,$('context').value);staged=stageReturn(handle,$('return').value);$('review').replaceChildren();
  const summary=document.createElement('pre');summary.textContent=dump(staged.meta);$('review').append(summary);
  for(const change of staged.changes){const section=document.createElement('section'),heading=document.createElement('h3');heading.textContent=change.op+': '+change.path+(change.to?' → '+change.to:'');section.append(heading);
    for(const [title,body] of [['Before',change.before],['Proposed',change.after]]){const label=document.createElement('h4'),pre=document.createElement('pre');label.textContent=title;pre.textContent=body===null?'(absent)':body;section.append(label,pre);}
    if(change.op==='create'||change.op==='replace'){const b=document.createElement('button');b.textContent='Download proposed '+change.path;b.onclick=()=>save(change.path.split('/').pop(),change.after);section.append(b);}
    $('review').append(section);
  }
  status('Staged for review: '+staged.changes.length+' changes. '+staged.warnings.join(' '));
});
$('downloadReturn').onclick=guard(()=>{stageReturn(registerHandoff($('cast').value,$('context').value),$('return').value);save('result.return.md',$('return').value);});
// Two-step deterministic mock run over the recovery fixture; nothing is accepted.
$('mock').onclick=guard(async()=>{
  if(active)throw Error('A mock run is already active');active=new AbortController();$('mock').disabled=true;
  try{
    const r=__RECOVERY__,h=registerHandoff(r.castSource,r.context);
    status('Running two deterministic mock interactions.');
    const result=await runLoop({handle:h,adapter:mockAdapter([r.first,r.second]),contract:__CONTRACT__,bootstrap:__BOOTSTRAP__,maxTokens:300000,maxOutputTokens:12000,signal:active.signal});
    $('cast').value=r.castSource;$('context').value=r.context;$('return').value=result.lastReturn||'';
    clearStage();status('Mock: '+result.reason+'; calls='+result.steps+'; reserved mock byte units='+result.charged+'. No Stack accepted.');
  }finally{active=null;$('mock').disabled=false;}
});
$('stop').onclick=()=>active?.abort();
