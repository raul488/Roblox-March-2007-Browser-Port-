/* ============================================================
 * version.js  port build tag for tester verification.
 *
 * Bump `n` (and optionally the `label`) with every code change:
 * a stale hard-refresh then shows the OLD number in the corner,
 * which is exactly the confirmation you want. Purely cosmetic
 * guarded so page-less test scaffolds can require it harmlessly.
 * ============================================================ */
(function(){
  "use strict";
  var n=64, label='gllight';
  window.PORT_BUILD={ n:n, label:label };
  if (typeof document==='undefined' || typeof document.body==='undefined' || !document.body) return;
  var d=document.createElement('div');
  d.id='buildTag';
  d.style.cssText="position:fixed;right:8px;bottom:4px;z-index:200;"+
    "font:11px/1.2 'Comic Sans MS','Comic Sans',sans-serif;"+
    "color:rgba(255,255,255,0.72);text-shadow:0 1px 2px rgba(0,0,0,0.8);"+
    "pointer-events:none;-webkit-user-select:none;user-select:none;white-space:nowrap;";
  d.textContent='port build '+n+' · '+label;
  document.body.appendChild(d);
  /* datestamp the login dialog too: "version 0.3.368 · … " + build */
  var sub=document.body.querySelector && document.body.querySelector('.subtitle');
  if (sub) sub.appendChild(document.createTextNode('  port build '+n+' ('+label+')'));
})();
