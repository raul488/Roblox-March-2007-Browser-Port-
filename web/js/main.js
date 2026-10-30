/* ============================================================
 * main.js  boot & glue: the 2007 "play solo" flow
 * (extra/Scripts/PlaySolo.lua + engine LoadCharacter):
 *   pick a bundled place → parse XML → build world/player →
 *   StarterPack/HopperBin hotbar → 60Hz Stepped loop + render.
 * Everything engine-specific lives in the other modules; where a
 * constant is not in the decomp it is flagged in PORT.md.
 * ============================================================ */
(function(){
"use strict";

const ui=new window.RBLXui();
window.RBLXui_instance_open=ui;           // menu onclicks target this instance

/* lightweight frame instrumentation (F3-style debug + FPS benchmarks) */
const perf=window.__perf={
  frames:0, stepMs:0, renderMs:0, lastStepMs:0, lastRenderMs:0,
  dynMs:0, charMs:0, toolsMs:0, sjobsMs:0, luaMs:0, uiMs:0,
  cameraMs:0, frameUpdateMs:0, drawMs:0,
  reset(){ this.frames=0; this.stepMs=0; this.renderMs=0; this.lastStepMs=0; this.lastRenderMs=0;
    this.dynMs=0; this.charMs=0; this.toolsMs=0; this.sjobsMs=0; this.luaMs=0; this.uiMs=0;
    this.cameraMs=0; this.frameUpdateMs=0; this.drawMs=0; },
  snapshot(){
    const info=renderer&&renderer.info&&renderer.info.render;
    const n=this.frames||1;
    return { frames:this.frames,
      avgStepMs:this.frames?+(this.stepMs/this.frames).toFixed(3):0,
      avgRenderMs:this.frames?+(this.renderMs/this.frames).toFixed(3):0,
      avgDynMs:+(this.dynMs/n).toFixed(3), avgCharMs:+(this.charMs/n).toFixed(3),
      avgToolsMs:+(this.toolsMs/n).toFixed(3), avgSjobsMs:+(this.sjobsMs/n).toFixed(3),
      avgLuaMs:+(this.luaMs/n).toFixed(3), avgUiMs:+(this.uiMs/n).toFixed(3),
      avgCameraMs:+(this.cameraMs/n).toFixed(3), avgFrameUpdateMs:+(this.frameUpdateMs/n).toFixed(3),
      avgDrawMs:+(this.drawMs/n).toFixed(3),
      lastStepMs:+this.lastStepMs.toFixed(3), lastRenderMs:+this.lastRenderMs.toFixed(3),
      calls:info?info.calls:0, tris:info?info.triangles:0 };
  },
  get world(){ return world; }, get scene(){ return scene; }, get renderer(){ return renderer; }
};

let renderer, scene, camera, world=null, character=null, controller=null, tools=null, sjobs=null;
let clock=new THREE.Clock();
let loginEl=null;                 /* cached start-page overlay (loop idles on it) */
let canRender=true;               /* false while unfocused/hidden (skip the GPU) */
let mouse={ leftDown:false, rightDown:false, leftPressed:false, x:0, y:0 };
let cam={ yaw:0, pitch:0.42, distance:14 };
let input={ moveDir:new THREE.Vector3(), jump:false };
let firstPerson=false;

/* -------------------------------- boot -------------------------------- */
function webglSupported(){
  try {
    const c=document.createElement('canvas');
    return !!(window.WebGLRenderingContext &&
              (c.getContext('webgl')||c.getContext('experimental-webgl')));
  } catch(_){ return false; }
}
function showWebGLWarning(err){
  const warn=document.getElementById('webglWarn');
  if (warn){
    warn.style.display='block';
    const d=document.getElementById('webglWarnDetail');
    if (d) d.textContent=err? (err.message||String(err)) : 'No WebGL context could be created.';
  }
  try {
    ui.notify('WebGL is disabled or unavailable. Enable hardware acceleration/WebGL, then reload.');
  } catch(_){}
}
function buildPlaceList(){
  const list=document.getElementById('placeList');
  if (!list) return;
  list.innerHTML='';
  for (const name of (window.PLACE_REGISTRY||[])){
    const el=document.createElement('div');
    el.className='pl';
    el.textContent=name;
    el.onclick=()=>joinPlace(name);
    list.appendChild(el);
  }
  if (!(window.PLACE_REGISTRY||[]).length){
    list.innerHTML='<div class="pl" style="cursor:default">No embedded places found</div>';
  }
}
function boot(){
  const canvas=document.createElement('canvas');
  canvas.className='viewport';
  document.getElementById('view').appendChild(canvas);
  buildPlaceList();
  let gpuErr=null;
  if (webglSupported()){
    try {
      /* The 2007 client renders through G3D's fixed-function OpenGL
       * RenderDevice.  RBLXg3d is the literal state-layer port; it owns
       * the GL context and consumes the same three.js scene graph.
       * preserveDrawingBuffer lets callers extract pixels. */
      const opts={ canvas, antialias:true, preserveDrawingBuffer:true,
                   powerPreference:'high-performance' };
      renderer=window.RBLXg3d
        ? new window.RBLXg3d.Renderer(opts)
        : new THREE.WebGLRenderer(opts);
    } catch(e){ gpuErr=e; renderer=null; }
  } else {
    gpuErr=new Error('WebGL is not available: the browser did not create a WebGL context.');
  }
  window.__webglAvailable=!!renderer;
  if (!renderer){
    showWebGLWarning(gpuErr);
    const retry=document.getElementById('webglRetry');
    if (retry) retry.onclick=()=>location.reload();
    return;
  }
  /* Explicit canvas-data extraction API.  Renders the current frame first
   * when a world is live so the capture is not a stale/blank buffer. */
  window.RBLXcanvas=canvas;
  window.RBLXcaptureCanvas=(type, quality)=>{
    try {
      if (world&&scene&&camera) renderer.render(scene,camera);
      return canvas.toDataURL(type||'image/png', quality);
    } catch(e){ return null; }
  };
  window.RBLXcaptureCanvasBlob=(cb, type, quality)=>{
    try {
      if (world&&scene&&camera) renderer.render(scene,camera);
      canvas.toBlob(b=>{ if (cb) cb(b); }, type||'image/png', quality);
    } catch(e){ if (cb) cb(null); }
  };
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
  scene=new THREE.Scene();
  camera=new THREE.PerspectiveCamera(70, 1, 0.4, 6000);
  window.__camera=camera;          // world.rayFromCamera fallback
  window.addEventListener('resize', resize);
  resize();
  /* Render only while this window is focused and visible.  A blurred window
   * still fires requestAnimationFrame at 60 Hz; skipping renderer.render
   * there cuts GPU submission/work to zero (the simulation keeps running).
   * A minimized/hidden tab already pauses RAF, this also covers it and
   * releases the renderer's per-frame lists. */
  refreshRenderGate();
  window.addEventListener('focus', refreshRenderGate);
  window.addEventListener('blur', refreshRenderGate);
  window.addEventListener('pageshow', refreshRenderGate);
  window.addEventListener('pagehide', refreshRenderGate);
  document.addEventListener('visibilitychange', refreshRenderGate);

  const open=document.getElementById('openFile');
  open.onchange=e=>{
    const f=open.files[0]; if (!f) return;
    const r=new FileReader();
    r.onloadend=()=>joinPlace(f.name.replace(/\.(rbxlx|rbxl|xml)$/i,''), r.result);
    r.readAsText(f, 'latin1');
  };
  const login=document.getElementById('login');
  loginEl=login;
  login.addEventListener('dragover', e=>e.preventDefault());
  login.addEventListener('drop', e=>{
    e.preventDefault();
    const f=e.dataTransfer.files[0]; if (!f) return;
    const r=new FileReader();
    r.onloadend=()=>joinPlace(f.name.replace(/\.(rbxlx|rbxl|xml)$/i,''), r.result);
    r.readAsText(f, 'latin1');
  });
  bindInput(canvas);
  bindCameraControls();
  bindReportButton();
  requestAnimationFrame(loop);
}

function resize(){
  const w=window.innerWidth, h=window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect=w/h;
  camera.updateProjectionMatrix();
}

/* Skip all drawing while the window is blurred or the tab is hidden.  The
 * browser keeps RAF alive for a blurred-but-visible window, so without this
 * the GPU was still drawing the scene at 60 Hz behind another app. */
function refreshRenderGate(){
  const focused=(typeof document.hasFocus!=='function')||document.hasFocus();
  const on=!document.hidden && document.visibilityState!=='hidden' && focused;
  if (on===canRender) return;
  canRender=on;
  if (!on && renderer && renderer.renderLists){
    try { renderer.renderLists.dispose(); } catch(_){ }
  }
  if (on) clock.getDelta();       /* drop the paused interval */
}

/* --------------------------- lazy place loading --------------------------- */
function ensurePlaceScript(name){
  const file=(window.PLACE_FILES&&window.PLACE_FILES[name])||name;
  return new Promise((res, rej)=>{
    const s=document.createElement('script');
    s.src='places/'+file+'.rbxl.js';
    s.onload=()=>res();
    s.onerror=()=>rej(new Error('missing places/'+file+'.rbxl.js'));
    document.head.appendChild(s);
  });
}

async function joinPlace(name, providedText){
  if (!window.__webglAvailable){
    showWebGLWarning();
    return;
  }
  document.getElementById('login').style.display='none';
  document.getElementById('loadingBar').style.display='flex';
  ui.notify('Joining game... (from '+(providedText!=null?'file':'bundled place')+')');
  await new Promise(r=>setTimeout(r, 30));
  try {
    let text=providedText;
    if (text==null){
      await ensurePlaceScript(name);
      text=(window.PLACE_XML||{})[name];
      if (text==null) throw new Error('place text missing');
    }
    ui.notify('Parsing XML...');
    if (/^\s*<roblox!/i.test(String(text))){
      ui.notify('That file is a BINARY place  this 2007 port loads XML (rbxlx/2007 format).');
      throw new Error('binary rbxl not supported (re-save the place as XML)');
    }
    const parsed=window.RBLXxml.parseRbx(text);
    // rebuild scene fresh
    while (scene.children.length) scene.remove(scene.children[0]);
    world=new window.RBLXworld.WorldBuilder(scene);
    world.setCamera(camera);
    const stats=world.build(parsed);
    ui.notify('Built '+stats.parts+' parts ('+world.colliders.length+' colliders)...');

    // camera defaults from any Camera instance in file (2007 files carry one)
    const camInst=parsed.instances.find(i=>i.cls==='Camera' && i.props.CFrame);
    if (camInst){
      const o=camInst.props.CFrame.rot;
      const look=new THREE.Vector3(-o[2], -o[5], -o[8]);   // LookVector = -col3
      cam.yaw=Math.atan2(-look.x, -look.z);
      cam.pitch=0.42;
    }

    // classic Backpack hotbar: StarterPack contents were replicated into
    // Player.Backpack by rbxenv.buildGameTree; world.inventory keeps the
    // .rbxl traversal order (HopperBins and generic Tools).
    const binNames={0:'Script',1:'GameTool',2:'Grab',3:'Clone',4:'Hammer',5:'Slingshot',6:'Rocket',7:'Laser'};
    const inv=(world.inventory&&world.inventory.length)? world.inventory
              : world.hoppers.concat(world.tools||[]);
    const toolList=inv.map(h=>{
      const isBin=h.cls==='HopperBin';
      const bt=isBin? (('BinType' in h.props)? h.props.BinType : 1) : null;
      const tid=h.props.TextureId;
      const texUrl=(tid && (tid.url||tid.binary)) || null;
      const nm=h.props.Name||(isBin? (binNames[bt]||('Bin '+bt)) : 'Tool');
      /* decomp BackpackItem draw: try the TextureId first; when it does
       * not load, FUN_005e8100 is called and draws the item's Name as the
       * slot text.  No generic icon fallback. */
      return { inst:h, kind:h.cls, name:nm, binType:bt,
               icon: texUrl || null };
    });
    ui.setTools(toolList);

    ui.onSelectTool=(i, t)=>{
      if (!t){ tools.unequip(); return; }
      tools.equip(t.inst, character);
      ui.chat('Equipped: '+t.name, null, '#ffff00');   // tips = yellow (class 6 switch, decomp FUN_005b8060)
    };

    await spawn(parsed);

    sjobs=new window.RBLXscript.PlaceScriptRunner(world, ui, character);
    sjobs.init(parsed);
    /* PlaySolo creates the local Player first, then runs the place scripts;
     * the engine's scripts are already running when the player enters, so
     * `game.Players.ChildAdded` fires for it.  Replay that ordering here:
     * launch the script bodies, fire the join event, then let the handlers
     * (Haunted / Rocket Car Rally spawn scripts) place the character before
     * the first frame is shown. */
    if (window.RBLXenv&&window.RBLXenv.firePlayerAdded){
      window.RBLXenv.tickScripts(0);
      window.RBLXenv.firePlayerAdded();
      window.RBLXenv.tickScripts(0);
    }

    document.getElementById('loadingBar').style.display='none';
    ui.showInGameHUD();
    /* high-part-count places can stutter on older hardware; the banner
     * carries the actual Workspace part total (threshold in ui.js) */
    ui.warnIfHighPartCount(stats.parts);
    if (window.RBLXsafechat) window.RBLXsafechat.mount();
    ui.chat('WASD move · Space jump · right-drag camera · wheel zoom · / chat · 1-0 tools', null, '#ffff00');
  } catch (err){
    console.error(err);
    ui.notify('Join failed: '+(err.message||err));
    document.getElementById('login').style.display='block';
    document.getElementById('login').scrollTop=0;     // the site opens at the very top
    document.getElementById('loadingBar').style.display='none';
  }
}

/* --------------------------- PlaySolo.lua flow --------------------------- */
async function spawn(parsed){
  if (character){ scene.remove(character.group); character=null; }
  const name=(window.RBLXplayer&&window.RBLXplayer.name)||'Player1';
  character=new window.RBLXcharacter.Character(scene, world, name);
  world.character=character;
  await character.load();
  /* start-page body colors (startpage.js)  recolor on every LoadCharacter */
  character.applyBodyColors(window.RBLXplayer&&window.RBLXplayer.colors);
  const plrow=document.querySelector('#playerList .plrow');
  if (plrow) plrow.textContent=name;
  ui.health(1);
  /* LoadCharacter spawn selection  RBX::SpawnerService (decomp
   * FUN_005a06d0): a uniformly random SpawnLocation from the registry;
   * the spawn point is the pad's CFrame position + 7 studs in Y (it is the
   * character's PrimaryPart/Torso position, so the feet start ~3 studs
   * above the pad and gravity settles the rig).  With no SpawnLocation the
   * service returns (0, 100, 0), the classic "fall into the map" spawn.
   * `rand() % count` is the engine's shuffle, including the first join. */
  const pads=world.spawnPoints.filter(s=>!s.destroyed);
  if (pads.length){
    const sp=(window.RBLXenv&&window.RBLXenv.chooseSpawnPad)
      ? window.RBLXenv.chooseSpawnPad(pads, parsed)
      : pads[Math.floor(Math.random()*pads.length)];
    const P=sp.cf.pos, R=sp.cf.rot;
    character.group.position.set(P.x, P.y + 7.0, P.z);
    // face the pad's front (LookVector = -col3); camera looks the same way
    const look=new THREE.Vector3(-R[2], -R[5], -R[8]);
    cam.yaw=Math.atan2(-look.x, -look.z);
  } else {
    character.group.position.set(0, 100, 0);
    ui.notify('No SpawnLocation found  spawning at (0, 100, 0), like PlaySolo.');
  }
  /* humanoidSound: the Jumping event plays button.wav (one per jump req) */
  character.onJumped=()=>window.Sounds.sound('button.wav', {volume:0.4});
  character.onLanded=()=>{};
  character.onDeath=()=>{
    ui.notify('You died.');
    if (sjobs) sjobs.registerWipeout();
    setTimeout(spawnAll, 5000);      // PlaySolo: Died:connect → wait(5) → LoadCharacter
  };
  controller=new window.RBLXphysics.Humanoid(character, world);
  if (window.RBLXdyn){
    /* assembly physics picks up where the load-weld left off; the
     * character rides moving assemblies (beacon pads) */
    if (!window.RBLXdyn._ready || window.RBLXdyn.world!==world)
      window.RBLXdyn.init(world);
    /* the load-time flag pass only knows Anchored; now that the weld/glue
     * graph exists, drop flags on static scenery (HQ castle/trees) */
    if (world.refreshControllerFlags) world.refreshControllerFlags();
    window.RBLXdyn.setCharacter(character);
  }
  tools=new window.RBLXtools.ToolManager(scene, world, camera);
  tools.setCharacter(character);
}
function spawnAll(){
  if (!world) return;
  if (tools && tools.unequip) tools.unequip();   // drop tool selection from the old rig
  tools=null;
  if (ui.clearToolSelection) ui.clearToolSelection();
  if (character){ scene.remove(character.group); character=null; }
  spawn().then(()=>{
    /* PlaySolo: LoadCharacter sets Player.Character; fire the classic
     * Changed("Character") so the place's own respawn scripts run.  They
     * relocate the new rig within this tick, before it is rendered. */
    if (sjobs) sjobs.setCharacter(character);
    if (window.RBLXenv&&window.RBLXenv.firePlayerChanged){
      window.RBLXenv.firePlayerChanged('Character');
      window.RBLXenv.tickScripts(0);
    }
  });
}

/* ---------- Lua translation layer driver (fires Stepped + scripts) ---------- */
function luaTick(dt){
  const E=window.RBLXenv;
  if (!E||!window.RBLXlua||!E.state||!E.state.gameInst) return;
  try {
    E.fireStepped(dt);              /* movers integrate + Touched/Stepped/Died fire */
    window.RBLXlua.sched.tick(dt);  /* scripts resume: waiters, handlers, loops */
  } catch (err){
    if (!E.state.luaErrShown){
      E.state.luaErrShown=true;
      console.error('[rbxenv] scheduler error: '+(err&&err.stack||err));
    }
  }
}

/* --------------------------- classic input --------------------------- */
function bindInput(canvas){
  canvas.addEventListener('mousedown', e=>{
    window.Sounds.resume();
    if (e.button===0){ mouse.leftDown=true; mouse.leftPressed=true; }
    else if (e.button===2){ mouse.rightDown=true; }
    mouse.x=e.clientX; mouse.y=e.clientY;
  });
  window.addEventListener('mouseup', e=>{
    if (e.button===0) mouse.leftDown=false;
    else if (e.button===2) mouse.rightDown=false;
  });
  canvas.addEventListener('contextmenu', e=>e.preventDefault());
  window.addEventListener('mousemove', e=>{
    const dx=e.movementX||0, dy=e.movementY||0;
    mouse.x=e.clientX; mouse.y=e.clientY;
    if (mouse.rightDown){
      cam.yaw  -= dx*0.0052;
      cam.pitch-= dy*0.0035;
      cam.pitch=Math.max(-1.25, Math.min(1.25, cam.pitch));
    }
  });
  window.addEventListener('wheel', e=>{
    // start page visible → the site's own scroller handles the wheel natively;
    // only in-game is the wheel bound to camera zoom
    if (document.getElementById('login').style.display!=='none') return;
    cam.distance=Math.max(3, Math.min(60, cam.distance+Math.sign(e.deltaY)*2));
    e.preventDefault();
  }, { passive:false });

  const keys=new Set();
  window.RBLXkeys=keys;           /* Controller input bridge (dynamics.js) */
  window.addEventListener('keydown', e=>{
    if (e.target===ui.$chatInput) return;
    if (e.target && e.target.tagName==='INPUT') return;   // typing on the start page (username box)
    const k=(e.key.length===1)? e.key.toLowerCase() : e.key;
    if (k==='/'){ e.preventDefault(); ui.showChatInput(); return; }
    if (e.key===' '){ e.preventDefault(); }
    keys.add(k);
    if (tools) tools.keyDown(k);
    if (/^[0-9]$/.test(k)) ui.selectTool(k==='0'?9:(+k-1));
  });
  window.addEventListener('keyup', e=>{
    const k=(e.key.length===1)? e.key.toLowerCase() : e.key;
    keys.delete(k);
    if (tools) tools.keyUp(k);
  });
  window.addEventListener('blur', ()=>keys.clear());
  input.keys=keys;

  ui.$chatInput.addEventListener('keydown', e=>{
    if (e.key==='Enter'){
      const t=ui.$chatInput.value.trim();
      if (t){ ui.chat(t, (window.RBLXplayer&&window.RBLXplayer.name)||'Player1'); }   // name color auto from the mined classic palette
      ui.$chatInput.value='';
      ui.hideChatInput();
      window.Sounds.sound('clickfast.wav', {volume:0.4});
      e.preventDefault();
    } else if (e.key==='Escape'){
      ui.$chatInput.value='';
      ui.hideChatInput();
      e.preventDefault();
    }
  });
  /* clicking the chat fold opens the native-style prompt */
  if (ui.$chatList){
    ui.$chatList.addEventListener('mousedown', e=>{ e.preventDefault(); ui.showChatInput(); });
  }
}

/* The client's Report button (shipped ReportAbuse art) above the camera
 * pad.  Hover/press swap the shipped _ovr/_dn frames. */
function bindReportButton(){
  const b=document.getElementById('reportBtn');
  if (!b) return;
  const img=b.querySelector&&b.querySelector('img');
  const set=s=>{ if (img) img.src='content/textures/ReportAbuse'+s+'.PNG'; };
  b.addEventListener('mouseenter',()=>set('_ovr'));
  b.addEventListener('mouseleave',()=>set(''));
  b.addEventListener('mousedown',()=>set('_dn'));
  b.addEventListener('mouseup',()=>set('_ovr'));
}
/* The client's lower-right camera pad (CameraTiltUp/ZoomIn/TiltDown/ZoomOut
 * circle icons, two columns).  Each press is one step, like the toolbar
 * buttons: tilt 0.12 rad, zoom 2 studs (the wheel step). */
function bindCameraControls(){
  const box=document.getElementById('cameraControls');
  if (!box) return;
  const actions={
    tiltUp:  ()=>{ cam.pitch=Math.max(-1.25, cam.pitch-0.12); },
    tiltDown:()=>{ cam.pitch=Math.min( 1.25, cam.pitch+0.12); },
    zoomIn:  ()=>{ cam.distance=Math.max(3, cam.distance-2); },
    zoomOut: ()=>{ cam.distance=Math.min(60, cam.distance+2); }
  };
  box.addEventListener('mousedown', e=>{
    const img=e.target.closest&&e.target.closest('img[data-cam]');
    if (!img) return;
    e.preventDefault();
    const f=actions[img.dataset.cam];
    if (f) f();
  });
  box.addEventListener('dragstart', e=>e.preventDefault());
}

/* --------------------------- 2007 main loop --------------------------- */
const STEP=1/60;
let acc=0;
/* scratch vectors: the loop previously allocated four Vector3 objects per
 * step/frame; at 60 Hz that is pure GC churn */
const _fdir=new THREE.Vector3(), _rdir=new THREE.Vector3();
const _camTarget=new THREE.Vector3(), _camBack=new THREE.Vector3(), _camFwd=new THREE.Vector3();
function loop(){
  requestAnimationFrame(loop);
  /* Nothing in the 3D world needs updating while the start page (which is
   * an opaque DOM overlay) is up: skip the step/render work entirely and
   * just discard elapsed time so joining does not run a catch-up burst. */
  if (!world || (loginEl && loginEl.style.display!=='none')){
    clock.getDelta(); acc=0; return;
  }
  const t0=performance.now();
  const dt=Math.min(0.05, clock.getDelta());
  acc+=dt;
  let n=0;
  while (acc>=STEP && n<4){ step(STEP); acc-=STEP; n++; }
  const t1=performance.now();
  if (canRender) render(dt);
  const t2=performance.now();
  perf.frames++;
  perf.stepMs+=t1-t0; perf.renderMs+=t2-t1;
  perf.lastStepMs=t1-t0; perf.lastRenderMs=t2-t1;
}

function step(dt){
  const keys=(input.keys)||new Set();
  const fwd=(keys.has('w')?1:0)-(keys.has('s')?1:0);
  const side=(keys.has('d')?1:0)-(keys.has('a')?1:0);
  input.jump=keys.has(' ');
  input.climbAxis=fwd;   /* on a ladder W climbs up, S climbs down */
  let t=performance.now();
  if (window.RBLXdyn&&window.RBLXdyn._ready) window.RBLXdyn.step(dt);   /* assembly physics */
  let t2=performance.now(); perf.dynMs+=t2-t; t=t2;
  if (character && controller){
    // camera-relative move basis: forward = (-sin yaw, 0, -cos yaw)
    const cy=Math.cos(cam.yaw), sy=Math.sin(cam.yaw);
    input.moveDir.copy(_fdir.set(-sy, 0, -cy)).multiplyScalar(fwd)
                .addScaledVector(_rdir.set(cy, 0, -sy), side);
    controller.step(dt, input);
    character.step(dt, input);
  }
  t2=performance.now(); perf.charMs+=t2-t; t=t2;
  if (tools){
    tools.update(dt, mouse, character);
  }
  t2=performance.now(); perf.toolsMs+=t2-t; t=t2;
  /* leftPressed is a per-tick edge (like Input.IsPressed): consume it each
   * step so a single click can't leak into later tool equips (the "gears
   * auto-fire on equip" bug) */
  mouse.leftPressed=false;
  if (sjobs){
    sjobs.step(dt);
    if (sjobs.character!==character) sjobs.setCharacter(character);
    t2=performance.now(); perf.sjobsMs+=t2-t; t=t2;
    luaTick(dt);
  }
  t2=performance.now(); perf.luaMs+=t2-t; t=t2;
  if (character) ui.health(character.health/character.maxHealth);
  perf.uiMs+=performance.now()-t;
}

function render(dt){
  const rt0=performance.now();
  const target=_camTarget;
  if (character && character.rigReady){
    const p=character.group.position;
    target.set(p.x, p.y+2.2, p.z);
    const cp=Math.cos(cam.pitch), sp2=Math.sin(cam.pitch);
    const back=_camBack.set(Math.sin(cam.yaw)*cp, sp2, Math.cos(cam.yaw)*cp);
    /* Classic camera boom: pull in before the view crosses solid geometry
     * instead of rendering through walls.  rayHit skips CanCollide=false
     * parts and is exact against each part's OBB. */
    let dist=cam.distance;
    if (world && world.rayHit && dist>0.01){
      const hit=world.rayHit(target, back, dist+0.4);
      if (hit) dist=Math.max(1.2, hit.distance-0.35);
    }
    camera.position.copy(target).addScaledVector(back, dist);
    camera.lookAt(target);
    // first person under 6 studs: hide the rig like the classic client
    const fp=dist<6;
    if (fp!==firstPerson){
      firstPerson=fp;
      character.group.visible=!fp;
    }
    character.nameTag && (character.nameTag.position.y=3.8);
  } else if (world){
    const t=performance.now()*0.0001;
    camera.position.set(Math.cos(t)*60, 30, Math.sin(t)*60);
    camera.lookAt(0, 10, 0);
  }
  /* FMOD listener follows the camera (positional Sound instances) */
  if (window.Sounds && window.Sounds.setListener){
    camera.getWorldDirection(_camFwd);
    window.Sounds.setListener(camera.position, _camFwd, camera.up);
  }
  if (world && world.skyMesh) world.skyMesh.position.copy(camera.position);
  if (world && world.billboardCelestial) world.billboardCelestial(camera);
  const rt1=performance.now();
  if (world && world.frameUpdate) world.frameUpdate();   /* merged static batches */
  const rt2=performance.now();
  renderer.render(scene, camera);
  const rt3=performance.now();
  perf.cameraMs+=rt1-rt0; perf.frameUpdateMs+=rt2-rt1; perf.drawMs+=rt3-rt2;
}

window.addEventListener('load', boot);
window.__leaveGame=()=>{ location.reload(); };
})();
