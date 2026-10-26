import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalFolder, canEdit, entryFor, sourceFor, toEnvoyStack, restoreFolder, archiveWorkspace } from '../src/carbon/local-files.js';
import { Stack, History, newStack } from '../src/core/stack.js';
import { encode, LIMITS } from '../src/core/validate.js';
import { readTar, readTarFiles, writeTarFiles } from '../src/archives/tar.js';
import { gzip, gunzip } from '../src/archives/gzip.js';
import { blankState, serialize, restore, commit } from '../src/carbon/state.js';
import { buildIndex, searchIndex } from '../src/carbon/palette/search.js';
import { templateCommands } from '../src/carbon/palette/templates.js';
import { resolveEntry } from '../src/carbon/markdown.js';
import { inspectAsset } from '../src/carbon/asset-data.js';
import { readDirectoryFiles, readDirectory } from '../src/carbon/fs.js';
const folder = () => new LocalFolder([
  ['notes/work.md', encode('# Work\r\n[[refs/one.md|Dataset]]\r\n')],
  ['notes/refs/one.md', encode('---\nid: duplicate\n---\n# One\nneedle and needle\n')],
  ['refs/two.md', encode('---\nid: duplicate\n---\n# Two\n')],
  ['broken.md', encode('---\nid: [\n---\n# Broken but editable\n')],
  ['inventory.csv', encode('Name,Rows\nFirst,2\n')],
  ['requirements.json', encode('{"n":9007199254740993}')],
  ['notes.txt', encode('<script>inert</script>')],
  ['bytes.bin', new Uint8Array([0,255,12])],
], ['empty'], { title: 'Research' });
test('ordinary files retain paths, bytes and empty folders without inventing a manifest or IDs', () => {
  const s = folder();
  assert.equal(s.files.has('stack.yaml'), false);
  assert.equal(s.manifest.title, 'Research');
  assert.ok(s.directories.has('notes/refs') && s.directories.has('empty'));
  assert.equal(s.text('broken.md'), '---\nid: [\n---\n# Broken but editable\n');
  assert.throws(() => new Stack(s.files));
  const changed = s.change({ writes: new Map([['notes/work.md', encode('# Edited\r\n')]]) });
  assert.equal(changed.manifest.revision, 1);
  assert.equal(s.text('notes/work.md'), '# Work\r\n[[refs/one.md|Dataset]]\r\n');
  assert.deepEqual(changed.files.get('bytes.bin'), s.files.get('bytes.bin'));
  assert.equal(changed.files.has('stack.yaml'), false);
});
test('foreign and malformed frontmatter stay editable; unrelated IDs cannot hijack resolution or search', async () => {
  const s = folder();
  for (const p of ['broken.md', 'notes/refs/one.md', 'refs/two.md']) assert.equal(canEdit(s,p), true);
  assert.equal(entryFor(s,s.text('notes/refs/one.md')).data.id, undefined);
  assert.equal(entryFor(s,s.text('broken.md')).body, s.text('broken.md'));
  assert.equal(resolveEntry(s,'duplicate'), null);
  assert.equal(resolveEntry(s,'refs/one.md','notes/work.md'), 'notes/refs/one.md');
  const index = await buildIndex({ stack:s, drafts:new Map() });
  const found = await searchIndex(index,'needle',[]);
  assert.equal(found.content[0].count, 2);
  assert.equal(index.entities[0].path, 'notes/refs/one.md');
  assert.deepEqual(templateCommands(s), { commands:[], error:null });
});
test('ordinary edit conversion preserves CRLF and retains over-limit drafts until save validation', () => {
  const s = folder();
  assert.equal(sourceFor(s,'# Edited\ntext\n',s.text('notes/work.md')), '# Edited\r\ntext\r\n');
  const large = 'x'.repeat(LIMITS.text+1);
  assert.equal(sourceFor(s,large,'old'), large);
  assert.throws(() => s.change({ writes:new Map([['large.md',encode(large)]]) }), /text limit/);
});
test('undecodable, NUL and large Markdown remain inventory but are excluded from editor/search', async () => {
  const s = new LocalFolder([
    ['bad.md',new Uint8Array([255])], ['zero-byte.md',encode('a\0b')],
    ['large.md',new Uint8Array(LIMITS.text+1)], ['good.md',encode('# Good')],
  ]);
  for (const p of ['bad.md','zero-byte.md','large.md']) assert.equal(canEdit(s,p),false);
  assert.deepEqual((await buildIndex({ stack:s,drafts:new Map() })).records.map(r=>r.path), ['good.md']);
  assert.equal(inspectAsset('notes.txt',encode('<script>inert</script>')).source,'<script>inert</script>');
  assert.match(inspectAsset('bad.md',s.files.get('bad.md')).error,/Cannot preview/);
});
test('ordinary archive round trips all bytes and directories without becoming a Stack', async () => {
  const s=folder(), tar=archiveWorkspace(s);
  assert.deepEqual(tar,archiveWorkspace(s));
  const unpacked=readTarFiles(await gunzip(await gzip(tar)));
  assert.deepEqual(new Map(unpacked.files),s.files);
  assert.deepEqual(new Set(unpacked.directories),s.directories);
  assert.throws(()=>readTar(tar));
  const reopened=new LocalFolder(unpacked.files,unpacked.directories);
  assert.equal(reopened.files.has('stack.yaml'),false);
  assert.deepEqual(readTarFiles(archiveWorkspace(new LocalFolder())).files,[]);
});
test('ordinary model retains portable path, collision and resource limits', () => {
  for (const files of [ [['../x',encode('x')]], [['A.md',encode('x')],['a.md',encode('y')]], [['x',encode('x')],['x',encode('y')]], [['x',encode('x')],['x/y',encode('y')]] ])
    assert.throws(()=>new LocalFolder(files));
  assert.throws(()=>new LocalFolder([['huge',new Uint8Array(LIMITS.file+1)]]),/too large/);
  assert.throws(()=>new LocalFolder([],Array.from({length:LIMITS.files+1},(_,i)=>`d${i}`)),/count/);
  assert.throws(()=>new LocalFolder(Array.from({length:5},(_,i)=>[`f${i}`,new Uint8Array(LIMITS.file)])),/total/);
  assert.throws(()=>folder().change({moves:[['notes/work.md','../escape.md']]}));
  assert.throws(()=>readTarFiles(new Uint8Array(1024)),/root/);
  assert.throws(()=>writeTarFiles(new Map([['a',encode('')],['A',encode('')]]),new Set()),/collision/);
});
test('cache and History recover ordinary copies alongside strict Stacks and independent tabs', async () => {
  const s=folder(), state=blankState();
  state.history.push(state.stack,'Prior Stack');
  state.stack=s;state.current='notes/work.md';state.drafts.set(state.current,'# Draft');
  state.documents={ stackId:s.manifest.id, editors:[state.current,'broken.md'],viewers:['inventory.csv','notes.txt'],viewer:'notes.txt',shown:true };
  const recovered=restore(serialize(state));
  assert.equal(recovered.stack.kind,'folder');
  assert.equal(recovered.drafts.get(state.current),'# Draft');
  assert.deepEqual(recovered.documents.viewers,['inventory.csv','notes.txt']);
  assert.equal(recovered.history.items[0].stack instanceof Stack,true);
  const h=new History();h.push(s,'old');
  const restored=restoreFolder(s.change(),h,s);
  assert.equal(restored.manifest.revision,2);
  assert.equal(restored.files.has('stack.yaml'),false);
  const before=serialize(state);
  await assert.rejects(()=>commit(state,{}, { stack:newStack() },async()=>{ throw Error('disk full'); }),/disk full/);
  assert.deepEqual(serialize(state),before);
});
test('Envoy conversion is explicit, nonmutating and fails on incompatible metadata or manifest collisions', () => {
  const s=new LocalFolder([['note.md',encode('# Normal')]]), next=toEnvoyStack(s);
  assert.ok(next instanceof Stack);
  assert.equal(next.text('note.md'),'# Normal');
  assert.equal(s.files.has('stack.yaml'),false);
  assert.throws(()=>toEnvoyStack(folder()));
  for(const p of ['stack.yaml','Stack.yaml']) assert.throws(()=>toEnvoyStack(new LocalFolder([[p,encode('not a manifest')]])),/will not be overwritten/);
});
test('native folder reader returns ordinary bytes and empty directories without writes; strict reader still rejects', async () => {
  const child={kind:'directory',async *entries(){ yield ['note.md',{kind:'file',getFile:async()=>new File(['# Raw'],'note.md')}]; }};
  const handle={kind:'directory',async *entries(){ yield ['nested',child];yield ['empty',{kind:'directory',async *entries(){}}]; }};
  const { files,directories }=await readDirectoryFiles(handle);
  assert.deepEqual(files,[['nested/note.md',encode('# Raw')]]);
  assert.deepEqual(directories,['nested','empty']);
  await assert.rejects(()=>readDirectory(handle),/stack.yaml/);
});
