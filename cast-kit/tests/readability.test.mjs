/**
 * Regression pins for the readability refactor (issue #6): the reformatted modules must
 * produce byte-identical staging results, acceptance records, Dispatch packages and
 * fail-closed error messages. `readability.snapshot.json` was generated from the
 * pre-refactor modules by `readability-snapshot.mjs`; regenerate it only on a deliberate
 * protocol change. Published examples (`examples/research/complete.dispatch.md`,
 * `examples/with-assets/*`) are compared as independent, committed evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {snapshot} from './readability-snapshot.mjs';
import {composeDispatch,dispatchTar} from '../src/dispatch.mjs';
import {dump,encodeReturn} from '../src/kit.mjs';
import {yaml,decode} from '../src/validation.mjs';
import {scenario,receipt,fullFiles} from './fixtures.mjs';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const expected=JSON.parse(await read('tests/readability.snapshot.json'));
const actual=await snapshot();
for(const key of Object.keys(expected.stage))test('stageReturn result unchanged: '+key,()=>{assert.deepEqual(actual.stage[key],expected.stage[key]);});
test('stageReturn snapshot covers no extra or missing scenarios',()=>{assert.deepEqual(Object.keys(actual.stage),Object.keys(expected.stage));});
for(const key of Object.keys(expected.context))test('contextFor result unchanged: '+key,()=>{assert.deepEqual(actual.context[key],expected.context[key]);});
for(const key of Object.keys(expected.acceptance))test('acceptInCarbon record and Stack.change arguments unchanged: '+key,()=>{assert.deepEqual(actual.acceptance[key],expected.acceptance[key]);});
test('fail-closed error messages and their precedence unchanged',()=>{
  assert.deepEqual(Object.keys(actual.errors),Object.keys(expected.errors));
  for(const key of Object.keys(expected.errors))assert.equal(actual.errors[key],expected.errors[key],key);
  assert.deepEqual(actual.dispatch.errors,expected.dispatch.errors);
});
test('every pinned hostile input still throws',()=>{for(const [k,v] of [...Object.entries(actual.errors),...Object.entries(actual.dispatch.errors)])assert.equal(typeof v,'string',k);});
test('composeDispatch text, files, manifest and warnings unchanged',()=>{
  for(const key of ['researchText','researchManifest','researchWarnings','researchFiles','withAssetsManifest','withAssetsWarnings'])assert.deepEqual(actual.dispatch[key],expected.dispatch[key],key);
});
test('dispatchTar bytes unchanged',()=>{assert.equal(actual.dispatch.withAssetsTar,expected.dispatch.withAssetsTar);});
async function inputs(kind){const x=scenario(kind);return {...x,castSource:x.castSource,originalHandoff:x.context,contract:await read('operating-contract-v0.1.md'),bootstrap:await read('bootstrap.md'),returnTemplate:encodeReturn(receipt(x.cast,{status:'partial',accepted:[],evidence:[],decisions:[],completed:[],verification:[],capabilities:[]}),new Map())};}
test('published research Dispatch text is byte-identical to composeDispatch',async()=>{
  const x=await inputs('research');assert.equal(composeDispatch(x).text,await read('examples/research/complete.dispatch.md'));
});
test('published with-assets package TAR and dispatch.yaml are byte-identical to the current build',async()=>{
  const x=await inputs('report');x.cast.assets=['assets/marker.bin'];
  const out=composeDispatch({...x,castSource:dump(x.cast),mode:'tar',assets:new Map([['assets/marker.bin',fullFiles().get('assets/marker.bin')]])});
  const published=new Uint8Array(await readFile(new URL('../examples/with-assets/selected.dispatch.tar',import.meta.url)));
  assert.deepEqual(dispatchTar(out.files),published);
  assert.equal(dump(out.manifest),await read('examples/with-assets/dispatch.yaml'));
  assert.deepEqual(yaml(decode(out.files.get('dispatch.yaml'))),out.manifest);
});
