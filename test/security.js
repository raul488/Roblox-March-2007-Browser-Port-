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
const coreImageData=fs.readFileSync(path.join(root,'web/js/coreAssets.js'),'utf8');

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

/* The generated safe-collision list must load before the filter, and the
 * per-player Safe Chat control must exist. */
assert.ok(webIndex.indexOf('js/safewords.js') >= 0, 'safewords.js is not loaded');
assert.ok(webIndex.indexOf('js/safewords.js') < webIndex.indexOf('js/chatfilter.js'),
  'safewords.js must load before chatfilter.js');
assert.ok(/id="safeOnlyBtn"/.test(webIndex), 'Safe Chat toggle missing');

/* The only inline script left is the JSON-LD block; its hash must match. */
const ld=/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(webIndex);
assert.ok(ld, 'JSON-LD block missing');
const hash=crypto.createHash('sha256').update(ld[1],'utf8').digest('base64');
assert.ok(scriptSrc.includes("'sha256-"+hash+"'"), 'JSON-LD hash is stale');

/* Root redirect must be an external script covered by script-src 'self'. */
assert.ok(!/<script(?![^>]*\bsrc=)/i.test(rootIndex), 'root index has inline script');
assert.ok(/<script src="redirect\.js"><\/script>/.test(rootIndex), 'root redirect script missing');
assert.ok(fs.existsSync(path.join(root,'redirect.js')), 'redirect.js missing');

/* T-shirt shelf: shipped textures only, no upload path. */
assert.ok(/id="tshirtShelf"/.test(webIndex), 'T-shirt shelf missing');
assert.ok(!/id="tshirtFile"|tshirtBrowse|tshirtClear/.test(webIndex),
  'custom T-shirt upload controls are still present');
const startpageSrc=fs.readFileSync(path.join(root,'web/js/startpage.js'),'utf8');
assert.ok(!/FileReader|readAsDataURL/.test(startpageSrc),
  'start page still reads arbitrary image files');
assert.ok(webIndex.indexOf('js/tshirts.js') >= 0, 'tshirts.js is not loaded');
assert.ok(webIndex.indexOf('<script src="js/tshirts.js">') <
  webIndex.indexOf('<script src="js/startpage.js">'),
  'tshirts.js must load before startpage.js');
const shirtCtx={window:{}};
require('vm').runInNewContext(
  fs.readFileSync(path.join(root,'web/js/tshirts.js'),'utf8'), shirtCtx);
const shirts=shirtCtx.window.RBLX_TSHIRTS;
assert.ok(Array.isArray(shirts) && shirts.length >= 20, 'T-shirt shelf is empty');
assert.ok(shirts.some(s => s.name === 'Matt Dusek Rox'), 'Matt Dusek Rox shirt missing');
for (const name of ["Miked's Shirt", "PoliceModlers' Shirt", "Anaminus' Shirt",
                    "Cadi's Shirt", "Cadi's Unused Shirt"]) {
  assert.ok(shirts.some(s => s.name === name), 'Homestead shirt missing: ' + name);
}
for (const shirt of shirts) {
  assert.ok(/^content\/tshirts\/[a-z0-9-]+\.png$/.test(shirt.src),
    'unexpected T-shirt path: ' + shirt.src);
  assert.ok(fs.existsSync(path.join(root,'web',shirt.src)),
    'missing T-shirt texture: ' + shirt.src);
  assert.ok(coreImageData.includes('window.IMAGE_DATA["'+shirt.src+'"]'),
    'T-shirt texture is not embedded for file:// play: ' + shirt.src);
}

/* Face shelf: classic face plus the Homestead face textures. */
assert.ok(/id="faceShelf"/.test(webIndex), 'Face shelf missing');
assert.ok(webIndex.indexOf('js/faces.js') >= 0, 'faces.js is not loaded');
assert.ok(webIndex.indexOf('<script src="js/faces.js">') <
  webIndex.indexOf('<script src="js/startpage.js">'),
  'faces.js must load before startpage.js');
const faceCtx={window:{}};
require('vm').runInNewContext(
  fs.readFileSync(path.join(root,'web/js/faces.js'),'utf8'), faceCtx);
const faces=faceCtx.window.RBLX_FACES;
assert.ok(Array.isArray(faces) && faces.length === 4, 'Homestead face list is wrong');
for (const name of ['Miked', 'Cadi', 'ToaZuku', 'PoliceModlers']) {
  assert.ok(faces.some(f => f.name === name), 'Homestead face missing: ' + name);
}
for (const face of faces) {
  assert.ok(/^content\/faces\/[a-z0-9-]+\.png$/.test(face.src),
    'unexpected face path: ' + face.src);
  assert.ok(fs.existsSync(path.join(root,'web',face.src)),
    'missing face texture: ' + face.src);
  assert.ok(coreImageData.includes('window.IMAGE_DATA["'+face.src+'"]'),
    'face texture is not embedded for file:// play: ' + face.src);
}
assert.ok(fs.existsSync(path.join(root,'web/content/textures/face.png')),
  'classic face texture missing');
assert.ok(coreImageData.includes('window.IMAGE_DATA["content/textures/face.png"]'),
  'classic face texture is not embedded');

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
