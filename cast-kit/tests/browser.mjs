/** Real offline browser acceptance. Usage: CAST_BROWSER_PATH=/path/chromium npm run test:browser */
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
const browser=await chromium.launch({headless:true,executablePath:process.env.CAST_BROWSER_PATH||undefined,args:['--no-sandbox']});
const context=await browser.newContext({offline:true,acceptDownloads:true,viewport:{width:1100,height:850},colorScheme:'dark',reducedMotion:'reduce'});
let requests=0;const errors=[];await context.route('https?://**/*',route=>{requests++;return route.abort();});
const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(String(error)));
await page.goto('file://'+root+'dist/cast-kit.html');
for(const kind of ['research','registry','report','restricted']) {
  await page.selectOption('#example',kind);await page.click('#load');await page.click('#stage');assert.match(await page.textContent('#status'),/Staged for review/);
}
await page.click('#compose');assert.match(await page.inputValue('#dispatch'),/# Envoy Dispatch/);assert.match(await page.inputValue('#dispatch'),/Operating Contract/);
const download=page.waitForEvent('download');await page.click('#downloadDispatch');const file=await download;const text=await readFile(await file.path(),'utf8');assert.match(text,/# Envoy Dispatch/);
const original=await page.inputValue('#return');await page.fill('#return',original.slice(0,-10));await page.click('#stage');assert.match(await page.textContent('#status'),/Rejected/);assert.equal(await page.locator('#review section').count(),0);
await page.fill('#return',original);await page.click('#stage');
const output=page.waitForEvent('download');await page.getByRole('button',{name:'Download proposed entries/report.md',exact:true}).click();const result=await output;assert.equal(await readFile(await result.path(),'utf8'),(await import('./fixtures.mjs')).report);
await page.fill('#objective','Prepare a new plan from supplied context.');await page.fill('#criterion','Preserve sources and list pending decisions.');await page.locator('#playbooks input[value="planning"]').check();await page.click('#create');await page.click('#compose');assert.match(await page.inputValue('#dispatch'),/builtin:planning/);assert.doesNotMatch(await page.inputValue('#dispatch'),/accepted:\n\s+- Accepted: dataset/);
await page.click('#mock');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('model-reported-complete'));await page.click('#stage');assert.match(await page.textContent('#status'),/2 changes/);
await page.setViewportSize({width:650,height:900});await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
await mkdir(root+'test-results',{recursive:true});await page.screenshot({path:root+'test-results/workbench.png',fullPage:true});
assert.deepEqual(errors,[]);assert.equal(requests,0);
const report={browser:await browser.version(),environment:'headless Linux file://',network_requests:requests,page_errors:errors,scenarios:['four Return fixtures','text Dispatch composition/download','malformed paste rejection','proposed report byte fidelity','Playbook composition','two-step recovery mock','650px viewport/light theme/reduced motion'],provider_runs:0};
await writeFile(root+'test-results/browser.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));await browser.close();
