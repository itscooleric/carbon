import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
test('single-file browser script matches its CSP digest and parses',async()=>{
  const html=await readFile(new URL('../dist/cast-kit.html',import.meta.url),'utf8'),script=/<script>([\s\S]*)<\/script>/.exec(html)?.[1];assert.ok(script);
  const hash=createHash('sha256').update(script).digest('base64');assert.ok(html.includes("script-src 'sha256-"+hash+"'"));assert.ok(html.includes("connect-src 'none'"));assert.doesNotMatch(html,/<script[^>]+src=/);new Function(script);
});
