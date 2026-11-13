/* Visual client regressions mined from Roblox.exe.c.
 * Run with: node test/client.js
 *
 * Source checks for the HUD anchors, the in-game font policy, and the
 * screen-space player tag math.  Deliberately simple: these numbers were
 * recovered from the decomp (FUN_0060d5f0, FUN_005d6830, FUN_005d6230,
 * FUN_005a59f0, FUN_005ddca0, FUN_005ddff0), so a changed literal should
 * fail loudly.
 */
"use strict";

const fs=require('fs');
const path=require('path');
const assert=require('assert');

const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'web/index.html'),'utf8');
const character=fs.readFileSync(path.join(root,'web/js/character.js'),'utf8');

function cssBlock(id){
  const re=new RegExp('#'+id+'\\{([^}]*)\\}');
  const m=re.exec(html);
  return m?m[1]:'';
}
function has(id, ...needles){
  const c=cssBlock(id);
  assert.ok(c, 'missing #'+id+' rule');
  for (const n of needles) assert.ok(c.indexOf(n)>=0, '#'+id+' missing '+n);
}

/* Player List: ScoreHud factory FUN_005d6830 anchors right/top 10/10. */
has('playerList','top:10px','right:10px','width:178px');
assert.ok(/#playerList b\{[^}]*font-weight:400/.test(html), 'player list header must be regular');
assert.ok(/#playerList \.plrow\{[^}]*font-weight:400[^}]*color:#ffffff/.test(html),
  'player list rows must be white regular, not palette blue');

/* HealthHud: FUN_005d69d0 margins 60/200, FUN_0060d5f0 10x100 bar. */
has('healthHud','top:200px','right:60px');
has('healthBar','width:10px','height:100px');
has('healthLabel','position:absolute','font-size:18px','font-weight:400','color:#0000ff','margin-top:7px');

/* The safe chat bubble sits above the inventory strip, not in the chat
 * bar: the hotbar is 28+96=124px tall, the bubble 32x23 at bottom 130. */
has('safeChatBtn','left:8px','bottom:130px');
has('safeChatPanel','left:6px','bottom:158px');
has('hotbar','bottom:28px');
assert.ok(130 >= 28+96, 'safe chat bubble must clear the 96px inventory strip');

/* Hint (FUN_005ddff0): full-width black bar at the bottom of the viewport. */
has('hintBox','left:0','right:0','bottom:28px','height:20px','background:#000','font-size:14px','font-weight:400');
/* Message (FUN_005ddca0): 50% grey sheet, centred white text. */
has('messageBox','background:rgba(128,128,128,0.5)','font-size:14px','font-weight:400');
assert.ok(/#tagLayer\{[^}]*pointer-events:none/.test(html), 'tag layer must be non-interactive');
assert.ok(/<canvas id="tagLayer"/.test(html), 'tag layer canvas missing');

/* The HUD uses the shipped regular comics.fnt; no synthetic bold. */
for (const sel of ['#menubar span','#notif .noti','#messageBox','#hintBox']) {
  const m=new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[^{]*\\{[^}]*font-weight:bold');
  assert.ok(!m.test(html), sel+' must not force bold');
}
assert.ok(/#menubar\{[^}]*font:11px Tahoma/.test(html), 'toolbar uses the native UI font');

/* Player tags: FUN_005a59f0 screen-space projection, not a 3D sprite. */
assert.ok(/static tagMetrics\(distance\)/.test(character), 'tagMetrics missing');
assert.ok(/distance < 20 \? 12/.test(character) && /distance < 50 \? 10/.test(character),
  'tag distance tiers must be 12/10/8');
assert.ok(/distance < 100/.test(character), 'tag cutoff must be 100 studs');
assert.ok(/barW:size\*4/.test(character) && /barH:size\/2/.test(character),
  'tag bar must be 4x wide and half the font size tall');
assert.ok(/rgb\(129,197,22\)/.test(character) && /#ff0000/.test(character),
  'tag health colours must be the mined green and red');
assert.ok(!/fillText\('Health'/.test(character), 'over-head tag must not draw a Health label');
assert.ok(/head\.pivot\.getWorldPosition/.test(character) && /_tagV\.y \+= 1\.5/.test(character),
  'tag anchor must be Head.Position + 1.5');
assert.ok(/fillText\(name, x, y\)/.test(character) && /textBaseline='bottom'/.test(character),
  'tag name must be screen-space, centred and bottom-aligned');

console.log('ALL client visual assertions PASSED');
