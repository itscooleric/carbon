/** Build one offline HTML artifact. Usage: npm --prefix cast-kit run build */
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {scenario,recovery,receipt} from '../tests/fixtures.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const read=p=>readFile(root+p,'utf8');const playbooks={};for(const name of (await readdir(root+'playbooks')).sort())playbooks[name.replace('.md','')]=await read('playbooks/'+name);
const values={__EXAMPLES__:Object.fromEntries(['research','registry','report','restricted'].map(k=>{const x=scenario(k);return [k,{cast:x.cast,castSource:x.castSource,context:x.context,source:x.source}];})),__RECOVERY__:recovery(),__RECEIPT__:receipt(),__PLAYBOOKS__:playbooks,__CONTRACT__:await read('operating-contract-v0.1.md'),__BOOTSTRAP__:await read('bootstrap.md')};
const result=await build({entryPoints:[root+'src/workbench.mjs'],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',minify:true,legalComments:'inline',define:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,JSON.stringify(v)]))});
const script=result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
const hash=createHash('sha256').update(script).digest('base64');
const license=await readFile(require.resolve('yaml').replace(/dist\/index\.js$/,'LICENSE'),'utf8');
const html=(await read('src/workbench.html')).replace('__CSP__',`default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'`).replace('__NOTICES__',('Envoy Cast Kit: MIT\n'+await read('LICENSE')+'\nBundled yaml 2.9.1: ISC\n'+license).replaceAll('&','&amp;').replaceAll('<','&lt;')).replace('__SCRIPT__',()=>script);
await mkdir(root+'dist',{recursive:true});await writeFile(root+'dist/cast-kit.html',html);console.log('Built cast-kit.html ('+Buffer.byteLength(html)+' bytes), no runtime network dependencies.');
