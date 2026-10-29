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
var DEFAULTS={ name:'Player1', colors:{ head:24, torso:23, arms:24, legs:119 } };

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
  nameInput.value=window.RBLXplayer.name;
  nameInput.addEventListener('input', function(){
    window.RBLXplayer.name=nameInput.value.trim()||'Player1';
    save();
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
      renderShirt();                       // torso swatch drives the preview bg
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
    save();
    if (nameInput) nameInput.value=window.RBLXplayer.name;
    activePart='torso';
    render();
    renderShirt();
  };
}

/* ------------------------------- T-shirt -------------------------------- */
/* decomp RBX::ShirtGraphic : CharacterAppearance (TextureId)  one texture
 * drawn on the character's torso front; the start page stores it as a
 * data URL on window.RBLXplayer.tshirt and every LoadCharacter applies it
 * (rbxenv syncShirts / character.applyTshirt). */
var SHIRT_LIMIT=900*1024;                 // localStorage-safe budget for the data URL
var browseBtn=document.getElementById('tshirtBrowse');
var clearBtn=document.getElementById('tshirtClear');
var fileInput=document.getElementById('tshirtFile');
var previewWrap=document.getElementById('tshirtPreview');
var previewImg=document.getElementById('tshirtPreviewImg');
var torsoBox=document.getElementById('tshirtTorso');
/* the tabs block calls renderShirt() before these vars exist (hoisted var =
 * undefined there), so a stored shirt must be restored again once the
 * this section's elements are wired */
renderShirt();

function renderShirt(){
  var url=window.RBLXplayer.tshirt||null;
  if (clearBtn) clearBtn.style.display=url? '' : 'none';
  if (previewWrap) previewWrap.style.display=url? '' : 'none';
  if (previewImg){
    if (url) previewImg.src=url;
    else previewImg.removeAttribute('src');
  }
  /* preview sits on the current torso color, like the shirt does in-game */
  if (torsoBox){
    var e=colorOf(window.RBLXplayer.colors.torso);
    torsoBox.style.background=e? 'rgb('+e.rgb[0]+','+e.rgb[1]+','+e.rgb[2]+')' : '';
  }
}
function setShirt(dataUrl){
  window.RBLXplayer.tshirt=dataUrl||null;
  save();
  renderShirt();
}
if (browseBtn && fileInput){
  browseBtn.onclick=function(){
    click();
    fileInput.value='';
    fileInput.click();
  };
  fileInput.addEventListener('change', function(){
    var f=fileInput.files && fileInput.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) return;
    var rd=new FileReader();
    rd.onloadend=function(){
      if (typeof rd.result!=='string') return;
      if (rd.result.length>SHIRT_LIMIT){
        if (torsoBox){
          torsoBox.style.background='';
          torsoBox.textContent='Too large ('+Math.round(rd.result.length/1024)+' KB)  use one under 900 KB';
          setTimeout(renderShirt, 2600);
        }
        return;
      }
      setShirt(rd.result);
      click();
    };
    rd.readAsDataURL(f);
  });
}
if (clearBtn){
  clearBtn.onclick=function(){ click(); setShirt(null); };
}

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
