/** Reproducible fixture metrics, not model benchmarking. Usage: node cast-kit/scripts/measure.mjs */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {scenario,recovery} from '../tests/fixtures.mjs';
import {registerHandoff,stageReturn} from '../src/kit.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=p=>readFile(root+p,'utf8');const contract=await read('operating-contract-v0.1.md'),bootstrap=await read('bootstrap.md');
const bytes=s=>Buffer.byteLength(s),words=s=>s.trim().split(/\s+/u).length;
const output={method:'Deterministic fixture validation; no actual provider runs. Token figures are UTF-8 bytes / 4 English-text estimates, not measured tokenizer counts.',provider_runs:0,contract_bytes:bytes(contract),bootstrap_bytes:bytes(bootstrap),bootstrap_words:words(bootstrap),scenarios:[]};
for(const kind of ['research','registry','report','restricted','recovery']) {
  const x=kind==='recovery'?recovery():scenario(kind),source=kind==='recovery'?x.second:x.source;
  const result=stageReturn(registerHandoff(x.castSource,x.context),source);
  const controls=contract+bootstrap+x.castSource;
  output.scenarios.push({scenario:kind,valid:true,simulation:true,required_files_present:true,proposed_files:result.files.size,control_bytes:bytes(controls),context_bytes:bytes(x.context),return_bytes:bytes(source),estimated_control_tokens:Math.ceil(bytes(controls)/4),estimated_return_tokens:Math.ceil(bytes(source)/4),retained_accepted_fact:result.meta.accepted.some(x=>x.includes('dataset is fictional')),user_effort:'Scripted lab path: select example, load, stage, download (4 actions). Real human completion time not measured.'});
}
await mkdir(root+'docs/evidence',{recursive:true});await writeFile(root+'docs/evidence/fixture-metrics.json',JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));
