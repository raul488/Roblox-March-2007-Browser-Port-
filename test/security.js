/* Static security guardrails for the public page.
 * Run with: node test/security.js
 *
 * These are deliberately simple source checks: they catch the regressions
 * that would silently re-open the CSP or ship executable stubs again.
 */
"use strict";

const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const assert=require('assert');

const root=path.join(__dirname,'..');
const webIndex=fs.readFileSync(path.join(root,'web/index.html'),'utf8');
const rootIndex=fs.readFileSync(path.join(root,'index.html'),'utf8');
const about=fs.readFileSync(path.join(root,'web/about.html'),'utf8');

/* No inline event handlers: the page CSP has no script 'unsafe-inline'. */
for (const html of [webIndex, rootIndex]) {
  assert.ok(!/\son(?:click|load|error|mouse\w+|key\w+)\s*=/i.test(html),
    'inline event handler found');
}

assert.ok(!/<script/i.test(about), 'about.html must not contain scripts');
assert.ok(/Content-Security-Policy/.test(about), 'about.html has no CSP');

/* script-src must not allow arbitrary inline script. */
const csp=(webIndex.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)||[])[1]||'';
assert.ok(csp, 'web/index.html has no CSP');
const scriptSrc=(csp.match(/script-src ([^;]+)/)||[])[1]||'';
assert.ok(scriptSrc && !/'unsafe-inline'/.test(scriptSrc),
  "script-src still allows 'unsafe-inline'");
assert.ok(/object-src 'none'/.test(csp), 'object-src is not locked down');
assert.ok(/base-uri 'none'/.test(csp), 'base-uri is not locked down');
assert.ok(/form-action 'none'/.test(csp), 'form-action is not locked down');
assert.ok(/frame-src 'none'/.test(csp), 'frame-src is not locked down');

/* The only inline script left is the JSON-LD block; its hash must match. */
const ld=/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(webIndex);
assert.ok(ld, 'JSON-LD block missing');
const hash=crypto.createHash('sha256').update(ld[1],'utf8').digest('base64');
assert.ok(scriptSrc.includes("'sha256-"+hash+"'"), 'JSON-LD hash is stale');

/* Root redirect must be an external script covered by script-src 'self'. */
assert.ok(!/<script(?![^>]*\bsrc=)/i.test(rootIndex), 'root index has inline script');
assert.ok(/<script src="redirect\.js"><\/script>/.test(rootIndex), 'root redirect script missing');
assert.ok(fs.existsSync(path.join(root,'redirect.js')), 'redirect.js missing');

/* Do not ship unreferenced PE stubs under the served web root. */
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p=path.join(dir,name);
    const st=fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else assert.ok(!/\.(dll|exe|so|dylib)$/i.test(name), 'executable stub in web/: '+p);
  }
}
walk(path.join(root,'web/content'));

console.log('ALL SECURITY TESTS PASSED');
