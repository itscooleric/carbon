import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTarFiles, writeTarFiles } from '../src/archives/tar.js';
import { gunzip } from '../src/archives/gzip.js';
import { encode } from '../src/core/validate.js';
import { editorView, editorText, fillEditor } from './editor-browser-helpers.mjs';
import { menuClick } from './refinements-browser.mjs';
import { castOf, receiptFor } from './dispatch-browser.mjs';
import { encodeReturn } from '../cast-kit/src/kit.mjs';

export async function localFileFlows(browser) {
  const errors=[], network=[], checks=[];
  const original=new Map([
    ['notes/work.md',encode('# Working note\r\n[Research](../refs/one.md)\r\n![Chart](../images/grid.png)\r\nneedle first\r\nneedle second\r\n')],
    ['refs/one.md',encode('---\nid: foreign\n---\n# Research\n[[two.md|Other reference]]\n')],
    ['refs/two.md',encode('---\nid: foreign\n---\n# Another reference\n')],
    ['broken.md',encode('---\nid: [\n---\n# Incomplete foreign metadata\n')],
    ['bad.md',new Uint8Array([255,0,18])],
    ['inventory.csv',encode('Dataset,Rows\nCensus,1200\n')],
    ['requirements.json',encode('{"n":9007199254740993}')],
    ['readme.txt',encode('<script>this is literal text</script>')],
    ['images/grid.png',new Uint8Array(await readFile('tests/fixtures/images/grid.png'))],
  ]);
  const fixture=resolve('test-results/ordinary-folder');
  for(const [p,b] of original) { await mkdir(dirname(resolve(fixture,p)),{recursive:true}); await writeFile(resolve(fixture,p),b); }
  await mkdir(resolve(fixture,'empty'),{recursive:true});
  // Invalid manifest folder: an unrelated stack.yaml beside an ordinary note.
  const manifestFixture=resolve('test-results/ordinary-manifest');
  await mkdir(manifestFixture,{recursive:true});await writeFile(resolve(manifestFixture,'note.md'),'# Fine');await writeFile(resolve(manifestFixture,'stack.yaml'),'unrelated: true\n');
  for(const mobile of [false,true]) {
    console.log(`Ordinary files scenario: ${mobile ? 'narrow touch viewport' : 'desktop directory upload'}`);
    const context=await browser.newContext({offline:true,acceptDownloads:true,viewport:mobile?{width:393,height:852}:{width:1600,height:1000},...(mobile?{isMobile:true,hasTouch:true}:{})});
    const page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
    page.on('dialog',d=>d.accept());
    const idle=()=>page.waitForFunction(()=>document.querySelector('#workspace').getAttribute('aria-busy')!=='true');
    const accept=async()=>{await page.locator('#dialog-accept').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);await idle();};
    const tree=async()=>{if(mobile && !await page.locator('#sidebar').isVisible())await page.locator('#files-toggle').click();};
    const open=async p=>{await tree();await page.locator(`#tree button[title="${p}"]`).click();await idle();};
    const view=async p=>{await tree();await page.getByRole('button',{name:`Open ${p} in Viewer`,exact:true}).click();await idle();};
    const exportFiles=async id=>{const event=page.waitForEvent('download');await menuClick(page,id);const d=await event;await idle();const bytes=new Uint8Array(await readFile(await d.path()));return {name:d.suggestedFilename(),bytes};};
    try {
      await page.goto(pathToFileURL(resolve('dist/carbon.html')).href);
      await page.waitForFunction(()=>document.querySelector('#notice').textContent!=='Opening local workspace…');
      const startTitle=await page.locator('#stack-title').textContent();
      await page.locator('#folders').setInputFiles(fixture);
      await page.locator('#dialog-title').filter({hasText:'Open local folder copy?'}).waitFor();
      await page.locator('#dialog-cancel').click();await idle();
      assert.equal(await page.locator('#stack-title').textContent(),startTitle);
      await page.locator('#folders').setInputFiles(fixture);
      await accept();await tree();
      const paths=await page.locator('#tree button[title]').evaluateAll(bs=>bs.map(b=>b.title).sort());
      assert.deepEqual(paths,[...original.keys()].sort());
      assert.match(await page.locator('#stack-id').textContent(),/Local folder copy/);
      assert.equal(await page.locator('#dispatch').isDisabled(),true);
      await open('notes/work.md');await page.locator('#view').selectOption('edit');
      const normalized=original.get('notes/work.md') && (await editorText(page));
      await page.locator('#editor .cm-content').press('Control+End');await page.keyboard.insertText('\nDraft survives');
      const draft=await editorText(page);
      await page.evaluate(()=>carbonTestSelect([[2,7]]));
      const selection=await page.evaluate(()=>carbonTestView().state.selection.toJSON());
      for(const p of ['refs/one.md','inventory.csv','requirements.json','readme.txt']) {
        await view(p);assert.equal(await page.locator('#current-path').textContent(),'notes/work.md');assert.equal(await editorText(page),draft);
        assert.deepEqual(await page.evaluate(()=>carbonTestView().state.selection.toJSON()),selection);
      }
      assert.equal(await page.locator('#viewer-content script').count(),0);
      assert.match(await page.locator('#viewer-content pre').textContent(),/<script>this is literal/);
      await view('notes/work.md');await page.locator('#viewer-content img').waitFor();
      await page.locator('#viewer-content a[data-entry="refs/one.md"]').click();await idle();
      assert.equal(await page.locator('#viewer-path').textContent(),'refs/one.md');
      assert.equal(await page.locator('#current-path').textContent(),'notes/work.md');
      await open('broken.md');await open('notes/work.md');
      assert.deepEqual(await page.evaluate(()=>carbonTestView().state.selection.toJSON()),selection);
      await page.locator('#editor .cm-content').press('Control+z');assert.equal(await editorText(page),normalized);
      await page.locator('#editor .cm-content').press('Control+Shift+z');assert.equal(await editorText(page),draft);
      // Existing palette passage jumps focus the Editor tab without losing references.
      await page.locator('#palette-launcher').click();
      await page.locator('#palette-query').fill('needle');
      await page.locator('.palette-document summary').first().filter({hasText:'2 occurrences'}).waitFor();
      await page.locator('.palette-document summary').first().click();
      await page.locator('.palette-excerpts button').nth(1).click();await idle();
      assert.equal(await page.locator('.cm-palette-hit').textContent(),'needle');
      assert.equal(await editorText(page),draft);
      assert.equal(await page.locator('#viewer-tabs [role=tab]').count(),5);
      // Opening another workspace while drafts exist parks this one, drafts and tabs included (carbon-vfs).
      await page.locator('#local-files').setInputFiles({name:'other.md',mimeType:'text/markdown',buffer:Buffer.from('# Other')});
      await page.locator('#dialog-title').filter({hasText:'Open local folder copy?'}).waitFor();await accept();
      assert.equal(await page.locator('#current-path').textContent(),'other.md');
      await menuClick(page,'workspaces');await page.locator('#dialog-title').filter({hasText:'Workspaces'}).waitFor();
      await page.locator('#dialog-content .workspace-list li',{hasText:'1 unsaved draft'}).getByRole('button',{name:/^Switch to /}).click();
      await page.waitForFunction(()=>!document.querySelector('#dialog').open);await idle();
      assert.equal(await page.locator('#current-path').textContent(),'notes/work.md');
      assert.equal(await editorText(page),draft);
      assert.equal(await page.locator('#viewer-tabs [role=tab]').count(),5);
      await page.waitForTimeout(600);await page.reload();
      await page.waitForFunction(()=>/Recovered/.test(document.querySelector('#notice').textContent));
      assert.equal(await editorText(page),draft);
      assert.equal(await page.locator('#viewer-tabs [role=tab]').count(),5);
      // Actual IndexedDB failure must retain the unsaved draft and old revision.
      const before=await page.locator('#stack-meta').textContent();
      await page.evaluate(()=>{window.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw Error('Injected folder cache failure');};});
      await page.locator('#save-entry').click();await idle();
      assert.match(await page.locator('#notice').textContent(),/Injected folder cache failure/);
      assert.equal(await page.locator('#stack-meta').textContent(),before);
      assert.equal(await page.locator('#save-entry').isDisabled(),false);
      assert.equal(await editorText(page),draft);
      await page.evaluate(()=>{IDBObjectStore.prototype.put=window.originalPut;});
      await page.locator('#save-entry').click();await idle();
      const fileDownload=page.waitForEvent('download');await menuClick(page, "download-file");
      assert.equal(await readFile(await (await fileDownload).path(),'utf8'),draft.replace(/\n/g,'\r\n'));
      const gzip=await exportFiles('export-gzip');
      assert.match(gzip.name,/\.folder\.tar\.gz$/);
      const unpacked=readTarFiles(await gunzip(gzip.bytes)), files=new Map(unpacked.files);
      assert.equal(files.has('stack.yaml'),false);
      assert.deepEqual([...files.keys()].sort(),[...original.keys()].sort());
      for(const [p,b] of original)if(p!=='notes/work.md')assert.deepEqual(files.get(p),b);
      // Atomic workspace opening failure retains the active saved document and all tabs.
      await page.locator('#local-files').setInputFiles({name:'replacement.md',mimeType:'text/markdown',buffer:Buffer.from('# Replacement')});
      await page.evaluate(()=>{window.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw Error('Injected open failure');};});
      await accept();
      assert.match(await page.locator('#notice').textContent(),/Injected open failure/);
      assert.equal(await page.locator('#current-path').textContent(),'notes/work.md');
      assert.equal(await editorText(page),draft);
      assert.equal(await page.locator('#viewer-tabs [role=tab]').count(),5);
      await page.evaluate(()=>{IDBObjectStore.prototype.put=window.originalPut;});
      // Recovery archive stays an ordinary folder; malformed bytes stay downloadable.
      await page.locator('#files').setInputFiles({name:gzip.name,mimeType:'application/gzip',buffer:Buffer.from(gzip.bytes)});await accept();
      await tree();await page.locator('#tree button[title="bad.md"]').click();assert.match(await page.locator('#dialog-content').textContent(),/Cannot preview/);
      const badDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download Asset',exact:true}).click();
      assert.deepEqual(new Uint8Array(await readFile(await (await badDownload).path())),original.get('bad.md'));
      await page.locator('#dialog-cancel').click();await idle();
      // A misleading .stack archive must not be accepted as an ordinary folder.
      await page.locator('#files').setInputFiles({name:'invalid.stack.tar',mimeType:'application/octet-stream',buffer:Buffer.from(writeTarFiles(new Map([['note.md',encode('# Fine')]]),new Set()))});await idle();
      await page.waitForFunction(()=>/stack.yaml/.test(document.querySelector('#notice').textContent));
      assert.match(await page.locator('#stack-id').textContent(),/Local folder copy/);
      // Invalid manifest: explicit, labelled ordinary-folder choice (no Stack success).
      await page.locator('#folders').setInputFiles(manifestFixture);await page.locator('#dialog-title').filter({hasText:'Open local folder copy?'}).waitFor();
      assert.match(await page.locator('#dialog-content').textContent(),/not a valid Envoy Stack/);
      await accept();
      assert.equal(await page.locator('#dispatch').isDisabled(),true);
      await menuClick(page,'create-stack');await idle();
      assert.match(await page.locator('#notice').textContent(),/will not be overwritten/);
      // Explicit ordinary archives round-trip unrelated manifest bytes without protocol conversion.
      const foreignArchive=await exportFiles('export-tar');
      await page.locator('#files').setInputFiles({name:foreignArchive.name,mimeType:'application/octet-stream',buffer:Buffer.from(foreignArchive.bytes)});await accept();
      assert.equal(await page.locator('#dispatch').isDisabled(),true);
      const again=await exportFiles('export-tar');
      assert.deepEqual(new Map(readTarFiles(again.bytes).files).get('stack.yaml'),encode('unrelated: true\n'));
      // Open files preserves names; conversion is separate and explicit.
      await page.locator('#local-files').setInputFiles({name:'plain.md',mimeType:'text/markdown',buffer:Buffer.from('# Plain')});await accept();
      assert.equal(await page.locator('#current-path').textContent(),'plain.md');
      // Image insertion uses the same atomic asset/draft path in an ordinary copy.
      await page.locator('#view').selectOption('edit');await editorView(page);
      const imageChooser=page.waitForEvent('filechooser');await menuClick(page, "insert-image");
      await (await imageChooser).setFiles({name:'screenshot.png',mimeType:'image/png',buffer:Buffer.from(original.get('images/grid.png'))});await idle();
      await page.waitForFunction(()=>document.querySelector('#save-entry').disabled===false);
      assert.match(await editorText(page),/!\[.*\]\(.*\.png\)/);
      await page.locator('#save-entry').click();await idle();
      // Renaming an ordinary note preserves the Editor tab and content.
      const inserted=await editorText(page);
      await menuClick(page, "rename");await page.locator('#dialog input').fill('renamed.md');await accept();
      assert.equal(await page.locator('#current-path').textContent(),'renamed.md');
      assert.equal(await editorText(page),inserted);
      const withImage=readTarFiles((await exportFiles('export-tar')).bytes);
      const asset=withImage.files.find(([p])=>p.startsWith('assets/')&&p.endsWith('.png'));
      assert.ok(asset);assert.deepEqual(asset[1],original.get('images/grid.png'));
      await menuClick(page,'create-stack');await accept();
      assert.equal(await page.locator('#dispatch').isDisabled(),false);
      await tree();assert.equal(await page.locator('#tree button[title="renamed.md"]').count(),1);
      assert.equal(await page.locator('#tree button[title="stack.yaml"]').count(),1);
      checks.push(`${mobile?'Narrow touch viewport':'Desktop upload'}: ordinary tree, foreign metadata, Editor/Viewer independence, links/images, selection/undo, palette jump, drafts/reload, failed save, exact exports, strict Stack boundary, explicit conversion`);
      for(const [p,b] of original)assert.deepEqual(new Uint8Array(await readFile(resolve(fixture,p))),b);
    } finally {await context.close();}
  }
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  return {checks,pageErrors:errors,networkRequests:network,physicalAndroidChrome:'Outstanding; mobile dimensions and native API adapters are not real-device acceptance.'};
}

