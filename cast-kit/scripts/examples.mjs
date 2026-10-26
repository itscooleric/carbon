/** Regenerate public fixtures and templates. Usage: npm --prefix cast-kit run examples */
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {scenario,recovery,fullFiles,cast,receipt} from '../tests/fixtures.mjs';
import {dump,encodeReturn} from '../src/kit.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
async function save(p,s){await mkdir(root+p.slice(0,p.lastIndexOf('/')),{recursive:true});await writeFile(root+p,s);}
for(const kind of ['research','registry','report','restricted']){
  const x=scenario(kind);await save(`examples/${kind}/assignment.cast.yaml`,x.castSource);await save(`examples/${kind}/original.handoff.md`,x.context);await save(`examples/${kind}/result.return.md`,x.source);
}
const r=recovery();await save('examples/recovery/assignment.cast.yaml',r.castSource);await save('examples/recovery/original.handoff.md',r.context);await save('examples/recovery/session-1.return.md',r.first);await save('examples/recovery/session-2.return.md',r.second);
for(const [p,b] of fullFiles())await save('examples/harbor.stack/'+p,b);
await save('templates/assignment.cast.yaml',dump(cast()));
await save('templates/receipt.return.md',encodeReturn(receipt(cast(),{status:'partial',summary:'Replace this summary with actual progress.',accepted:[],decisions:[],capabilities:[],completed:[],evidence:[],verification:[],next:['Continue the assigned work.']}),new Map()));
const {readFile}=await import('node:fs/promises');
const {composeDispatch,dispatchTar}=await import('../src/dispatch.mjs');
const {planningFixture}=await import('../tests/planning-fixture.mjs');
const contract=await readFile(root+'operating-contract-v0.1.md','utf8'),bootstrap=await readFile(root+'bootstrap.md','utf8');
function dispatchFor(x,mode='text',assets=new Map()){return composeDispatch({castSource:x.castSource,originalHandoff:x.context,contract,bootstrap,returnTemplate:encodeReturn(receipt(x.cast,{status:'partial',accepted:[],evidence:[],decisions:[],completed:[],verification:[],capabilities:[]}),new Map()),mode,assets});}
await save('examples/research/complete.dispatch.md',dispatchFor(scenario('research')).text);
const playbooks=[];for(const name of ['research','planning'])playbooks.push({name,source:'builtin:'+name,content:await readFile(root+'playbooks/'+name+'.md','utf8')});
const plan=planningFixture(playbooks);
for(const name of ['first','second','resume']){const x=plan[name];await save(`examples/planning/${name}.cast.yaml`,x.castSource);await save(`examples/planning/${name}.handoff.md`,x.context);await save(`examples/planning/${name}.dispatch.md`,dispatchFor(x).text);if(x.source)await save(`examples/planning/${name}.return.md`,x.source);}
const binary=scenario('report');binary.cast.assets=['assets/marker.bin'];binary.castSource=dump(binary.cast);const packageFiles=dispatchFor(binary,'tar',new Map([['assets/marker.bin',fullFiles().get('assets/marker.bin')]]));await save('examples/with-assets/selected.dispatch.tar',dispatchTar(packageFiles.files));await save('examples/with-assets/dispatch.yaml',dump(packageFiles.manifest));
