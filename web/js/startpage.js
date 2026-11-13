/* ============================================================
 * startpage.js  the start-page avatar widgets + logo bounce.
 *
 *   window.RBLXplayer = { name, colors:{head,torso,arms,legs} }
 *
 * The join flow (main.js spawn) reads this: the name becomes the
 * character/chat/Player-list name and the BrickColor ids recolor
 * the rig (character.js applyBodyColors). Settings persist in
 * localStorage so they survive the reload "Exit" does.
 * The "ROBLOX" logo is a tiny gravity bounce: free fall → squash
 * impulse on the invisible ground → damped spring + perfect
 * relaunch, so it keeps hopping up and down forever.
 * ============================================================ */
(function(){
"use strict";

/* Defaults = the shipped character.rbxm rig: torso bc23 (Bright blue),
 * head/arms bc24 (Bright yellow), legs bc119 (Br. yellowish green). */
var DEFAULTS={ name:'Player1', colors:{ head:24, torso:23, arms:24, legs:119 }, face:null };

try {
  var saved=JSON.parse(localStorage.getItem('RBLXstartpage')||'null');
  window.RBLXplayer=Object.assign({}, DEFAULTS, saved||{});
  window.RBLXplayer.colors=Object.assign({}, DEFAULTS.colors, (saved&&saved.colors)||{});
} catch(e){
  window.RBLXplayer=Object.assign({}, DEFAULTS);
}

function save(){
  try { localStorage.setItem('RBLXstartpage', JSON.stringify(window.RBLXplayer)); } catch(e){}
}

function click(){
  if (window.Sounds){ window.Sounds.resume(); window.Sounds.sound('clickfast.wav', {volume:0.25}); }
}

/* ------------------------------ username ------------------------------ */
/* the start page scrolls like the 2007 site  always open at the very top */
var loginEl=document.getElementById('login');
if (loginEl) loginEl.scrollTop=0;

var nameInput=document.getElementById('userName');
if (nameInput){
  if (window.RBLXnamepolicy){
    window.RBLXplayer.name=window.RBLXnamepolicy.clean(window.RBLXplayer.name);
    save();
  }
  nameInput.value=window.RBLXplayer.name;
  function applyName(){
    var raw=nameInput.value;
    var clean=window.RBLXnamepolicy
      ? window.RBLXnamepolicy.sanitize(raw, '')
      : raw.replace(/[^A-Za-z0-9 _]/g,'').trim().slice(0,20);
    if (nameInput.value!==clean) nameInput.value=clean;
    window.RBLXplayer.name=clean||'Player1';
    save();
  }
  nameInput.addEventListener('input', applyName);
  nameInput.addEventListener('blur', function(){
    if (!nameInput.value){
      nameInput.value='Player1';
      window.RBLXplayer.name='Player1';
      save();
      return;
    }
    var safe=window.RBLXnamepolicy
      ? window.RBLXnamepolicy.clean(window.RBLXplayer.name)
      : window.RBLXplayer.name;
    if (safe!==window.RBLXplayer.name){
      nameInput.value=safe;
      window.RBLXplayer.name=safe;
      save();
    }
  });
}

/* ----------------------------- body colors ---------------------------- */
/* Part groups vs the rig (character.js parts table). */
var PARTS=[
  { key:'head',  label:'Head',  parts:['Head'] },
  { key:'torso', label:'Torso', parts:['Torso'] },
  { key:'arms',  label:'Arms',  parts:['Left Arm','Right Arm'] },
  { key:'legs',  label:'Legs',  parts:['Left Leg','Right Leg'] }
];
/* A compact slice of the shipped palette (brickcolors.js ids):
 * row 1 neutrals → reds/oranges → row 2 warm/earth → green → blue → violet. */
var SWATCHES=[
  1, 208, 194, 27, 26,
  21, 154, 123, 106, 105, 24, 18,
  226, 192, 217, 119, 37, 28,
  45, 23, 102, 195, 110, 221
];

var activePart='torso';
var tabsEl=document.getElementById('bodyPartTabs');
var swEl=document.getElementById('bodySwatches');

function colorOf(id){
  return window.BrickColorFromId(id)||null;
}
function cssOf(id){
  var e=colorOf(id);
  return e? 'rgb('+e.rgb[0]+','+e.rgb[1]+','+e.rgb[2]+')' : '#ccc';
}

function render(){
  for (const s of tabsEl.children){
    s.classList.toggle('on', s.dataset.key===activePart);
    s.querySelector('.chip').style.background=cssOf(window.RBLXplayer.colors[s.dataset.key]);
  }
  for (const sw of swEl.children){
    sw.classList.toggle('on', +sw.dataset.id===window.RBLXplayer.colors[activePart]);
  }
}

if (tabsEl && swEl){
  for (const p of PARTS){
    const tab=document.createElement('span');
    tab.dataset.key=p.key;
    tab.appendChild(document.createTextNode(p.label));
    const chip=document.createElement('i');
    chip.className='chip';
    tab.appendChild(chip);
    tab.onclick=function(){
      activePart=p.key;
      click();
      render();
    };
    tab.title=p.parts.join(', ');
    tabsEl.appendChild(tab);
  }
  for (const id of SWATCHES){
    if (!window.BrickColorFromId(id)) continue;
    const sw=document.createElement('i');
    sw.dataset.id=id;
    sw.style.background=cssOf(id);
    sw.title=(window.BrickColorFromId(id).name)+' (bc'+id+')';
    sw.onclick=function(){
      window.RBLXplayer.colors[activePart]=id;
      save();
      click();
      render();
    };
    swEl.appendChild(sw);
  }
  render();
  renderShirt();
}

/* --------------------------- Reset Avatar ------------------------------ */
/* Restore the START defaults: shipped rig colors (torso bc23 Bright blue,
 * head/arms bc24 Bright yellow, legs bc119 Br. yellowish green), name
 * Player1, and no one-shot texture slot persisted. */
var resetBtn=document.getElementById('bodyReset');
if (resetBtn){
  resetBtn.onclick=function(){
    click();
    window.RBLXplayer=JSON.parse(JSON.stringify(DEFAULTS));
    window.RBLXplayer.tshirt=null;
    window.RBLXplayer.face=null;
    save();
    if (nameInput) nameInput.value=window.RBLXplayer.name;
    activePart='torso';
    render();
    renderShirt();
    renderFaces();
  };
}

/* --------------------------- face / T-shirt ---------------------------- */
/* Faces and T-shirts are shipped images (js/faces.js, js/tshirts.js).  The
 * chosen paths live on window.RBLXplayer and every LoadCharacter applies
 * them (rbxenv syncFace/syncShirts, character.applyFace/applyTshirt). */
var FACES=Array.isArray(window.RBLX_FACES)?window.RBLX_FACES:[];
var SHIRTS=Array.isArray(window.RBLX_TSHIRTS)?window.RBLX_TSHIRTS:[];
var faceShelf=document.getElementById('faceShelf');
var shirtShelf=document.getElementById('tshirtShelf');

function assetExists(list,url){
  for (var i=0;i<list.length;i++) if (list[i].src===url) return true;
  return false;
}
/* Old builds allowed an arbitrary T-shirt upload; drop one from localStorage
 * so the shelf only ever offers shipped assets. */
if (window.RBLXplayer.tshirt && !assetExists(SHIRTS,window.RBLXplayer.tshirt)){
  window.RBLXplayer.tshirt=null;
  save();
}
if (window.RBLXplayer.face && !assetExists(FACES,window.RBLXplayer.face)){
  window.RBLXplayer.face=null;
  save();
}

function renderShelf(shelf,items,current,onPick){
  if (!shelf) return;
  shelf.innerHTML='';
  for (var i=0;i<items.length;i++){
    var it=items[i];
    var b=document.createElement('button');
    b.type='button';
    b.className='avatarShelfItem'+(it.text?' avatarShelfNone':'');
    b.title=it.label;
    b.setAttribute('aria-label',it.label);
    b.setAttribute('aria-pressed', it.value===current ? 'true':'false');
    if (it.preview){
      var img=document.createElement('img');
      img.src=it.preview;
      img.alt='';
      img.draggable=false;
      img.loading='lazy';
      b.appendChild(img);
    } else {
      b.textContent=it.text||'None';
    }
    b.onclick=(function(value){ return function(){ click(); onPick(value); }; })(it.value);
    shelf.appendChild(b);
  }
}

function renderFaces(){
  if (!faceShelf) return;
  var list=FACES||[];
  var current=window.RBLXplayer.face||null;
  var items=[{ value:null, label:'Classic face', preview:'content/textures/face.png' }];
  for (var i=0;i<list.length;i++)
    items.push({ value:list[i].src, label:list[i].name, preview:list[i].src });
  renderShelf(faceShelf,items,current,setFace);
}
function setFace(src){
  window.RBLXplayer.face=src||null;
  save();
  renderFaces();
}

function renderShirt(){
  if (!shirtShelf) return;
  var list=SHIRTS||[];
  var current=window.RBLXplayer.tshirt||null;
  var items=[{ value:null, label:'No T-shirt (classic torso logo)', text:'None' }];
  for (var i=0;i<list.length;i++)
    items.push({ value:list[i].src, label:list[i].name, preview:list[i].src });
  renderShelf(shirtShelf,items,current,setShirt);
}
function setShirt(src){
  window.RBLXplayer.tshirt=src||null;
  save();
  renderShirt();
}
/* the tabs block calls renderShirt() before the shelf element is wired, so
 * rebuild once here as well */
renderFaces();
renderShirt();

/* ---------------------------- logo bounce ----------------------------- */
/* Free fall under gravity from a small apex; each ground contact adds a
 * squash impulse to a damped spring (scaleY 1-sq / scaleX 1+0.55*sq at the
 * baseline, transform-origin bottom) and relaunches at full speed  a
 * seamless up/down loop that squishes slightly on every landing. */
function startTitleBounce(){
  const el=document.getElementById('titleLogoBounce');
  if (!el) return;
  const AMP=18;                          // apex above the "ground" (px)
  const G=480;                           // px/s^2  reads as a light hop
  const LAUNCH=Math.sqrt(2*G*AMP);       // speed at ground contact
  let y=0, vy=0;                         // y = height above the ground, vy = up +
  let sq=0, sqV=0;                       // squash amount / rate (scale units)
  let resting=true, restT=0.45;          // hold still, then drop
  let last=performance.now();
  function frame(now){
    requestAnimationFrame(frame);
    const dt=Math.min(0.05,(now-last)/1000)||0;
    last=now;
    const login=document.getElementById('login');
    if (login && login.style.display==='none') return;   // paused in-game
    if (resting){
      if ((restT-=dt)<=0){ resting=false; y=AMP; vy=0; } // drop from the apex
    } else {
      vy-=G*dt; y+=vy*dt;
      if (y<=0){                         // hit the invisible ground
        y=0;
        vy=LAUNCH;                       // perfect-restitution relaunch
        sqV+=1.6;                        // squash impulse
      }
    }
    /* damped spring: compress on impact, spring back with tiny overshoot */
    sq+=sqV*dt;
    sqV+=(-380*sq-16*sqV)*dt;
    el.style.transform='translateY('+(-y).toFixed(2)+'px) scale('+
      (1+0.55*sq).toFixed(3)+','+(1-sq).toFixed(3)+')';
  }
  requestAnimationFrame(frame);
}
startTitleBounce();
})();