/** Workspace transitions out of and back into ordinary copies: cache-first rollback and Stack-only Dispatch cleanup. */
export async function localTransitionFlows(browser) {
  const errors=[], network=[], checks=[];
  const context=await browser.newContext({offline:true,acceptDownloads:true,viewport:{width:1600,height:1000}});
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
  page.on('dialog',d=>d.accept());
  let downloads=0;page.on('download',()=>downloads++);
  const idle=()=>page.waitForFunction(()=>document.querySelector('#workspace').getAttribute('aria-busy')!=='true');
  const accept=async()=>{await page.locator('#dialog-accept').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);await idle();};
  const notice=()=>page.locator('#notice').textContent();
  const failPut=message=>page.evaluate(m=>{window.originalPut??=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw Error(m);};},message);
  const restorePut=()=>page.evaluate(()=>{IDBObjectStore.prototype.put=window.originalPut;});
  const historyRows=async()=>{await menuClick(page,'history');await page.locator('#dialog-title').filter({hasText:'Revision history'}).waitFor();const rows=await page.locator('#dialog-content p').filter({has:page.getByRole('button',{name:'Restore',exact:true})}).allTextContents();await page.locator('#dialog-cancel').click();await idle();return rows;};
  const restore=async label=>{await menuClick(page,'history');await page.locator('#dialog-content p').filter({hasText:label}).first().getByRole('button',{name:'Restore',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);await idle();};
  const newStack=async title=>{await menuClick(page,'new-stack');await page.locator('#dialog input').fill(title);await accept();};
  const snapshot=async()=>({id:await page.locator('#stack-id').textContent(),meta:await page.locator('#stack-meta').textContent(),current:await page.locator('#current-path').textContent(),dispatchDisabled:await page.locator('#dispatch').isDisabled(),drawerHidden:await page.locator('#drawer').isHidden(),saveDisabled:await page.locator('#save-entry').isDisabled(),tabs:await page.locator('#viewer-tabs [role=tab]').count(),history:await historyRows()});
  const reload=async()=>{await page.waitForTimeout(600);await page.reload();await page.waitForFunction(()=>/Recovered/.test(document.querySelector('#notice').textContent));};
  const reviewOpen=()=>page.evaluate(()=>!document.getElementById('review').hidden&&document.getElementById('workspace').hidden);
  const stageReturn=async text=>{await menuClick(page,'import-return');await page.locator('#return-text').fill(text);await page.locator('#dialog-accept').click();await page.waitForFunction(()=>!document.getElementById('review').hidden);await idle();};
  const warnsOnClose=()=>page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;});
  const stale=label=>page.evaluate(label=>{window.stale??={};window.stale[label]=[...document.querySelectorAll('#drawer-body button')].find(b=>b.textContent===label);return !!window.stale[label];},label);
  try {
    await page.goto(pathToFileURL(resolve('dist/carbon.html')).href);
    await page.waitForFunction(()=>document.querySelector('#notice').textContent!=='Opening local workspace…');
    // Ordinary copy -> explicit Stack conversion -> exported Dispatch left open in the drawer.
    await page.locator('#local-files').setInputFiles({name:'plain.md',mimeType:'text/markdown',buffer:Buffer.from('# Plain\n')});await accept();
    await page.locator('#tree button[title="plain.md"]').click();await idle();
    // Save an edit in the copy, then convert: neither the edit nor the new manifest has been exported.
    await page.locator('#view').selectOption('edit');await editorView(page);
    await page.locator('#editor .cm-content').press('Control+End');await page.keyboard.insertText('Saved in copy before conversion\n');
    await page.waitForFunction(()=>document.querySelector('#save-entry').disabled===false);
    await page.locator('#save-entry').click();await idle();
    const edited=await editorText(page);assert.match(edited,/Saved in copy before conversion/);
    await menuClick(page,'create-stack');await accept();
    assert.equal(await page.locator('#dispatch').isDisabled(),false);
    // A Stack synthesized from the copy exists only in Carbon: it stays pending and warns on close, also after reload.
    assert.match(await notice(),/Envoy Stack created in Carbon/);
    assert.match(await page.locator('#stack-status').textContent(),/Export needed/);assert.equal(await warnsOnClose(),true);
    await reload();
    assert.doesNotMatch(await page.locator('#stack-id').textContent(),/Local folder copy/);
    assert.match(await page.locator('#stack-status').textContent(),/Export needed/);assert.equal(await warnsOnClose(),true);
    await page.locator('#tree button[title="plain.md"]').click();await idle();assert.equal(await editorText(page),edited);
    await page.locator('#tree button[title="plain.md"]').click();await idle();
    await page.locator('#dispatch').click();await page.waitForFunction(()=>!document.getElementById('drawer').hidden);
    await page.locator('#draft-objective').fill('Summarize the plain note.');
    await page.waitForFunction(()=>document.querySelector('#dispatches .dcard .obj')?.textContent.includes('Summarize the plain'));
    await page.locator('#drawer-skip').click();await page.locator('#draft-consent').check();
    const exported=page.waitForEvent('download');await page.locator('#drawer [data-via="download-md"]').click();
    const cast=castOf(await readFile(await (await exported).path(),'utf8'));await idle();
    await page.locator('#drawer-body button',{hasText:'Download again'}).waitFor();
    const stack=await snapshot();
    assert.doesNotMatch(stack.id,/Local folder copy/);assert.equal(stack.drawerHidden,false);
    // Each source is its own workspace (carbon-vfs): transitions are switches, not History restores.
    assert.equal(stack.history.length,0,'the converted Stack starts its own History; the copy keeps its own');
    const switchTo=async(kind,title='plain.md')=>{await menuClick(page,'workspaces');await page.locator('#dialog-title').filter({hasText:'Workspaces'}).waitFor();await page.locator('#dialog-content .workspace-list li').filter({hasText:kind}).filter({hasText:title}).filter({hasNotText:'open now'}).first().getByRole('button',{name:/^Switch to /}).click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);await idle();};
    // Failed switch from the Stack to the ordinary copy keeps the Stack, its History and the open Dispatch.
    await failPut('Injected switch failure');
    await switchTo('Local copy');
    assert.match(await notice(),/Injected switch failure/);
    assert.deepEqual(await snapshot(),stack);
    await restorePut();
    let count=downloads;await page.locator('#drawer-body button',{hasText:'Download again'}).click();await idle();
    assert.equal(downloads,count+1);
    await reload();
    assert.deepEqual({...await snapshot(),drawerHidden:false},stack);
    await page.locator('#dispatches .dcard',{hasText:'Dispatch 1 ·'}).click();await page.locator('#drawer-body button',{hasText:'Download again'}).waitFor();
    assert.ok(await stale('Download again'));assert.ok(await stale('Download original Cast'));
    checks.push('failed Stack -> ordinary copy switch keeps the Stack, History, open Dispatch and stored record');
    // Successful switch to the copy closes the drawer; retained callbacks cannot act; the copy kept its saved edit.
    await switchTo('Local copy');
    const folder=await snapshot();
    assert.match(folder.id,/Local folder copy/);assert.equal(folder.drawerHidden,true);assert.equal(folder.dispatchDisabled,true);
    assert.equal(folder.history.length,1,'the copy History holds only its own save');
    assert.equal(await page.locator('#dispatches .dcard').count(),0,'Dispatches stay with their Stack');
    await page.locator('#tree button[title="plain.md"]').click();await idle();assert.equal(await editorText(page),edited);
    count=downloads;
    for(const label of ['Download again','Download original Cast']) {
      await page.evaluate(label=>window.stale[label].click(),label);await idle();
      assert.match(await notice(),/requires an Envoy Stack/);
    }
    await page.waitForTimeout(200);assert.equal(downloads,count);assert.equal(await page.locator('#drawer').isHidden(),true);
    checks.push('successful Stack -> ordinary copy switch closes the Dispatch drawer; retained Download again / Download original Cast are refused');
    // Failed transitions out of the ordinary copy keep it, its History and its stored record.
    const folderNow=await snapshot();
    await failPut('Injected transition failure');
    await switchTo('Envoy Stack');
    assert.match(await notice(),/Injected transition failure/);
    assert.deepEqual(await snapshot(),folderNow);
    await newStack('Transition target');
    assert.match(await notice(),/Injected transition failure/);
    assert.deepEqual(await snapshot(),folderNow);
    await restorePut();await reload();
    assert.deepEqual(await snapshot(),folderNow);
    checks.push('failed copy -> Stack switch and New Stack keep the ordinary copy, History and stored record');
    // Successful switch back keeps the Stack revision, its History and Dispatch behavior.
    await switchTo('Envoy Stack');
    const back=await snapshot();
    assert.equal(back.id,stack.id);assert.equal(back.meta,stack.meta);assert.deepEqual(back.history,stack.history);
    assert.equal(back.dispatchDisabled,false);
    await page.locator('#dispatches .dcard',{hasText:'Dispatch 1 ·'}).click();
    count=downloads;await page.locator('#drawer-body button',{hasText:'Download again'}).click();await idle();
    assert.equal(downloads,count+1);
    // A Return review open over the Stack stays when the switch to the copy fails and closes once it commits.
    await stageReturn(encodeReturn(receiptFor(cast),new Map()));
    assert.equal(await reviewOpen(),true);
    const reviewed=await snapshot();
    await failPut('Injected review transition failure');
    await switchTo('Local copy');
    assert.match(await notice(),/Injected review transition failure/);
    assert.equal(await reviewOpen(),true);assert.deepEqual(await snapshot(),reviewed);
    await restorePut();
    await switchTo('Local copy');
    assert.equal(await reviewOpen(),false);assert.equal(await page.locator('#workspace').isVisible(),true);
    assert.match(await page.locator('#stack-id').textContent(),/Local folder copy/);assert.equal(await page.locator('#drawer').isHidden(),true);
    // New Stack from the copy is a new workspace with its own (empty) History; the copy is kept.
    const copyHistory=(await historyRows()).length;
    await newStack('Transition target');
    assert.equal(await page.locator('#stack-title').textContent(),'Transition target');
    assert.doesNotMatch(await page.locator('#stack-id').textContent(),/Local folder copy/);
    assert.equal(await page.locator('#dispatch').isDisabled(),false);
    assert.equal((await historyRows()).length,0);
    checks.push('successful copy <-> Stack switches and New Stack keep each workspace, its revision and History, and valid-Stack Dispatch actions');
    // A complete snapshot of a Stack that is already stored opens in that workspace, imported, with History.
    const tarEvent=page.waitForEvent('download');await menuClick(page,'export-tar');const tar=await readFile(await (await tarEvent).path());await idle();
    await switchTo('Local copy');
    assert.equal((await historyRows()).length,copyHistory);
    await page.locator('#files').setInputFiles({name:'transition.stack.tar',mimeType:'application/octet-stream',buffer:tar});await accept();
    assert.equal(await page.locator('#stack-title').textContent(),'Transition target');assert.match(await notice(),/Complete Stack imported/);
    assert.match(await page.locator('#stack-status').textContent(),/Opened from a complete snapshot/);assert.equal(await warnsOnClose(),false);
    assert.equal((await historyRows()).length,1,'the prior revision of that same Stack is in its History');
    checks.push('save -> explicit conversion -> reload stays pending and warns on close; an imported complete Stack snapshot stays imported and reuses its stored workspace');
    // Opening a local copy over an open Return review: kept on storage failure, closed once the copy commits.
    await switchTo('Envoy Stack');
    await page.locator('#dispatches .dcard',{hasText:'Dispatch 1 ·'}).click();await page.waitForFunction(()=>!document.getElementById('review').hidden);await idle();
    assert.equal(await reviewOpen(),true);
    const imported=await snapshot();
    const later={name:'later.md',mimeType:'text/markdown',buffer:Buffer.from('# Later\n')};
    await page.locator('#local-files').setInputFiles(later);await failPut('Injected copy failure');await accept();
    assert.match(await notice(),/Injected copy failure/);
    assert.equal(await reviewOpen(),true);assert.deepEqual(await snapshot(),imported);
    await restorePut();
    await page.locator('#local-files').setInputFiles(later);await accept();
    assert.equal(await reviewOpen(),false);assert.equal(await page.locator('#workspace').isVisible(),true);
    assert.match(await page.locator('#stack-id').textContent(),/Local folder copy/);assert.equal(await page.locator('#current-path').textContent(),'later.md');
    checks.push('an open Return review is kept when a workspace switch or Open files into a copy fails, and closed once either commits');
  } finally {await context.close();}
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  return {checks,pageErrors:errors,networkRequests:network};
}
