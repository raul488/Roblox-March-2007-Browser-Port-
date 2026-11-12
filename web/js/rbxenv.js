/* ============================================================
 * rbxenv.js  Roblox API bridge for the Lua translation layer.
 * Exposes the 2007 instance model to scripts running on
 * RBLXlua: game/service/Workspace/Lighting, Instance.new, part
 * properties (Position/CFrame/Velocity/Color/...), Touched/Died
 * signals, clone/remove/makeJoints, Message/Explosion/Sound.
 *
 * World facts it binds to (mined from the runtime modules):
 *  - parts live as parsed RbxInstances; world.partLook: inst → look
 *    {part,size,shape,cf,entry,destroyed,anchored,canCollide,velocity,
 *     rotVelocity,obj,aabb,cullable,...}; world.colliders = looks.
 *  - character carries .group.position/.velocity/.health/.maxHealth/
 *    .alive/.takeDamage/.die (see character.js).
 *  - Part CF application is a row-major 3x3 (R00..R22) + pos
 *    (see world.buildPart); lookVector = -col3 of rot.
 * ============================================================ */
(function(){
"use strict";
const L = window.RBLXlua;          /* loaded before rbxenv in index.html */
if (!L) throw new Error('rbxenv requires luaport.js');
const MT = L.MT;

/* ------------------------------------------------------------
 * Shared state  one live bridge per joined place.
 * ---------------------------------------------------------- */
const state = {
  world:null,           /* WorldBuilder acting today */
  ui:null,              /* RBLXui instance */
  character:null,       /* runtime character marker object */
  parsed:null,          /* today's parsed tree */
  rootInsts:[],         /* top-level parsed insts */

  gameInst:null,        /* fake Game inst */
  workspaceInst:null,   /* parsed Workspace inst (or fake) */
  lightingInst:null,
  playersInst:null,
  playerInst:null,      /* Player1 fake Player */
  humanInst:null,       /* Humanoid fake inst bound to character */
  torsoInst:null,       /* Torso fake inst bound to character */
  modelInst:null,       /* character model fake inst */
  runServiceInst:null,
  services:new Map(),       /* canonical service class -> parsed/fake inst */
  backpackInst:null,        /* Player.Backpack */
  animateInst:null,         /* the shipped humanoidAnimate Script */

  wrapCache:new WeakMap(),   /* RbxInstance → lua wrapper object */
  wrpInfo:new WeakMap(),     /* lua wrapper → {inst, extra} */
  signals:new WeakMap(),     /* inst → {Touched:Sig, Died:Sig} */
  soundHandles:new Map(),   /* inst → {handle, inst} (iterated for 3D tracking) */
  scriptFibers:[],           /* {inst, fiber} launched Script fibers */
  movers:new Set(),          /* looks integrated each Stepped */
  characterMovers:new Set(), /* BodyVelocity/BodyPosition under the character */
  watchSet:new Set(),        /* parts with a Touched listener */
  pendingExplosions:[],      /* Explosion instances waiting out the 0.1 s fuse */
  explosions:[],             /* live Explosion visuals */
  debris:[],                 /* Debris:AddItem queue {inst, t} */
  playerTeam:null,           /* assigned Team instance */
  playerTeamColor:null,      /* BrickColor id (TeamColor) */
  teamsReady:false,          /* game tree has resolved Teams at least once */
  activeHint:null,           /* the Hint instance currently on screen */
  activeMessage:null,        /* the Message instance currently on screen */
  dayMinutes:null,           /* Lighting clock override (GetMinutesAfterMidnight) */
  signals2:null,             /* {stepped: Signal} for the fake RunService */
  poseRev:0,                 /* bumped when any part pose changes (mouse ray cache) */
  mouseRay:null,             /* last mouse-ray signature {px,py,...,t} */

  /* Replication of world changes (host -> relay -> joiners).  Every parsed
   * instance gets a stable id; runtime parts get ids above that range. */
  netMap:new Map(),
  netNextId:1,
  netEnabled:true,
  netDirty:new Set(),
  netNew:new Set(),
  netDead:new Set(),
  netFX:[],
  netPlayers:new Map(),
};

/* ------------------------------------------------------------
 * Vector3 wrapper.  {pv:[x,y,z]} + MT handlers  registered as
 * natives (plain JS fns, callValue's sync path).
 * ---------------------------------------------------------- */
function V3(x,y,z){
  const v={ pv:[x, y, z] };
  v[MT]=V3MT;
  return v;
}
function num3(o){
  if (o && o.pv) return o.pv;
  return null;
}
const V3MT={
  __eq(args){                       /* component compare (classic userdata ==) */
    const u=num3(args[0]), w=num3(args[1]);
    if (!u||!w) return false;
    return u[0]===w[0]&&u[1]===w[1]&&u[2]===w[2];
  },
  __index(args){
    const o=args[0], k=String(args[1]);
    if (!o.pv) throw new L.LuaThrow('attempt to index a Vector3 value badly');
    const pv=o.pv;
    switch (k){
      case 'x': case 'X': return [pv[0]];
      case 'y': case 'Y': return [pv[1]];
      case 'z': case 'Z': return [pv[2]];
      case 'magnitude': case 'Magnitude':
        return [Math.hypot(pv[0],pv[1],pv[2])];
      case 'unit': case 'Unit': {
        const m=Math.hypot(pv[0],pv[1],pv[2])||1;
        return [V3(pv[0]/m, pv[1]/m, pv[2]/m)];
      }
      case 'dot': case 'Dot': case 'cross': case 'Cross':
        throw new L.LuaThrow('Vector3:'+k+' is not needed by the 2007 scripts (use component math)');
    }
    return [undefined];
  },
  __newindex(){ throw new L.LuaThrow('attempt to assign into a Vector3 value'); },
  __add(args){
    const u=num3(args[0]), w=num3(args[1]);
    if (!u||!w) throw new L.LuaThrow('attempt to add non-Vector3');
    return [V3(u[0]+w[0], u[1]+w[1], u[2]+w[2])];
  },
  __sub(args){
    const u=num3(args[0]), w=num3(args[1]);
    if (!u||!w) throw new L.LuaThrow('attempt to subtract non-Vector3');
    return [V3(u[0]-w[0], u[1]-w[1], u[2]-w[2])];
  },
  __mul(args){
    const a=args[0], b=args[1];
    if (typeof a==='number'){ const w=num3(b); if (w) return [V3(a*w[0], a*w[1], a*w[2])]; }
    if (typeof b==='number'){ const u=num3(a); if (u) return [V3(u[0]*b, u[1]*b, u[2]*b)]; }
    const u=num3(a), w=num3(b);
    if (u&&w) return [V3(u[0]*w[0], u[1]*w[1], u[2]*w[2])];   /* component mult */
    throw new L.LuaThrow('attempt to multiply non-Vector3');
  },
  __div(args){
    const a=args[0], b=args[1];
    const w=typeof b==='number'? null : num3(b);
    const u=num3(a);
    if (u && typeof b==='number') return [V3(u[0]/b, u[1]/b, u[2]/b)];
    if (u && w) return [V3(u[0]/w[0], u[1]/w[1], u[2]/w[2])];
    throw new L.LuaThrow('attempt to divide non-Vector3');
  },
  __unm(args){
    const u=num3(args[0]);
    if (!u) throw new L.LuaThrow('attempt to negate non-Vector3');
    return [V3(-u[0], -u[1], -u[2])];
  },
  __tostring(args){
    const u=num3(args[0])||[0,0,0];
    return [u.map(L.fmtNum).join(', ')];
  },
};

/* ------------------------------------------------------------
 * CoordinateFrame wrapper  {pos, rot(9, row-major like the XML)}.
 * CF.new(pos | x,y,z), CF * CF compose, CF * V3 point transform.
 * ---------------------------------------------------------- */
function CF(pos, rot){
  const c={ pos:{x:pos.x||0, y:pos.y||0, z:pos.z||0},
            rot:(rot||[1,0,0, 0,1,0, 0,0,1]).slice() };
  c[MT]=CFMT;
  return c;
}
function cfView(cf){
  /* column vectors: Row-major rot[] → columns X=(R00,R10,R20) etc. */
  const R=cf.rot;
  const col0={x:R[0], y:R[3], z:R[6]}, col1={x:R[1], y:R[4], z:R[7]}, col2={x:R[2], y:R[5], z:R[8]};
  return {xv:col0, yv:col1, zv:col2};
}
function cfMulCF(a, b){
  /* compose: out.rot = a.rot*b.rot ; out.pos = a.pos + a.rot*b.pos */
  const A=a.rot, B=b.rot;
  const M=[0,0,0, 0,0,0, 0,0,0];
  for (let r=0;r<3;r++) for (let c=0;c<3;c++){
    M[r*3+c]=A[r*3]*B[c] + A[r*3+1]*B[3+c] + A[r*3+2]*B[6+c];
  }
  const bp=b.pos, P=a.pos, R=a.rot;
  const newpos={
    x:R[0]*bp.x + R[1]*bp.y + R[2]*bp.z + P.x,
    y:R[3]*bp.x + R[4]*bp.y + R[5]*bp.z + P.y,
    z:R[6]*bp.x + R[7]*bp.y + R[8]*bp.z + P.z,
  };
  return CF(newpos, M);
}
function cfMulV3(a, p){
  const w=num3(p); if (!w) throw new L.LuaThrow('attempt to multiply CFrame by non-Vector3');
  const R=a.rot, P=a.pos;
  return V3(
    R[0]*w[0] + R[1]*w[1] + R[2]*w[2] + P.x,
    R[3]*w[0] + R[4]*w[1] + R[5]*w[2] + P.y,
    R[6]*w[0] + R[7]*w[1] + R[8]*w[2] + P.z);
}
const CFMT={
  __eq(args){
    const a=args[0], b=args[1];
    if (!a||!b||!a.pos||!b.pos) return false;
    if (!(a.pos.x===b.pos.x&&a.pos.y===b.pos.y&&a.pos.z===b.pos.z)) return false;
    if (!a.rot||!b.rot||a.rot.length!==b.rot.length) return false;
    for (let i=0;i<9;i++) if (a.rot[i]!==b.rot[i]) return false;
    return true;
  },
  __index(args){
    const o=args[0], k=String(args[1]);
    const v=cfView(o);
    switch (k){
      case 'p': case 'P': case 'position':
        return [V3(o.pos.x, o.pos.y, o.pos.z)];
      case 'lookVector': case 'LookVector':
        return [V3(-v.zv.x, -v.zv.y, -v.zv.z)];   /* LookVector = -col3 */
      case 'xVector': case 'XVector': return [V3(v.xv.x, v.xv.y, v.xv.z)];
      case 'yVector': case 'YVector': return [V3(v.yv.x, v.yv.y, v.yv.z)];
      case 'zVector': case 'ZVector': return [V3(v.zv.x, v.zv.y, v.zv.z)];
    }
    return [undefined];
  },
  __mul(args){
    const a=args[0], b=args[1];
    if (b&&b.pv!==undefined) return [cfMulV3(a, b)];
    if (b&&b.pos&&b.rot) return [cfMulCF(a, b)];
    throw new L.LuaThrow('attempt to multiply CFrame by non-CFrame');
  },
  __tostring(args){
    const o=args[0];
    return ['CFrame('+L.fmtNum(o.pos.x)+', '+L.fmtNum(o.pos.y)+', '+L.fmtNum(o.pos.z)+')'];
  },
};

/* ------------------------------------------------------------
 * Color3 wrapper  {c:[r,g,b] 0..1 floats}.
 * ---------------------------------------------------------- */
function Color3(r,g,b){
  const c={ cl:[r,g,b] };
  c[MT]=C3MT;
  return c;
}
const C3MT={
  __eq(args){
    const a=args[0], b=args[1];
    if (!a||!b||!a.cl||!b.cl) return false;
    return a.cl[0]===b.cl[0]&&a.cl[1]===b.cl[1]&&a.cl[2]===b.cl[2];
  },
  __index(args){
    const o=args[0], k=String(args[1]);
    const c=o.cl;
    switch (k){
      case 'r': case 'R': return [c[0]];
      case 'g': case 'G': return [c[1]];
      case 'b': case 'B': return [c[2]];
    }
    return [undefined];
  },
  __tostring(args){
    const c=args[0].cl;
    return [c.map(L.fmtNum).join(', ')];
  },
};

/* BrickColor wrapper {id, cl}  bridges BrickColor.new(idOrName).Color.
 * Name lookup scans the WHOLE shipped palette (ids run to 1032 with gaps
 * the old loop stopped at 64 and never found e.g. "Cool yellow"). */
function paletteEntries(){
  const out=[];
  const pal=window.BrickColors||[];
  for (let i=0;i<pal.length;i++) if (pal[i]) out.push(pal[i]);
  return out;
}
function BrickColor(spec){
  let id=2, cl=[163/255,163/255,163/255];
  if (typeof spec==='number'){
    id=spec|0;
  } else {
    const wanted=String(spec).toLowerCase();
    for (const e of paletteEntries()){
      if (e && e.name.toLowerCase()===wanted){ id=e.id; break; }
    }
  }
  const e=window.BrickColorFromId(id);
  if (e) cl=[e.rgb[0]/255, e.rgb[1]/255, e.rgb[2]/255];
  const b={ bid:id, cl };
  b[MT]=BCMT;
  return b;
}
const BCMT={
  __eq(args){
    const a=args[0], b=args[1];
    return !!a&&!!b&&typeof a.bid==='number'&&typeof b.bid==='number'&&a.bid===b.bid;
  },
  __index(args){
    const o=args[0], k=String(args[1]);
    switch (k){
      case 'Number': case 'number': return [o.bid];
      case 'Color': case 'color': return [Color3(o.cl[0], o.cl[1], o.cl[2])];
      case 'Name': case 'name': return [String((window.BrickColorFromId(o.bid)||{}).name||'Medium stone grey')];
    }
    return [undefined];
  },
  __tostring(args){
    const o=args[0];
    return [String((window.BrickColorFromId(o.bid)||{}).name||'Medium stone grey')];
  },
};

/* ------------------------------------------------------------
 * Signals (Touched/Died/Stepped).  connect(fn) launches fn as its
 * own fiber each firing (classic behavior); wait() yields to the
 * scheduler and returns the firing values.
 * ---------------------------------------------------------- */
class Signal{
  constructor(name){ this.name=name||'signal'; this.list=[]; }
  connect(fn, ipCtx){
    if (!(fn&&(fn.lua||typeof fn==='function')))
      throw new L.LuaThrow('connect expects a function');
    const ip=ipCtx||(L.currentIp&&L.currentIp())||L.sched.interp;   /* env of the connecting script */
    const entry={fn, active:true, ip};
    this.list.push(entry);
    if (ip){
      if (!ip.__connections) ip.__connections=[];
      ip.__connections.push({sig:this, entry});
    }
    const sig=this;
    const conn={ [MT]:{ __index(args){
      const k=String(args[1]);
      if (k==='disconnect'||k==='Disconnect'){
        return mkM(()=>{ dropConnection(sig, entry); return []; });
      }
      return [undefined];
    }} };
    conn.__sigEntry=entry;
    return conn;
  }
  fire(args){
    const snapshot=this.list.slice();
    let launched=0;
    this.lastVals=args||[];
    for (const e of snapshot){
      if (!e.active || (e.ip&&e.ip.__dead)) continue;
      const ip=e.ip;                             /* handler runs in ITS env */
      if (ip){
        ip.sched.launchFiber(e.fn, args||[], null, null, ip);
        launched++;
      }
    }
    return launched;
  }
}
/* Drop one connection and forget it in the owning script env.  Classic
 * scripts do not keep receiving events after their instance leaves the
 * DataModel, so killScript() calls disconnectEnv() below. */
function dropConnection(sig, entry){
  entry.active=false;
  const i=sig.list.indexOf(entry);
  if (i>=0) sig.list.splice(i,1);
  const ip=entry.ip;
  if (ip&&ip.__connections){
    const j=ip.__connections.findIndex(c=>c.entry===entry);
    if (j>=0) ip.__connections.splice(j,1);
  }
}
function disconnectEnv(env){
  if (!env||!env.__connections) return;
  const list=env.__connections.slice();
  env.__connections.length=0;
  for (const c of list) dropConnection(c.sig, c.entry);
  env.__dead=true;
}
function mkM(fn){ return (args)=>fn(args); }
/* children() must be a Lua array (the shipped Animate script does #kids) */
function luaArray(arr){
  const t=new L.LuaTable();
  for (let i=0;i<arr.length;i++) t.set(i+1, arr[i]);
  return t;
}
function launchFiber(fn, args){
  const ip=(L.currentIp&&L.currentIp())||L.sched.interp;
  if (!ip) return null;
  return ip.sched.launchFiber(fn, args||[], null, null, ip);
}

/* ------------------------------------------------------------
 * ScriptMouse  the object 2007 HopperBin/Tool scripts receive:
 *   mouse.Icon, mouse.Target, mouse.Hit, mouse.X/Y,
 *   mouse.Button1Down/Button1Up/KeyDown/KeyUp signals.
 * Hit/Target are refreshed from the live camera ray every frame.
 * ---------------------------------------------------------- */
const mouseState={
  x:0, y:0, leftDown:false, leftPressed:false, rightDown:false,
  icon:'ArrowCursor.png', target:null, hit:CF({x:0,y:0,z:0}),
  sig:{},
};
function mouseSignal(name){
  let s=mouseState.sig[name];
  if (!s){ s=new Signal('Mouse.'+name); mouseState.sig[name]=s; }
  return s;
}
/* The 2007 scripts assign rbxasset://textures\\FooCursor.png (or just
 * FooCursor.png).  Map it to the shipped content path so the browser can
 * actually load the cursor; keep the original string in mouse.Icon. */
function cursorUrl(icon){
  let u=String(icon||'').replace(/\\/g,'/');
  if (!u) return '';
  if (u.indexOf('rbxasset://')===0 && window.RBLXxml&&window.RBLXxml.assetMap)
    u=window.RBLXxml.assetMap(u);
  else if (!/^(?:[a-z]+:|\/|content\/)/i.test(u))
    u='content/textures/'+u.replace(/^.*\//,'');
  return u;
}
/* CSS cursor hotspots, derived from each shipped *Cursor.png's own
 * pixels: arrow cursors point with the opaque bbox's top-left corner,
 * icon/crosshair cursors with its centre ((min+max)>>1 per axis).  The
 * PNGs are 80×80 with transparent padding, so without these offsets the
 * browser pins the transparent top-left corner to the pointer and the
 * visible arrow lands ~39px down-right of every click. */
const CURSOR_HOTSPOTS={
  'AnchorCursor.png':'36 42',
  'ArrowCursor.png':'39 40',
  'ArrowFarCursor.png':'38 37',
  'CloneCursor.png':'50 50',
  'CloneDownCursor.png':'39 41',
  'CloneOverCursor.png':'49 50',
  'DragCursor.png':'43 56',
  'DropperCursor.png':'40 23',
  'FillCursor.png':'43 22',
  'FlagCursor.png':'36 20',
  'FlatCursor.png':'44 36',
  'GlueCursor.png':'40 38',
  'GrabCursor.png':'51 46',
  'GrabRotateCursor.png':'36 52',
  'GunCursor.png':'39 40',
  'GunWaitCursor.png':'40 46',
  'HammerCursor.png':'48 53',
  'HammerDownCursor.png':'53 27',
  'HammerOverCursor.png':'46 51',
  'HingeCursor.png':'42 38',
  'LockCursor.png':'42 43',
  'MissingCursor.png':'55 56',
  'MotorCursor.png':'43 37',
  'ResizeCursor.png':'42 42',
  'SpawnCursor.png':'42 39',
  'UnAnchorCursor.png':'38 42',
  'UnlockCursor.png':'43 43',
  'WeldCursor.png':'42 30',
};
function cursorHotspot(u){
  const f=String(u||'').split(/[?#]/)[0].replace(/\\/g,'/').replace(/^.*\//,'');
  return CURSOR_HOTSPOTS[f]||null;
}
const MouseMT={
  __index(args){
    const k=String(args[1]);
    switch (k){
      case 'Icon': case 'icon': return [mouseState.icon];
      case 'Target': case 'target': return [mouseState.target? wrap(mouseState.target) : undefined];
      case 'Hit': case 'hit': return [mouseState.hit];
      case 'X': case 'x': return [mouseState.x];
      case 'Y': case 'y': return [mouseState.y];
      case 'ViewSizeX': return [typeof window!=='undefined'? (window.innerWidth||1) : 1];
      case 'ViewSizeY': return [typeof window!=='undefined'? (window.innerHeight||1) : 1];
      case 'Button1Down': return [wrapSignal(mouseSignal('Button1Down'), 'Button1Down')];
      case 'Button1Up': return [wrapSignal(mouseSignal('Button1Up'), 'Button1Up')];
      case 'KeyDown': return [wrapSignal(mouseSignal('KeyDown'), 'KeyDown')];
      case 'KeyUp': return [wrapSignal(mouseSignal('KeyUp'), 'KeyUp')];
      case 'Idle': return [wrapSignal(mouseSignal('Idle'), 'Idle')];
    }
    return [undefined];
  },
  __newindex(args){
    const k=String(args[1]);
    if (k==='Icon'||k==='icon'){
      mouseState.icon=String(args[2]||'');
      try {
        if (window.document&&window.document.body){
          const u=cursorUrl(mouseState.icon);
          const hs=cursorHotspot(u);
          window.document.body.style.cursor = u
            ? 'url("'+u.replace(/"/g,'%22')+'")'+(hs? ' '+hs : '')+', auto'
            : '';
        }
      } catch(_){}
      return;
    }
    return;
  },
};
const MOUSE={ [MT]:MouseMT };

/* refresh mouse.Target/Hit from the current camera ray */
function updateMouse(input){
  if (!input) return;
  mouseState.x=Number(input.x)||0;
  mouseState.y=Number(input.y)||0;
  mouseState.leftDown=!!input.leftDown;
  mouseState.leftPressed=!!input.leftPressed;
  mouseState.rightDown=!!input.rightDown;
  const w=state.world;
  if (!w||!w.rayFromCamera) return;
  /* The classic Mouse.Target/Hit is recomputed every frame, but re-casting
   * an unchanged ray against every collider at 60 Hz is pure CPU.  This
   * signature covers the mouse pixel, camera pose, collider count and any
   * part-pose change (state.poseRev); identical input reuses the last
   * result.  When things do move, cap it at roughly one ray per rendered
   * frame instead of one per 1/60 s physics substep. */
  const cam=w._camera||window.__camera;
  const now=performance.now();
  const rr=state.mouseRay||(state.mouseRay={});
  const mx=Math.round(mouseState.x*4), my=Math.round(mouseState.y*4);
  let px=0,py=0,pz=0,qx=0,qy=0,qz=0,qw=1;
  if (cam&&cam.position&&cam.quaternion){
    const p=cam.position, q=cam.quaternion;
    px=Math.round(p.x*256); py=Math.round(p.y*256); pz=Math.round(p.z*256);
    qx=Math.round(q.x*4096); qy=Math.round(q.y*4096); qz=Math.round(q.z*4096); qw=Math.round(q.w*4096);
  }
  const nc=w.colliders?w.colliders.length:0, rev=state.poseRev|0;
  const changed=(rr.mx!==mx||rr.my!==my||rr.px!==px||rr.py!==py||rr.pz!==pz||
                 rr.qx!==qx||rr.qy!==qy||rr.qz!==qz||rr.qw!==qw||rr.nc!==nc||rr.rev!==rev);
  if (!changed) return;                       /* ray (and hit) unchanged */
  if (now-(rr.t||0) < 13) return;             /* at most one ray per frame */
  rr.mx=mx; rr.my=my; rr.px=px; rr.py=py; rr.pz=pz;
  rr.qx=qx; rr.qy=qy; rr.qz=qz; rr.qw=qw; rr.nc=nc; rr.rev=rev; rr.t=now;
  let ray=null;
  try { ray=w.rayFromCamera(mouseState.x, mouseState.y); } catch(_){ ray=null; }
  if (!ray) return;
  let hit=null;
  try { hit=w.rayHit? w.rayHit(ray.origin, ray.dir, 800) : null; } catch(_){ hit=null; }
  if (hit&&hit.look&&!hit.look.destroyed){
    mouseState.target=hit.look.part;
    mouseState.hit=lookCF({x:hit.hit.x,y:hit.hit.y,z:hit.hit.z},
      {x:hit.hit.x+ray.dir.x, y:hit.hit.y+ray.dir.y, z:hit.hit.z+ray.dir.z});
  } else {
    mouseState.target=null;
    const far={x:ray.origin.x+ray.dir.x*800, y:ray.origin.y+ray.dir.y*800, z:ray.origin.z+ray.dir.z*800};
    mouseState.hit=lookCF({x:far.x,y:far.y,z:far.z},
      {x:far.x+ray.dir.x, y:far.y+ray.dir.y, z:far.z+ray.dir.z});
  }
}
function fireMouse(name, args){
  const s=mouseState.sig[name];
  if (s) s.fire(args||[]);
}
function mouseDown(){ mouseState.leftDown=true; fireMouse('Button1Down', [MOUSE]); }
function mouseUp(){ mouseState.leftDown=false; fireMouse('Button1Up', [MOUSE]); }
function keyDown(k){ fireMouse('KeyDown', [MOUSE, String(k)]); }
function keyUp(k){ fireMouse('KeyUp', [MOUSE, String(k)]); }
function mouseHasHandlers(name){
  const s=mouseState.sig[name];
  return !!(s&&s.list.some(e=>e.active));
}

/* fire a named instance event (Tool.Equipped / HopperBin.Selected / ...) */
function fireEvent(inst, name, args){
  if (!inst) return 0;
  const sig=touchedSignal(inst, name);
  return sig.fire(args||[]);
}
/* if no script connected the instance event, call the global callback of the
 * same classic name (onSelected/onEquipped/onActivated/onButton1Down...). */
function invokeCallback(inst, name, args){
  if (!inst) return null;
  const sig=state.signals.get(inst);
  const s=sig&&sig[name];
  if (s&&s.list.some(e=>e.active)) return null;   /* signal already fans out */
  const env=inst.__env;
  if (!env||!env.G) return null;
  const fn=env.G.get(name);
  if (!fn) return null;
  return L.sched.launchFiber(fn, args||[], null, null, env);
}

/* ------------------------------------------------------------
 * Wrapper identity: every RbxInstance gets exactly one lua wrapper
 * (WeakMap-cached) so comparison (==) and Touched identity work.
 * ---------------------------------------------------------- */
function wrap(inst){
  if (!inst) return undefined;
  let w=state.wrapCache.get(inst);
  if (w) return w;
  w={ __rinst:inst };
  w[MT]=InstMT;
  state.wrapCache.set(inst, w);
  state.wrpInfo.set(w, {inst});
  return w;
}
function unwrap(w){
  if (!w||typeof w!=='object') return null;
  if (w.__rinst) return w.__rinst;
  return null;
}
const PART_CLASSES=new Set(['Part','SpawnLocation','Seat','TrussPart','WedgePart']);
/* legacy JointInstance family.  Authored joints are real objects: they bind
 * their Part0/Part1 regardless of surface tokens. */
const JOINT_CLASSES=new Set(['Weld','Glue','Motor','RotateP','RotateV','Snap']);
function isRunnableScript(it){
  return !!it && (it.cls==='Script'||it.cls==='LocalScript');
}

/* SurfaceType bridge (decomp enum 490994; Part ctor 356583). Lua writes are
 * live: the mesh rebuilds and the joint graph is re-clustered next step. */
const SURFACE_FACE_KEYS=['Right','Top','Back','Left','Bottom','Front'];
const SURFACE_DEFAULT=[0,3,0,0,4,0];
const SURFACE_BY_NAME={Smooth:0,Glue:1,Weld:2,Studs:3,Inlet:4,
                       Spawn:5,Hinge:6,Motor:7,SteppingMotor:8,Bumps:9};
function surfaceToken(v){
  if (typeof v==='number' && isFinite(v)){ const t=v|0; return (t>=0&&t<=9)?t:0; }
  if (typeof v==='string'){
    const s=v.trim();
    if (/^\d+$/.test(s)){ const t=parseInt(s,10); return (t>=0&&t<=9)?t:0; }
    if (SURFACE_BY_NAME[s]!=null) return SURFACE_BY_NAME[s];
  }
  return 0;
}
function surfaceProp(key){
  const m=/^(Right|Top|Back|Left|Bottom|Front)(Surface|SurfaceInput|ParamA|ParamB)$/.exec(key);
  return m? { face:SURFACE_FACE_KEYS.indexOf(m[1]), kind:m[2] } : null;
}
function partSurface(inst, face){
  const v=inst.props[SURFACE_FACE_KEYS[face]+'Surface'];
  return (v==null)? SURFACE_DEFAULT[face] : surfaceToken(v);
}
function refreshPartVisual(inst){
  const w=state.world;
  if (w&&w.refreshPartArt) w.refreshPartArt(inst);
}
function updatePartExtent(inst, size, shape){
  if (size) inst.props.size={x:size.x,y:size.y,z:size.z};
  if (shape!=null) inst.props.shape=shape;
  const look=viewLook(inst);
  if (!look) return;
  if (size) look.size={x:size.x,y:size.y,z:size.z};
  if (shape!=null) look.shape=shape;
  delete look.__pbox;                       /* physics OBB cache is extent-stale */
  if (look.cf&&look.size){
    const R=look.cf.rot, P=look.cf.pos, hx=look.size.x/2, hy=look.size.y/2, hz=look.size.z/2;
    const ex=Math.abs(R[0])*hx+Math.abs(R[1])*hy+Math.abs(R[2])*hz;
    const ey=Math.abs(R[3])*hx+Math.abs(R[4])*hy+Math.abs(R[5])*hz;
    const ez=Math.abs(R[6])*hx+Math.abs(R[7])*hy+Math.abs(R[8])*hz;
    look.aabb={ min:{x:P.x-ex,y:P.y-ey,z:P.z-ez}, max:{x:P.x+ex,y:P.y+ey,z:P.z+ez} };
  }
  refreshPartVisual(inst);
  markJointDirty();
  staticDirty(look);
}
function markJointDirty(){
  if (window.RBLXdyn&&window.RBLXdyn.markDirty) window.RBLXdyn.markDirty();
}
/* a member of a merged static batch changed (or moved)  world rebuilds the
 * batch next frame.  Only BATCHED looks need the rebuild: a solo part's own
 * mesh is already live, and moving free assemblies (the HHH crane) would
 * otherwise force a full world re-merge every frame. */
function staticDirty(look){
  if (look&&look.__batched){
    const w=state.world;
    if (w&&w.markStaticDirty) w.markStaticDirty();
  }
}

/* child-by-name helper: exact-match preferred, case-insensitive fallback */
function childByName(inst, nm){
  let wanted=String(nm);
  /* classic Humanoid limb aliases: shipped TeamBeacon scripts use
   * humanoid.LeftLeg / humanoid.RightLeg while the Model parts are named
   * "Left Leg" / "Right Leg". */
  if (inst&&inst.__fakeHumanoid){
    const alias={LeftLeg:'Left Leg', RightLeg:'Right Leg',
                 LeftArm:'Left Arm', RightArm:'Right Arm'};
    if (alias[wanted]) wanted=alias[wanted];
  }
  for (const c of inst.children){
    if (c.props.Name===wanted) return c;
  }
  const lower=wanted.toLowerCase();
  for (const c of inst.children){
    if (String(c.props.Name||'').toLowerCase()===lower) return c;
  }
  return null;
}

/* live partCF for reads (movers move here); falls back to parsed props */
function liveCF(inst){
  const world=state.world;
  const look=world&&world.partLook&&world.partLook.get(inst);
  if (look) return look.cf;
  const cf=inst.props.CFrame;
  return cf||{pos:{x:0,y:0,z:0}, rot:[1,0,0, 0,1,0, 0,0,1]};
}

/* RotVelocity is world-space angular velocity (radians/second).  Apply the
 * incremental rotation on the left of the part's row-major CFrame rotation:
 * new local->world = Q(world) * R(local->world). */
function spinPartRotation(rot, w, dt){
  const wx=w.x||0, wy=w.y||0, wz=w.z||0;
  const speed=Math.hypot(wx,wy,wz);
  if (!(speed>1e-9)||!(dt>0)) return rot;
  const ux=wx/speed, uy=wy/speed, uz=wz/speed;
  const a=speed*dt, c=Math.cos(a), s=Math.sin(a), t=1-c;
  const Q=[
    t*ux*ux+c,   t*ux*uy-s*uz, t*ux*uz+s*uy,
    t*ux*uy+s*uz, t*uy*uy+c,   t*uy*uz-s*ux,
    t*ux*uz-s*uy, t*uy*uz+s*ux, t*uz*uz+c,
  ];
  const M=new Array(9);
  for (let i=0;i<3;i++) for (let j=0;j<3;j++){
    M[i*3+j]=Q[i*3]*rot[j]+Q[i*3+1]*rot[3+j]+Q[i*3+2]*rot[6+j];
  }
  return M;
}

/* Humanoid fake reads/writes marshal to the runtime character */
function char(){
  return state.character;
}

/* A fake rig part/humanoid may belong to a remote player.  Local rigs have
 * __charObj too; fall back to the host character for old fake instances. */
function charOf(inst){
  return (inst&&inst.__charObj)||char();
}

function netIdOf(inst){
  if (!inst) return 0;
  if (inst.netId == null) {
    inst.netId = state.netNextId++;
    state.netMap.set(inst.netId, inst);
  } else if (!state.netMap.has(inst.netId)) {
    state.netMap.set(inst.netId, inst);
  }
  return inst.netId;
}

function netMark(inst){
  if (!inst || !isPartLike(inst) || state.netEnabled === false || !netReplicablePart(inst)) return;
  if (state.netNew.has(inst)) return;
  state.netDirty.add(inst);
}

/* Only visible Workspace parts cross the wire.  Held tools, Backpacks and
 * fake character rigs stay local to the host. */
function netReplicablePart(inst){
  if (!inst || !state.workspaceInst) return false;
  for (let p=inst; p; p=p.parent){
    if (p===state.workspaceInst) return true;
    if (p.__character || p.__player || p.cls==='Player' ||
        p.cls==='Tool' || p.cls==='HopperBin' || p.cls==='Backpack') return false;
  }
  return false;
}

function netAssignParsed(parsed){
  state.netMap = new Map();
  state.netEnabled = true;
  state.netDirty = new Set();
  state.netNew = new Set();
  state.netDead = new Set();
  state.netFX = [];
  state.netPlayers = new Map();
  state.netNextId = 1;
  const list = (parsed && parsed.instances) || [];
  for (const inst of list){
    if (!inst) continue;
    if (inst.netId == null) inst.netId = state.netNextId;
    if (inst.netId >= state.netNextId) state.netNextId = inst.netId + 1;
    state.netMap.set(inst.netId, inst);
  }
}

function round3(n){ return Math.round((Number(n)||0)*1000)/1000; }

/* Serialize one part for the relay.  Only declarative properties; no
 * Scripts, Sources, URLs or other executable/content fields. */
function packNetPart(inst){
  if (!inst || !isPartLike(inst) || !netReplicablePart(inst)) return null;
  const look = viewLook(inst);
  if (!look || look.destroyed) return null;
  const cf = look.cf || inst.props.CFrame || { pos:{x:0,y:0,z:0}, rot:[1,0,0,0,1,0,0,0,1] };
  const s = look.size || inst.props.size || { x:1, y:1, z:1 };
  const f = [
    round3(cf.pos.x), round3(cf.pos.y), round3(cf.pos.z),
    round3(cf.rot[0]), round3(cf.rot[1]), round3(cf.rot[2]),
    round3(cf.rot[3]), round3(cf.rot[4]), round3(cf.rot[5]),
    round3(cf.rot[6]), round3(cf.rot[7]), round3(cf.rot[8])
  ];
  const out = {
    i: netIdOf(inst),
    c: inst.cls || 'Part',
    s: [round3(s.x), round3(s.y), round3(s.z)],
    f: f,
    a: inst.props.Anchored ? 1 : 0,
    k: inst.props.CanCollide === false ? 0 : 1,
    h: Number(inst.props.shape) || 1
  };
  const b = Number(inst.props.BrickColor);
  if (Number.isFinite(b)) out.b = b;
  else if (look.entry && look.entry.rgb) out.rgb = look.entry.rgb.slice(0,3);
  const t = Number(inst.props.Transparency);
  if (t > 0) out.t = Math.min(1, Math.max(0, t));
  const refl = Number(inst.props.Reflectance);
  if (refl > 0) out.r = Math.min(1, Math.max(0, refl));
  const sf = ['RightSurface','TopSurface','BackSurface','LeftSurface','BottomSurface','FrontSurface']
    .map(k => { const v = Number(inst.props[k]); return Number.isFinite(v) ? v : 0; });
  if (sf.some(Boolean)) out.sf = sf;
  return out;
}

function applyNetPart(inst, p){
  if (!inst || !p) return;
  const look = viewLook(inst);
  if (!look || look.destroyed) return;

  if (p.f && p.f.length >= 12){
    const nums = p.f.slice(0, 12).map(Number);
    if (nums.every(Number.isFinite)){
      placePart(inst, {
        pos: { x:nums[0], y:nums[1], z:nums[2] },
        rot: nums.slice(3, 12)
      });
    }
  }

  if (p.b != null || p.rgb){
    let rgb = null;
    const bid = Number(p.b);
    if (p.b != null && Number.isFinite(bid)){
      const e = window.BrickColorFromId ? window.BrickColorFromId(bid) : null;
      if (e && e.rgb) rgb = e.rgb;
      inst.props.BrickColor = Math.max(0, Math.min(4096, bid));
    } else if (Array.isArray(p.rgb) && p.rgb.length >= 3){
      rgb = p.rgb.slice(0,3).map(n => Math.max(0, Math.min(255, Number(n)||0)));
    }
    if (rgb) recolorPart(inst, [rgb[0]/255, rgb[1]/255, rgb[2]/255]);
  }

  if (p.t != null && look.obj){
    const v = Math.min(1, Math.max(0, Number(p.t) || 0));
    inst.props.Transparency = v;
    const mats = ownLookMaterials(look);
    for (const m of mats){
      if (m){ m.transparent = v > 0.001; m.opacity = 1 - v; m.needsUpdate = true; }
    }
    look.obj.visible = v < 0.95;
    staticDirty(look);
  }

  if (p.a != null){
    const v = !!p.a;
    inst.props.Anchored = v;
    look.anchored = v;
    if (window.RBLXdyn && window.RBLXdyn.setAnchored){
      try { window.RBLXdyn.setAnchored(look, v); } catch(_){}
    }
    if (state.world && state.world.refreshControllerFlag)
      state.world.refreshControllerFlag(inst);
  }

  if (p.k != null){
    const v = !!p.k;
    inst.props.CanCollide = v;
    look.canCollide = v;
    const w = state.world;
    if (w && w.colliders){
      const i = w.colliders.indexOf(look);
      if (!v && i >= 0) w.colliders.splice(i, 1);
      else if (v && i < 0 && look.aabb) w.colliders.push(look);
    }
  }
}

function createNetPart(p){
  if (!p || !p.i) return null;
  const cls = (p.c === 'SpawnLocation' || p.c === 'TrussPart') ? p.c : 'Part';
  const inst = mkInst(cls, 'Part');
  inst.netId = p.i;
  state.netMap.set(p.i, inst);
  const clamp = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  if (p.s) inst.props.size = {
    x:clamp(p.s[0], 0.1, 1024, 1),
    y:clamp(p.s[1], 0.1, 1024, 1),
    z:clamp(p.s[2], 0.1, 1024, 1)
  };
  if (p.f && p.f.length >= 12){
    const f = p.f.slice(0,12).map(n => clamp(n, -1e7, 1e7, 0));
    inst.props.CFrame = { pos:{x:f[0], y:f[1], z:f[2]}, rot:f.slice(3,12) };
  } else {
    inst.props.CFrame = { pos:{x:0,y:0,z:0}, rot:[1,0,0,0,1,0,0,0,1] };
  }
  if (p.b != null) inst.props.BrickColor = clamp(p.b, 0, 4096, 2);
  inst.props.Transparency = clamp(p.t, 0, 1, 0);
  inst.props.Anchored = !!p.a;
  inst.props.CanCollide = p.k !== 0;
  inst.props.shape = clamp(p.h, 0, 2, 1);
  if (p.sf){
    const names = ['RightSurface','TopSurface','BackSurface','LeftSurface','BottomSurface','FrontSurface'];
    for (let i=0;i<names.length;i++) inst.props[names[i]] = clamp(p.sf[i], 0, 8, 0);
  }
  reparent(inst, state.workspaceInst);
  applyNetPart(inst, p);
  return inst;
}

function netDrain(){
  if (state.netEnabled === false) return { p:[], d:[], f:[] };
  const out = { p:[], d:[], f:[] };
  for (const inst of state.netNew){
    const p = packNetPart(inst);
    if (p){ p.n = 1; out.p.push(p); }
  }
  for (const inst of state.netDirty){
    if (state.netNew.has(inst)) continue;
    const p = packNetPart(inst);
    if (p){ p.n = 0; out.p.push(p); }
  }
  for (const inst of state.netDead){
    if (inst && inst.netId != null) out.d.push(inst.netId);
  }
  out.f = state.netFX.splice(0);
  state.netNew.clear();
  state.netDirty.clear();
  state.netDead.clear();
  return out;
}

const InstMT={
  __index(args){
    const w=args[0], key=String(args[1]);
    const inst=w.__rinst;
    const cls=inst.cls||'';
    /* pseudo-fields on the fake insts come first */
    if (inst.__fakeHumanoid){
      switch (key){
        case 'Health': { const c=charOf(inst); return [c? c.health : undefined]; }
        case 'MaxHealth': { const c=charOf(inst); return [c? c.maxHealth : undefined]; }
        case 'WalkSpeed': { const c=charOf(inst); return [c? c.walkSpeed : 16]; }
        case 'JumpPower': { const c=charOf(inst); return [c? c.jumpVelocity : 50]; }
        case 'Parent': return [wrap(inst.parent)];
        case 'Died': case 'Running': case 'Jumping': case 'FreeFalling':
        case 'Climbing': case 'GettingUp': case 'FallingDown':
          return [wrapSignal(touchedSignal(inst, key), key)];
      }
    }
    if (inst.__fakeTorso){
      const ch=charOf(inst), nm=inst.__charPart||inst.props.Name||'Torso';
      switch (key){
        case 'Velocity': {
          const v=ch? ch.velocity : null;
          return [v? V3(v.x, v.y, v.z) : V3(0,0,0)];
        }
        case 'CFrame': {
          if (ch&&ch.partWorldCF){
            const cf=ch.partWorldCF(nm);
            return [CF(cf.pos, cf.rot)];
          }
          const p=ch? ch.group.position : {x:0,y:0,z:0};
          return [CF(p, [1,0,0, 0,1,0, 0,0,1])];
        }
        case 'Position': {
          if (ch&&ch.partWorldCF){
            const cf=ch.partWorldCF(nm);
            return [V3(cf.pos.x, cf.pos.y, cf.pos.z)];
          }
          const p=ch? ch.group.position : {x:0,y:0,z:0};
          return [V3(p.x,p.y,p.z)];
        }
        case 'Size': {
          const rec=ch&&ch.parts? ch.parts[nm] : null;
          const s=rec? rec.size : (inst.props.size||{x:2,y:2,z:1});
          return [V3(s.x,s.y,s.z)];
        }
        case 'Transparency': {
          if (ch&&ch.getPartTransparency) return [ch.getPartTransparency(nm)];
          return [inst.props.Transparency||0];
        }
        case 'BrickColor': {
          const rec=ch&&ch.parts? ch.parts[nm] : null;
          return [BrickColor(rec&&rec.brickColorId!=null? rec.brickColorId : (inst.props.BrickColor||24))];
        }
        case 'Color': {
          const rec=ch&&ch.parts? ch.parts[nm] : null;
          const c=rec&&rec.color? rec.color : new THREE.Color(0.8,0.8,0.8);
          return [Color3(c.r,c.g,c.b)];
        }
        case 'Anchored': return [false];
        case 'CanCollide': return [false];
        case 'Parent': return [wrap(inst.parent)];
      }
    }
    if (inst.__motor){
      const M=char()&&char().Motors? char().Motors[inst.__motor] : null;
      switch (key){
        case 'MaxVelocity': return [M? M.MaxVelocity : 0.15];
        case 'DesiredAngle': return [M? M.DesiredAngle : 0];
        case 'CurrentAngle': return [M? M.CurrentAngle : 0];
        case 'Name': return [inst.props.Name||inst.__motor];
        case 'Parent': return [wrap(inst.parent)];
      }
    }
    /* SurfaceType family  read the live Part surface array (decomp +0x7c)
     * and the Surface object's {input, ParamA, ParamB} defaults. */
    {
      const sp=surfaceProp(key);
      if (sp && PART_CLASSES.has(cls)){
        if (sp.kind==='Surface') return [partSurface(inst, sp.face)];
        if (sp.kind==='SurfaceInput') return [inst.props[key]!=null? inst.props[key] : 0];
        return [inst.props[key]!=null? inst.props[key] : (sp.kind==='ParamA'? -0.5 : 0.5)];
      }
    }
    switch (key){
      case 'Name': return [inst.props.Name!==undefined? inst.props.Name : cls];
      case 'ClassName': case 'className':
        /* 2007 scripts read the lowercase className (HumanoidHarvesterHorror:
         * `parts[p].className == "Part"`) */
        return [cls];
      case 'Parent': return [inst.parent? wrap(inst.parent) : undefined];
      case 'findFirstChild': case 'FindFirstChild':
        return [mkM(a=>{
          const needsRecurse=a[2]===true;
          const found=childByName(inst, a[1]);
          if (found) return [wrap(found)];
          if (needsRecurse){
            for (const d of iterDesc(inst)){
              if (d.props.Name===String(a[1])) return [wrap(d)];
            }
          }
          return [undefined];
        })];
      case 'getChildren': case 'GetChildren': case 'getChildren2': case 'GetChildren2':
      case 'children': case 'Children':
        return [mkM(()=>luaArray(inst.children.map(c=>wrap(c))))];
      case 'IsA': case 'isA':
        return [mkM(a=>{
          const wanted=String(a[1]);
          if (wanted===cls) return [true];
          if (wanted==='BasePart'&&PART_CLASSES.has(cls)) return [true];
          return [false];
        })];
      case 'service': case 'getService': case 'GetService': case 'FindService':
        return [mkM(a=>{
          const c=findService(a[1]);
          return [c? wrap(c) : undefined];
        })];
      case 'clone': case 'Clone':
        return [mkM(()=>[doClone(inst)])];
      case 'remove': case 'Remove':
        return [mkM(()=>{ doRemove(inst); return []; })];
      case 'makeJoints': case 'MakeJoints':
        return [mkM(()=>{ /* the engine's part:makeJoints(): contact-weld this
                            part into the assemblies it touches.  Model:MakeJoints
                            applies to every descendant part, but each connected
                            component is flooded ONCE.  Calling makeJoints per
                            part re-flooded and re-welded the whole map N times
                            (the regen scripts restore 465-part models, which
                            froze the frame after the clone reappeared). */
          if (!window.RBLXdyn) return [];
          if (PART_CLASSES.has(inst.cls)||PART_CLASSES.has(cls)){
            window.RBLXdyn.makeJoints(inst);
          } else {
            const seen=new Set();
            for (const it of walkAll(inst))
              if (PART_CLASSES.has(it.cls)) window.RBLXdyn.makeJoints(it, seen);
          }
          return []; })];
      case 'Touched': {
        const s=touchedSignal(inst);
        return [wrapSignal(s, 'Touched')];
      }
      case 'Died': {
        if (cls==='Humanoid'||inst.__fakeHumanoid){
          const s=touchedSignal(inst, 'Died');
          return [wrapSignal(s, 'Died')];
        }
        return [undefined];
      }
      case 'disconnect': case 'Disconnect':   /* on a connection object */
        return [mkM(()=>{ if (w.__sigEntry){ w.__sigEntry.active=false; } return []; })];
      case 'wait':
        if (cls==='Sound') return [mkM(()=>[])];   /* Sound:wait(): no-op */
        break;
      case 'play': case 'Play':
        return [mkM(()=>{ soundPlay(inst); return []; })];
      case 'stop': case 'Stop': case 'pause': case 'Pause':
        return [mkM(()=>{ soundStop(inst); return []; })];
      case 'TakeDamage':
        return [mkM(a=>{
          const c=(inst.__fakeHumanoid&&inst.__charObj)||char();
          if (c && cls==='Humanoid') c.takeDamage(a[1]||0);
          return [];
        })];
      case 'Value':
        /* NumberValue/IntValue/BoolValue/StringValue/ObjectValue etc. */
        if (/Value$/.test(cls)) return [propToLua(inst.props.Value)];
        break;
    }
    /* class-specific live props */
    if (PART_CLASSES.has(cls)||PART_CLASSES.has(inst.cls)){
      switch (key){
        case 'Position': { const p=liveCF(inst).pos; return [V3(p.x, p.y, p.z)]; }
        case 'CFrame': { const cf=liveCF(inst); return [CF(cf.pos, cf.rot)]; }
        case 'Velocity': {
          const look=viewLook(inst);
          if (look && look.velocity) return [V3(look.velocity.x, look.velocity.y, look.velocity.z)];
          return [inst.props.Velocity? V3(inst.props.Velocity.x,inst.props.Velocity.y,inst.props.Velocity.z) : V3(0,0,0)];
        }
        case 'Size': case 'size': {
          const look=viewLook(inst);
          if (look) return [V3(look.size.x, look.size.y, look.size.z)];
          const s=inst.props.size||{x:4,y:1.2,z:2};
          return [V3(s.x, s.y, s.z)];
        }
        case 'Shape': case 'shape':
          return [inst.props.shape!=null? inst.props.shape : 1];
        case 'FormFactor': case 'formFactor': {
          const look=viewLook(inst);
          if (look&&look.formFactor!=null) return [look.formFactor];
          return [inst.props.FormFactor!=null? inst.props.FormFactor
                  : (inst.props.formFactorRaw!=null? inst.props.formFactorRaw : 1)];
        }
        case 'Transparency': {
          const look=viewLook(inst);
          if (look) {
            const t=inst.props.Transparency!==undefined? inst.props.Transparency : 0;
            return [t];
          }
          break;
        }
        case 'Reflectance': {
          const look=viewLook(inst);
          return [look&&look.reflectance!=null? look.reflectance
                  : (inst.props.Reflectance!=null? inst.props.Reflectance : 0)];
        }
        case 'Elasticity': {
          const look=viewLook(inst);
          return [look&&look.elasticity!=null? look.elasticity
                  : (inst.props.Elasticity!=null? inst.props.Elasticity : 0.5)];
        }
        case 'Friction': {
          const look=viewLook(inst);
          return [look&&look.friction!=null? look.friction
                  : (inst.props.Friction!=null? inst.props.Friction : 0.3)];
        }
        case 'CastsShadows': return [inst.props.CastsShadows!==false];
        case 'Cullable': return [inst.props.Cullable!==false];
        case 'Locked': return [inst.props.Locked===true];
        case 'DraggingV1': return [inst.props.DraggingV1===true];
        case 'Controller': return [inst.props.Controller!=null? inst.props.Controller : 0];
        case 'ControllerFlagShown': return [inst.props.ControllerFlagShown!==false];
        case 'archivable': case 'Archivable': return [inst.props.archivable!==false];
        case 'RotVelocity': {
          const look=viewLook(inst);
          const rv=(look&&look.rotVelocity)||inst.props.RotVelocity||{x:0,y:0,z:0};
          return [V3(rv.x,rv.y,rv.z)];
        }
        case 'BrickColor': {
          const e=viewLook(inst);
          const bcid=e&&e.entry? e.entry.id : (inst.props.BrickColor!=null? inst.props.BrickColor : 2);
          const g=window.BrickColorFromId(bcid);
          const b=BrickColor(bcid);
          return [b];
        }
        case 'TeamColor': {
          if (inst.cls==='SpawnLocation')
            return [BrickColor(inst.props.TeamColor!=null? (Number(inst.props.TeamColor)|0) : 194)];
          break;
        }
        case 'Color': {
          const look=viewLook(inst);
          if (look && look.entry) {
            const e=look.entry;
            return [Color3(e.rgb[0]/255, e.rgb[1]/255, e.rgb[2]/255)];
          }
          break;
        }
        case 'Anchored': return [inst.props.Anchored!==false];
      }
    }
    if (cls==='Message'||cls==='Hint'){
      switch (key){
        case 'Text': return [inst.props.Text||''];
      }
    }
    if (cls==='Lighting'||inst.__fakeLighting){
      switch (key){
        case 'GetMinutesAfterMidnight': case 'getMinutesAfterMidnight':
          return [mkM(()=>[timeOfDayMinutes()])];
        case 'SetMinutesAfterMidnight': case 'setMinutesAfterMidnight':
          return [mkM(a=>{
            const mins=Number(a[1])||0;
            state.dayMinutes=mins;
            inst.props.TimeOfDay=formatTimeOfDay(mins);
            applyTimeOfDay(mins);
            return [];
          })];
        case 'TopAmbient': case 'BottomAmbient': case 'BrightColor':
          return [undefined];
      }
    }
    if (cls==='Script'){
      if (key==='Source') return [inst.props.Source||''];
      if (key==='Disabled') return [inst.props.Disabled===true];
      if (key==='Parent') return [inst.parent? wrap(inst.parent) : undefined];
    }
    if (cls==='Sound'){
      if (key==='SoundId'||key==='soundId'){
        const s=inst.props.SoundId;
        if (typeof s==='string') return [s];
        if (s && s.text!==undefined) return [s.text];
        if (s && s.url!==undefined) return [s.url];
        if (s && s.binary!==undefined) return [s.binary];
        return [''];
      }
      if (key==='PlayOnRemove'||key==='playOnRemove') return [inst.props.PlayOnRemove===true];
    }
    if (cls==='ShirtGraphic'||cls==='Shirt'){
      /* decomp ShirtGraphic.TextureId (Content) / Shirt.BrickColor */
      if (key==='TextureId'||key==='textureId'){
        const t=inst.props.TextureId;
        return [(t&&typeof t==='object')? (t.url||t.binary||'') : String(t||'')];
      }
    }
    if (cls==='RunService'||inst.__fakeRunService){
      if (!state.signals2) state.signals2={stepped:new Signal('Stepped')};
      if (key==='Stepped') return [wrapSignal(state.signals2.stepped, 'Stepped')];
      if (key==='RenderStepped') return [wrapSignal(state.signals2.stepped, 'RenderStepped')];
    }
    if (cls==='Explosion'&&(key==='Hit'||key==='hit')){
      /* Explosion.Hit(part, distance)  fired by FUN_00604150 */
      return [wrapSignal(touchedSignal(inst, key), key)];
    }
    if (cls==='Tool'||cls==='HopperBin'){
      const ev=(cls==='Tool')
        ? ['Equipped','Unequipped','Activated','Deactivated','KeyDown','KeyUp']
        : ['Selected','Deselected','Button1Down','Button1Up','KeyDown','KeyUp'];
      if (ev.indexOf(key)>=0) return [wrapSignal(touchedSignal(inst, key), key)];
    }
    if (inst.__player){
      if (key==='Character') return [inst.__charModel ? wrap(inst.__charModel) : (state.modelInst? wrap(state.modelInst) : undefined)];
      if (key==='Backpack'){
        const bp=childByName(inst,'Backpack') ||
                 (inst===state.playerInst? state.backpackInst : null);
        return [bp? wrap(bp) : undefined];
      }
      if (key==='PlayerGui') return [wrap(childByName(inst,'PlayerGui')||inst)];
      if (key==='Team'){
        if (inst.__playerNet)
          return [inst.__teamColor!=null
            ? wrap(teamInstances().find(t=>teamColorId(t)===inst.__teamColor)||null)
            : undefined];
        return [state.playerTeam? wrap(state.playerTeam) : undefined];
      }
      if (key==='TeamColor'){
        if (inst.__playerNet)
          return [BrickColor(inst.__teamColor!=null? inst.__teamColor : 194)];
        return [BrickColor(state.playerTeamColor!=null? state.playerTeamColor : 194)];
      }
      if (key==='Neutral')
        return [inst.__playerNet? inst.__teamColor==null : !state.playerTeam];
    }
    if (cls==='Model'||inst.__character){
      if (key==='PrimaryPart'){
        let p=inst.props.PrimaryPart;
        if (p&&p.cls) return [wrap(p)];
        if (inst.__character&&state.torsoInst) return [wrap(state.torsoInst)];
        p=inst.children.find(c=>PART_CLASSES.has(c.cls));
        return [p? wrap(p) : undefined];
      }
    }
    if (cls==='Team'){
      if (key==='TeamColor') return [BrickColor(teamColorId(inst))];
      if (key==='AutoAssignable'||key==='AutoAssign') return [inst.props.AutoAssignable!==false];
      if (key==='Score') return [Number(inst.props.Score)||0];
      if (key==='GetPlayers')
        return [mkM(()=>[luaArray(state.playerTeam===inst&&state.playerInst? [wrap(state.playerInst)] : [])])];
      if (key==='PlayerAdded'||key==='PlayerRemoved')
        return [wrapSignal(touchedSignal(inst, key), key)];
      if (key==='GetTeamColor') return [mkM(()=>[BrickColor(teamColorId(inst))])];
    }
    if (cls==='Teams' && key==='GetTeams')
      return [mkM(()=>[luaArray(teamInstances().map(wrap))])];
    if (cls==='Debris'){
      if (key==='MaxItems') return [Number(inst.props.MaxItems)||1000];
      if (key==='AddItem'||key==='addItem')
        return [mkM(a=>{
          const it=refInst(a[1]);
          if (!it) return [];
          const delay=Math.max(0, Number(a[2])||0);
          state.debris.push({inst:it, t:delay});
          const cap=Number(inst.props.MaxItems)||1000;
          while (state.debris.length>cap){
            const old=state.debris.shift();
            if (old&&old.inst) reparent(old.inst, null);
          }
          return [];
        })];
    }
    /* Service methods the 2007 client exposed but a single-player port
     * cannot fulfil.  They stay callable (scripts do not error) and report
     * the honest single-player result. */
    if (cls==='BadgeService'){
      if (key==='UserHasBadge'||key==='userHasBadge'||key==='UserHasBadgeAsync')
        return [mkM(()=>[false])];
      if (key==='AwardBadge'||key==='awardBadge')
        return [mkM(()=>[false])];
      if (key==='GetBadgeInfoAsync') return [mkM(()=>[undefined])];
    }
    if (cls==='TeleportService'){
      if (key==='Teleport'||key==='teleport'||key==='TeleportToPlaceInstance'||
          key==='TeleportAsync')
        return [mkM(()=>[])];         /* no remote server to join */
    }
    if (cls==='ChangeHistoryService'){
      if (key==='SetWaypoint'||key==='Undo'||key==='Redo')
        return [mkM(()=>[])];
    }
    if (cls==='CollectionService'){
      const tagsOf=it=>it.__tags||(it.__tags=new Set());
      if (key==='AddTag') return [mkM(a=>{ const it=refInst(a[1]); if (it) tagsOf(it).add(String(a[2])); return []; })];
      if (key==='RemoveTag') return [mkM(a=>{ const it=refInst(a[1]); if (it) tagsOf(it).delete(String(a[2])); return []; })];
      if (key==='HasTag') return [mkM(a=>{ const it=refInst(a[1]); return [!!it&&tagsOf(it).has(String(a[2]))]; })];
      if (key==='GetTags') return [mkM(a=>{ const it=refInst(a[1]); return [it? luaArray(Array.from(tagsOf(it))) : luaArray([])]; })];
      if (key==='GetTagged') return [mkM(a=>{
        const tag=String(a[1]), out=[];
        if (state.gameInst)
          for (const it of walkAll(state.gameInst)) if (tagsOf(it).has(tag)) out.push(wrap(it));
        return [luaArray(out)];
      })];
    }
    if (cls==='Players'&&(inst===state.playersInst||inst===state.playerInst)){
      if (key==='Character') return [inst.__charModel ? wrap(inst.__charModel) : (state.modelInst? wrap(state.modelInst) : undefined)];
      if (key==='ChildAdded'||key==='ChildRemoved'||key==='Changed')
        return [wrapSignal(touchedSignal(inst, key), key)];
      if (key==='LocalPlayer'&&inst===state.playersInst) return [wrap(state.playerInst)];
    }
    if (key==='ChildAdded'||key==='ChildRemoved'||key==='Changed'){
      /* generic per-instance property signals (classic: connect-only usage) */
      return [wrapSignal(touchedSignal(inst, key), key)];
    }
    if (cls==='Players'){
      if (key==='LocalPlayer') return [state.playerInst? wrap(state.playerInst) : undefined];
      if (key==='PlayerAdded'||key==='playerAdded'||key==='PlayerRemoved'||key==='playerRemoved')
        return [wrapSignal(touchedSignal(inst, key), key)];
      /* Players.NumPlayers  the harvester's pickPlayer() gates on it */
      if (key==='NumPlayers'||key==='numPlayers'){
        let n=0;
        for (const c of inst.children) if (c.cls==='Player'||c.__player) n++;
        return [n];
      }
    }
    if (cls==='Workspace'||cls==='GameObject'||cls==='Model'){
      /* fallthrough to child-name reads below */
    }
    /* Tool grip: Grip is canonical; the four vectors are its views */
    if (inst.cls==='Tool' && (key==='Grip'||key==='GripPos'||key==='GripRight'||key==='GripUp'||key==='GripForward')){
      const g=toolGripCF(inst);
      if (key==='Grip') return [propToLua(g)];
      return [propToLua(toolGripVectors(g)[key])];
    }
    /* child-name access: game.Workspace.LostTemple  chained dotted reads */
    {
      const c=childByName(inst, key);
      if (c) return [wrap(c)];
    }
    /* raw parsed props under their declared names (deserialized) */
    if (inst.props && inst.props[key]!==undefined){
      const pv=inst.props[key];
      return [propToLua(pv)];
    }
    if (inst.props && inst.props['@'+key]!==undefined) return [inst.props['@'+key]];
    /* tools/gear-ish: Texture/tool instruction sets */
    return [undefined];
  },
  __newindex(args){
    const w=args[0], key=String(args[1]), v=args[2];
    const inst=w.__rinst;
    if (inst.__fakeHumanoid){
      if (key==='Health'){
        const c=charOf(inst);
        if (c){
          c.health=v;
          if (v<=0 && c.alive) c.die();
        }
        return;
      }
      if (key==='MaxHealth'){ const c=charOf(inst); if (c) c.maxHealth=v; return; }
      if (key==='WalkSpeed'){ const c=charOf(inst); if (c) c.walkSpeed=v; return; }
      if (key==='JumpPower'){ const c=charOf(inst); if (c) c.jumpVelocity=v; return; }
    }
    if (inst.__fakeTorso){
      const c=charOf(inst), nm=inst.__charPart||inst.props.Name||'Torso';
      if (key==='Velocity'){
        if (c && v && v.pv){
          c.velocity.set(v.pv[0], v.pv[1], v.pv[2]);   /* the literal Torso.Velocity= port */
          return;
        }
      }
      if (key==='CFrame'||key==='Position'){
        const p=key==='CFrame'? (v&&v.pos) : (v&&v.pv? {x:v.pv[0],y:v.pv[1],z:v.pv[2]} : null);
        if (p&&c&&c.movePartTo) c.movePartTo(nm, p);
        return;
      }
      if (key==='Transparency'){
        if (c&&c.setPartTransparency) c.setPartTransparency(nm, Number(v)||0);
        inst.props.Transparency=Number(v)||0;
        return;
      }
      if (key==='BrickColor'||key==='Color'){
        const cl=(v&&v.cl)? v.cl : null;
        if (cl&&c&&c.setPartColor) c.setPartColor(nm, cl);
        if (key==='BrickColor'){
          const rgb=cl? [Math.round(cl[0]*255),Math.round(cl[1]*255),Math.round(cl[2]*255)] : null;
          inst.props.BrickColor=rgb? matchBrickColorId(rgb) : (v|0);
        }
        return;
      }
      if (key==='Size'||key==='Anchored'||key==='CanCollide') return;
    }
    if (inst.__motor){
      const M=char()&&char().Motors? char().Motors[inst.__motor] : null;
      if (M){
        if (key==='MaxVelocity'){ M.MaxVelocity=Number(v)||0; return; }
        if (key==='DesiredAngle'){ M.DesiredAngle=Number(v)||0; return; }
        if (key==='CurrentAngle'){ M.CurrentAngle=Number(v)||0; return; }
      }
    }
    /* SurfaceType family: update the live part surface array, rebuild the
     * face art, and let the next ClumpStage re-evaluate auto-joints. */
    {
      const sp=surfaceProp(key);
      if (sp && PART_CLASSES.has(inst.cls)){
        if (sp.kind==='Surface'){
          const tok=surfaceToken(v);
          inst.props[key]=tok;
          const look=viewLook(inst);
          if (look&&look.surf){ look.surf[sp.face]=tok; delete look.__faces; }
          refreshPartVisual(inst);
          markJointDirty();
        } else if (sp.kind==='SurfaceInput'){
          inst.props[key]=Math.max(0, Math.floor(Number(v)||0));
        } else {
          const d=(sp.kind==='ParamA')? -0.5 : 0.5;
          const fv=Number(v);
          inst.props[key]=isFinite(fv)? fv : d;
          refreshPartVisual(inst);
        }
        return;
      }
    }
    /* Lighting property writes re-apply the whole lighting model live
     * (decomp: the setters mark the G3D render device lighting-dirty
     * same effect, next frame sees the new lights) */
    if (inst.cls==='Lighting'||inst.__fakeLighting){
      const LIVE=['TimeOfDay','Brightness','TopAmbientV9','BottomAmbientV9','SpotLightV9','ClearColor','CelestialBodiesShown'];
      if (LIVE.indexOf(key)>=0){
        inst.props[key]=v;
        if (key==='TimeOfDay'){
          const mins=parseTimeOfDay(v);
          if (mins!=null) state.dayMinutes=mins;
        }
        if (state.world&&state.world.applyLightingProps) state.world.applyLightingProps(inst.props);
        return;
      }
    }
    /* Tool grip writes: Grip is the canonical CFrame; writing a vector
     * rewrites that view of the CFrame (the four decomp setters do the
     * same).  Done before the generic switch so the views stay in sync. */
    if (inst.cls==='Tool' && (key==='Grip'||key==='GripPos'||key==='GripRight'||key==='GripUp'||key==='GripForward')){
      const g=toolGripCF(inst);
      if (key==='Grip' && v && v.pos && v.rot){
        setToolGrip(inst, {pos:{x:v.pos.x||0,y:v.pos.y||0,z:v.pos.z||0},
                           rot:v.rot.slice(0,9)});
        return;
      }
      const sv=vec3Read(v);
      if (!sv) return;
      const r=g.rot;
      if (key==='GripPos'){ g.pos={x:sv.x,y:sv.y,z:sv.z}; }
      else if (key==='GripRight'){ r[0]=sv.x; r[3]=sv.y; r[6]=sv.z; }
      else if (key==='GripUp'){ r[1]=sv.x; r[4]=sv.y; r[7]=sv.z; }
      else { r[2]=-sv.x; r[5]=-sv.y; r[8]=-sv.z; }
      setToolGrip(inst, g);
      return;
    }
    switch (key){
      case 'Parent': {
        const newParent=v? unwrap(v) : null;
        reparent(inst, newParent);
        return;
      }
      case 'Name': {
        const old=String(inst.props.Name||'');
        inst.props.Name=String(v);
        renameInWorld(inst, old, inst.props.Name);
        return;
      }
      case 'Value': {
        inst.props.Value=v;
        return;
      }
      case 'Text': {
        inst.props.Text=String(v);
        /* A detached Message is only being configured.  Classic Messages
         * display when parented to the DataModel, not when their Text is
         * written (the regen scripts build one before their first wait;
         * showing it there put "Regenerating ..." on screen for minutes). */
        if (inst.cls==='Message'&&withinWorld(inst)) messageShow(inst);
        else if (inst.cls==='Hint'&&withinWorld(inst)) hintShow(inst);
        return;
      }
      case 'Position': {
        if (PART_CLASSES.has(inst.cls)){
          const cf=liveCF(inst);
          if (v&&v.pv) moveScriptPart(inst, { pos:{x:v.pv[0],y:v.pv[1],z:v.pv[2]}, rot:cf.rot });
          return;
        }
        inst.props[key]=v; return;
      }
      case 'CFrame': {
        if (PART_CLASSES.has(inst.cls)){
          if (v&&v.pos) moveScriptPart(inst, { pos:v.pos, rot:v.rot });
          return;
        }
        inst.props[key]={pos:v&&v.pos, rot:v&&v.rot}; return;
      }
      case 'Size': case 'size': {
        if (PART_CLASSES.has(inst.cls)){
          const s=vec3Read(v);
          if (s) updatePartExtent(inst, s, null);
          return;
        }
        inst.props[key]=v; return;
      }
      case 'Shape': case 'shape': {
        if (PART_CLASSES.has(inst.cls)){
          const sh=Number(v);
          updatePartExtent(inst, null, isFinite(sh)? sh : 1);
          return;
        }
        inst.props[key]=v; return;
      }
      case 'FormFactor': case 'formFactor': case 'formFactorRaw': {
        if (PART_CLASSES.has(inst.cls)){
          const ff=Number(v);
          inst.props.FormFactor=isFinite(ff)? ff : 1;
          inst.props.formFactorRaw=inst.props.FormFactor;
          const look=viewLook(inst);
          if (look) look.formFactor=inst.props.FormFactor;
          return;
        }
        inst.props[key]=v; return;
      }
      case 'Reflectance': {
        if (PART_CLASSES.has(inst.cls)){
          const rv=Math.max(0, Math.min(1, Number(v)||0));
          if (Math.abs((Number(inst.props.Reflectance)||0)-rv)<1e-6) return;
          inst.props.Reflectance=rv;
          const look=viewLook(inst);
          if (look) look.reflectance=rv;
          refreshPartVisual(inst);         /* switches Lambert <-> Phong */
          if (look) staticDirty(look);
          return;
        }
        inst.props[key]=v; return;
      }
      case 'Elasticity': {
        if (PART_CLASSES.has(inst.cls)){
          const ev=Math.max(0, Math.min(1, Number(v)||0));
          inst.props.Elasticity=ev;
          const look=viewLook(inst);
          if (look) look.elasticity=ev;
          return;
        }
        inst.props[key]=v; return;
      }
      case 'Friction': {
        if (PART_CLASSES.has(inst.cls)){
          const fv=Number(v);
          inst.props.Friction=isFinite(fv)? Math.max(0, fv) : 0.3;
          const look=viewLook(inst);
          if (look) look.friction=inst.props.Friction;
          return;
        }
        inst.props[key]=v; return;
      }
      case 'CastsShadows': {
        if (PART_CLASSES.has(inst.cls)){
          inst.props.CastsShadows=!!v;
          const look=viewLook(inst);
          if (look){
            look.castsShadows=!!v;
            if (look.obj) look.obj.castShadow=!!v;
          }
          return;
        }
        inst.props[key]=v; return;
      }
      case 'Cullable': {
        if (PART_CLASSES.has(inst.cls)){
          inst.props.Cullable=!!v;
          const look=viewLook(inst);
          if (look){
            look.cullable=!!v;
            if (look.obj) look.obj.frustumCulled=!!v;
            staticDirty(look);             /* batch eligibility changed */
          }
          return;
        }
        inst.props[key]=v; return;
      }
      case 'Locked': case 'DraggingV1': case 'ControllerFlagShown': {
        if (PART_CLASSES.has(inst.cls)){
          inst.props[key]=!!v;
          const look=viewLook(inst);
          if (look){
            if (key==='Locked') look.locked=!!v;
            else if (key==='DraggingV1') look.draggingV1=!!v;
            else look.controllerFlagShown=!!v;
          }
          if (key==='ControllerFlagShown'&&state.world&&state.world.refreshControllerFlag)
            state.world.refreshControllerFlag(inst);
          return;
        }
        inst.props[key]=v;
        if (key==='ControllerFlagShown'&&inst.cls==='Model'&&state.world&&
            state.world.refreshModelControllerFlag)
          state.world.refreshModelControllerFlag(inst);
        return;
      }
      case 'Controller': {
        if (PART_CLASSES.has(inst.cls)){
          const c=Number(v);
          inst.props.Controller=isFinite(c)? (c|0) : 0;
          const look=viewLook(inst);
          if (look) look.controller=inst.props.Controller;
          if (state.world&&state.world.refreshControllerFlag)
            state.world.refreshControllerFlag(inst);
          return;
        }
        if (inst.cls==='Model'){
          const c=Number(v);
          inst.props.Controller=isFinite(c)? (c|0) : 0;
          if (state.world&&state.world.refreshModelControllerFlag)
            state.world.refreshModelControllerFlag(inst);
          return;
        }
        inst.props[key]=v; return;
      }
      case 'archivable': case 'Archivable': {
        inst.props.archivable=!!v;
        const look=viewLook(inst);
        if (look) look.archivable=!!v;
        return;
      }
      case 'RotVelocity': {
        if (PART_CLASSES.has(inst.cls)){
          const rv={x:0,y:0,z:0};
          if (v&&v.pv){ rv.x=v.pv[0]; rv.y=v.pv[1]; rv.z=v.pv[2]; }
          inst.props.RotVelocity=rv;
          const look=viewLook(inst);
          if (look){
            look.rotVelocity=rv;
            if (rv.x||rv.y||rv.z) moverRegister(inst, look.velocity||{x:0,y:0,z:0});
          }
          return;
        }
        inst.props[key]=v; return;
      }
      case 'Velocity': {
        if (inst.__fakeTorso) break;   /* handled above */
        if (PART_CLASSES.has(inst.cls)){
          const nv={x:0,y:0,z:0};
          if (v&&v.pv){ nv.x=v.pv[0]; nv.y=v.pv[1]; nv.z=v.pv[2]; }
          inst.props.Velocity=nv;
          moverRegister(inst, nv);
          return;
        }
        inst.props[key]=v; return;
      }
      case 'Color': case 'BrickColor': {
        if (PART_CLASSES.has(inst.cls)){
          const cl=(v&&(v.cl||v.pv))? (v.cl) : null;
          if (cl){
            const rgb=[Math.round(cl[0]*255), Math.round(cl[1]*255), Math.round(cl[2]*255)];
            inst.props.BrickColor=matchBrickColorId(rgb);
            recolorPart(inst, cl);
            return;
          }
          if (typeof v==='number'){
            inst.props.BrickColor=v|0;
            const e=window.BrickColorFromId(v|0);
            if (e) recolorPart(inst, [e.rgb[0]/255, e.rgb[1]/255, e.rgb[2]/255]);
            return;
          }
        }
        inst.props[key]=v; return;
      }
      case 'Transparency': {
        inst.props.Transparency=v;
        if (PART_CLASSES.has(inst.cls)){
          const look=viewLook(inst);
          if (look&&look.obj){
            const mats=ownLookMaterials(look);
            for (const m of mats){ if (m){
              m.transparent=(v>0.001);
              m.opacity=1-v;
              m.needsUpdate=true;
            } }
            look.obj.visible=v<0.95;
          }
          if (look) staticDirty(look);
        }
        netMark(inst);
        return;
      }
      case 'Anchored': {
        inst.props.Anchored=!!v;
        const look=viewLook(inst);
        if (look){
          look.anchored=!!v;
          if (window.RBLXdyn) window.RBLXdyn.setAnchored(look, !!v);
          if (state.world&&state.world.refreshControllerFlag)
            state.world.refreshControllerFlag(inst);
          if (!v) moverRegister(inst, look.velocity||{x:0,y:0,z:0});
        }
        netMark(inst);
        return;
      }
      case 'CanCollide': {
        inst.props.CanCollide=!!v;
        const look=viewLook(inst);
        if (look){
          look.canCollide=!!v;
          const i=state.world.colliders.indexOf(look);
          if (!v && i>=0) state.world.colliders.splice(i,1);
          else if (v && i<0 && look.aabb) state.world.colliders.push(look);
        }
        netMark(inst);
        return;
      }
      case 'PlayOnRemove': {
        inst.props.PlayOnRemove=!!v;
        return;
      }
      case 'TextureId': {
        if (inst.cls==='ShirtGraphic'||inst.cls==='Shirt'){
          inst.props.TextureId=(v&&typeof v==='object')? (v.url||v.binary||'') : String(v==null?'':v);
          syncShirts();
        }
        return;
      }
    }
    /* authored joints: Part0/Part1 are object refs, C0/C1 CFrames */
    if (JOINT_CLASSES.has(inst.cls)){
      if (key==='Part0'||key==='Part1'){
        inst.props[key]=refInst(v);
        syncJointInst(inst, true);
        return;
      }
      if (key==='C0'||key==='C1'){
        inst.props[key]=cfRec(v);
        syncJointInst(inst, true);
        return;
      }
      if (inst.cls==='Motor' && (key==='MaxVelocity'||key==='DesiredAngle'||key==='CurrentAngle')){
        inst.props[key]=Number(v)||0;
        return;
      }
    }
    /* team objects and the local player's team state */
    if (inst.cls==='Team'){
      if (key==='TeamColor'){ inst.props.TeamColor=brickColorIdOf(v)||194; autoAssignTeams(); return; }
      if (key==='AutoAssignable'||key==='AutoAssign'){ inst.props.AutoAssignable=!!v; autoAssignTeams(); return; }
      if (key==='Score'){ inst.props.Score=Number(v)||0; return; }
    }
    if (inst.__player||inst.cls==='Player'){
      if (key==='Team'){
        const t=refInst(v);
        setPlayerTeam(isTeamInst(t)? t : null);
        return;
      }
      if (key==='TeamColor'){ setPlayerTeamColor(brickColorIdOf(v)); return; }
      if (key==='Neutral'){
        if (v) setPlayerTeam(null); else autoAssignTeams();
        return;
      }
    }
    if (inst.cls==='SpawnLocation' && key==='TeamColor'){
      inst.props.TeamColor=brickColorIdOf(v)||194;
      return;
    }
    /* default: stash into props (generic state) */
    inst.props[key]=v;
  },
};

/* ================================================================
 * tree + world operations
 * ============================================================== */
function sName(inst){ return String((inst&&inst.props)&&inst.props.Name!==undefined? inst.props.Name : (inst&&inst.cls)||''); }

/* runtime rename (Instance.Name=): lookups scan the tree on demand
 * (childByName/findFirstChild), so nothing else is name-keyed here
 * just clear the part's touch-edge flags so a relabeled part can't leak
 * a stale Touched enter edge into its next handler */
function renameInWorld(inst, old, name){
  void old; void name;
  if (inst&&isPartLike(inst)){ inst.__touchIn=false; inst.__tc_char=false; }
}

function mkInst(cls, name){
  const inst={ cls:String(cls), ref:null, props:{}, children:[], parent:null };
  if (name!=null) inst.props.Name=String(name);
  return inst;
}

/* root + descendants in exact tree order.  A child whose parent points at a
 * different node (the fake Humanoid's limb aliases) is not traversed again:
 * the limb already lives under the character Model. */
function walkAll(inst){
  const a=[inst];
  (function rec(x){
    for (const c of x.children){
      if (c.parent!==x) continue;
      a.push(c); rec(c);
    }
  })(inst);
  return a;
}
/* descendants only (no root), same parent-identity guard */
function* iterDesc(inst){
  for (const c of inst.children){
    if (c.parent!==inst) continue;
    yield c; yield* iterDesc(c);
  }
}

function viewLook(inst){
  const w=state.world;
  return (w&&w.partLook)? w.partLook.get(inst) : null;
}
function isPartLike(it){
  return it && PART_CLASSES.has(String(it.cls));
}

/* ---------- cloning (classic :clone()  detached copy) ----------
 * Object references (Model.PrimaryPart, ObjectValue.Value, Weld.Part1...)
 * must point into the clone, not back at the source subtree. */
function cloneSubtree(inst){
  const map=new Map();
  function build(src){
    const n=mkInst(src.cls, src.props.Name);
    map.set(src,n);
    for (const k of Object.keys(src.props)){
      if (k==='Name') continue;                     /* mkInst got it */
      const v=src.props[k];
      if (v&&typeof v==='object'&&v.cls&&v.props!==undefined) continue; /* ref: remap below */
      if (v&&typeof v==='object'&&v.__rinst) continue;                  /* lua wrapper ref */
      if (v&&typeof v==='object'&&v.pv)
        n.props[k]={pv:v.pv.slice()};                   /* bridge Vector3 value */
      else if (v&&typeof v==='object'&&v.cl)
        n.props[k]={cl:v.cl.slice()};                   /* bridge Color3 value */
      else if (v&&typeof v==='object'&&v.bid!==undefined)
        n.props[k]=v;                                   /* BrickColor (immutable) */
      else if (v&&typeof v==='object'&&v.x!==undefined&&v.y!==undefined&&v.z!==undefined)
        n.props[k]={x:v.x,y:v.y,z:v.z};               /* size/velocity vectors */
      else if (v&&typeof v==='object'&&v.pos!==undefined&&v.rot!==undefined)
        n.props[k]={pos:{x:v.pos.x,y:v.pos.y,z:v.pos.z}, rot:v.rot.slice()};
      else if (Array.isArray(v)) n.props[k]=v.slice();
      else n.props[k]=v;
    }
    for (const c of src.children){
      const cc=build(c); cc.parent=n; n.children.push(cc);
    }
    return n;
  }
  const root=build(inst);
  for (const [src,n] of map){
    for (const k of Object.keys(src.props)){
      const v=src.props[k];
      if (v&&typeof v==='object'&&v.cls&&v.props!==undefined)
        n.props[k]=map.get(v)||v;
      else if (v&&typeof v==='object'&&v.__rinst)
        n.props[k]=map.get(v.__rinst)||v;
    }
  }
  return root;
}
function doClone(inst){
  const cp=cloneSubtree(inst);
  cp.parent=null;                                    /* detached until Parent= */
  return wrap(cp);
}

/* ---------- remove / detach ---------- */
function doRemove(inst){ reparent(inst, null); }

function killScript(inst){
  for (const e of state.scriptFibers){
    if (e.inst===inst&&e.fiber&&e.fiber.state!=='dead') e.fiber.state='dead';
  }
  if (inst.__env){
    disconnectEnv(inst.__env);
    inst.__env=null;
  }
  inst.__launched=false;
}

/* inside the live world? */
function withinWorld(inst){
  let p=inst;
  while (p){ if (p===state.workspaceInst) return true; p=p.parent; }
  return false;
}

function buildOrRestore(inst){
  const w=state.world;
  if (!w||!isPartLike(inst)) return;
  const look=w.partLook&&w.partLook.get(inst);
  if (look&&look.destroyed){
    if (w.restorePart) w.restorePart(inst);
    return;
  }
  if (!look&&w.buildPart){
    const l=w.buildPart(inst);
    /* A script-created part often sets Velocity before parenting it; the
     * engine registers the mover as soon as it enters the world. */
    if (l&&l.velocity&&(l.velocity.x||l.velocity.y||l.velocity.z)){
      l.scriptMover=true;
      state.movers.add(l);
    }
  }
}

/* BodyVelocity/BodyPosition parented under the character (PrimaryPart,
 * Torso, Humanoid or Model) apply to the humanoid body, not a part mover. */
function isUnderCharacter(inst){
  let p=inst&&inst.parent;
  while (p){
    if (p===state.modelInst||p===state.torsoInst||p===state.humanInst) return true;
    p=p.parent;
  }
  return false;
}
function syncCharacterMover(inst){
  if (!inst) return;
  if (inst.cls==='BodyVelocity'||inst.cls==='BodyPosition'||inst.cls==='BodyForce'||inst.cls==='BodyGyro'){
    if (isUnderCharacter(inst)) state.characterMovers.add(inst);
    else state.characterMovers.delete(inst);
  }
  for (const c of inst.children) syncCharacterMover(c);
  if (inst.cls==='ShirtGraphic'||inst.cls==='Shirt') syncShirts();
}

/* ShirtGraphic/Shirt under the character model drive the torso T-shirt
 * (decomp RBX::ShirtGraphic : CharacterAppearance, TextureId).  The most
 * recently parented active shirt wins; none → the start-page shirt or the
 * default torso decal. */
function shirtUrlOf(t){
  if (t==null) return null;
  if (typeof t==='string') return t;
  if (typeof t==='object') return t.url||t.binary||null;
  return null;
}
function syncShirts(){
  const ch=char();
  if (!ch||!ch.applyTshirt) return;
  let url=null;
  if (state.modelInst){
    for (const c of state.modelInst.children){
      if ((c.cls==='ShirtGraphic'||c.cls==='Shirt') && c.props.Disabled!==true)
        url=shirtUrlOf(c.props.TextureId) || url;
    }
  }
  if (url==null) url=(window.RBLXplayer&&window.RBLXplayer.tshirt)||null;
  ch.applyTshirt(url);
}

/* parented into the workspace subtree  bring it (and children) to life.
 * Parts first (engine ordering), then scripts/messages/explosions. */
function attachToWorld(inst){
  const list=walkAll(inst);
  for (const it of list){
    buildOrRestore(it);
    if (isPartLike(it) && state.netEnabled !== false && netReplicablePart(it)){
      netIdOf(it);
      state.netNew.add(it);
      state.netDirty.delete(it);
    }
  }
  /* authored joints only become live once both referenced parts exist */
  for (const it of list) if (JOINT_CLASSES.has(it.cls)) syncJointInst(it, true);
  for (const it of list){
    if (isRunnableScript(it)) launchScript(it);
    else if (it.cls==='Message') messageShow(it);
    else if (it.cls==='Hint') hintShow(it);
    else if (it.cls==='Explosion') explodeInst(it);
  }
}

/* leaving world  mirrors the runner's destroy semantics */
function detachFromWorld(inst, destroyed){
  const w=state.world;
  for (const it of walkAll(inst)){
    if (isPartLike(it)){
      if (destroyed&&it.props.PlayOnRemove===true) playOnRemoveSound(it);
      if (netReplicablePart(it) && state.netEnabled !== false){
        netIdOf(it);
        state.netDead.add(it);
        state.netNew.delete(it);
        state.netDirty.delete(it);
      }
      const look=w&&w.partLook? w.partLook.get(it) : null;
      if (look&&!look.destroyed&&w&&w.destroyPart) w.destroyPart(it);
      if (look) state.movers.delete(look);
      state.watchSet.delete(it);
      it.__touchIn=false; it.__tc_terrain=false; it.__tc_char=false;
      clearContactEdges(look);
      if (it===state.torsoInst) continue;   /* fake parts never die by removal */
    } else if (isRunnableScript(it)){
      killScript(it); it.__launched=false;
    } else if (it.cls==='Message'){
      messageHide(it);
    } else if (it.cls==='Hint'){
      hintHide(it);
    } else if (it.cls==='Sound'){
      /* A destroyed parent destroys its Sound children.  Stop any live
       * loop first (the rocket Swoosh otherwise keeps playing forever),
       * then honour Sound.PlayOnRemove (the rocket's collide.wav boom). */
      soundStop(it);
      if (destroyed&&it.props.PlayOnRemove===true) playOnRemoveSound(it);
    } else if (it.cls==='Explosion'){
      /* removing before the 0.1 s fuse cancels the pending blast */
      it.__exploded=true; it.__blastQueued=false;
    }
  }
  dropJointsUnder(inst);
}

function reparent(inst, newParent){
  if (!inst||inst===newParent) return;
  const np=newParent||null;
  if (inst.parent===np) return;
  if (inst===state.workspaceInst) return;            /* workspace never moves */
  const was=withinWorld(inst);
  const oldParent=inst.parent;
  if (oldParent){
    const i=oldParent.children.indexOf(inst);
    if (i>=0) oldParent.children.splice(i,1);
  }
  inst.parent=np;
  if (np) np.children.push(inst);
  if (np===state.playersInst &&
      (inst.cls==='Player'||inst.__player||/^Player\d+$/i.test(String(inst.props&&inst.props.Name||''))))
    ensureBackpackForPlayer(inst);
  const now=withinWorld(inst);
  if (now&&!was) attachToWorld(inst);
  else if (!now&&was) detachFromWorld(inst, !np);
  if (inst.cls==='Team') autoAssignTeams();
  syncCharacterMover(inst);
  /* the bridge exposes ChildAdded/ChildRemoved on every instance; fire
   * them after the child is fully built so waitForChild() finds it */
  if (oldParent) fireEvent(oldParent, 'ChildRemoved', [wrap(inst)]);
  if (np) fireEvent(np, 'ChildAdded', [wrap(inst)]);
}

/* ---------- Message / Explosion / Lighting side effects ---------- */
function messageShow(inst){
  if (!state.ui) return;
  state.activeMessage=inst;
  state.ui.showSystemMessage(String(inst.props.Text||''));
}
function messageHide(inst){
  if (!state.ui) return;
  if (state.activeMessage&&state.activeMessage!==inst) return;
  state.activeMessage=null;
  state.ui.hideSystemMessage();
}
/* RBX::Hint : TextDisplay, the classic one-line on-screen hint.  Like
 * Message, the newest live Hint under Workspace wins; parent/Text writes
 * update it and removal hides it. */
function hintShow(inst){
  if (!state.ui) return;
  state.activeHint=inst;
  if (state.ui.showHint) state.ui.showHint(String(inst.props.Text||''));
}
function hintHide(inst){
  if (!state.ui) return;
  if (state.activeHint&&state.activeHint!==inst) return;
  state.activeHint=null;
  if (state.ui.hideHint) state.ui.hideHint();
}
function fireExplosionHit(inst, part, distance){
  const m=state.signals.get(inst);
  if (!m) return;
  for (const key of ['Hit','hit']){
    const sig=m[key];
    if (!sig||!sig.list.some(e=>e.active)) continue;
    try { sig.fire([wrap(part), distance]); } catch(_){}
  }
}
function explodeInst(inst){
  const w=state.world;
  if (!w||!w.explodeAt||inst.__blastQueued||inst.__exploded) return;
  const p=vec3Read(inst.props.Position)||{x:0,y:0,z:0};
  let r=Number(inst.props.BlastRadius);
  if (!isFinite(r)) r=4;                   /* engine ctor default 4.0f */
  let pr=Number(inst.props.BlastPressure);
  if (!isFinite(pr)) pr=500000;            /* engine ctor default 500000 */
  inst.__blastQueued=true;
  state.pendingExplosions.push({ inst, t:0,
    pos:{x:p.x, y:p.y, z:p.z}, radius:r, pressure:pr });
}
function stepDebris(dt){
  /* RBX::Debris keeps a FIFO of (instance, remaining seconds); MaxItems
   * caps the queue (the shipped Haunted service sets 1000). */
  for (let i=state.debris.length-1;i>=0;i--){
    const d=state.debris[i];
    d.t-=dt;
    if (d.t>0) continue;
    state.debris.splice(i,1);
    if (d.inst) reparent(d.inst, null);
  }
}
function stepExplosions(dt){
  /* Explosion fuse: FUN_00604250 accumulates time and detonates after
   * 0.1 s, then the instance removes itself. */
  const w=state.world;
  for (let i=state.pendingExplosions.length-1;i>=0;i--){
    const e=state.pendingExplosions[i];
    if (e.inst.__exploded){ state.pendingExplosions.splice(i,1); continue; }
    e.t+=dt;
    if (e.t<=0.1) continue;
    state.pendingExplosions.splice(i,1);
    if (w&&w.explodeAt){
      w.explodeAt(e.pos, e.radius, e.pressure, e.inst,
        (part,dist)=>fireExplosionHit(e.inst, part, dist));
    }
    state.netFX.push({
      t: 'e',
      p: [round3(e.pos.x), round3(e.pos.y), round3(e.pos.z)],
      r: round3(e.radius)
    });
    /* visual: the tools Explosion is the engine's RBX::View::Explosion render */
    if (e.radius>0&&window.RBLXtools&&window.RBLXtools.Explosion&&w&&w.scene&&window.THREE){
      try {
        const vis=new window.RBLXtools.Explosion(w.scene,
          new THREE.Vector3(e.pos.x,e.pos.y,e.pos.z), e.radius);
        state.explosions.push(vis);
      } catch(_){}
    }
    e.inst.__exploded=true;
    e.inst.__blastQueued=false;
    reparent(e.inst, null);
  }
  for (let i=state.explosions.length-1;i>=0;i--){
    try { if (!state.explosions[i].step(dt)) state.explosions.splice(i,1); }
    catch(_){ state.explosions.splice(i,1); }
  }
}
/* PlayOnRemove: the engine plays a Sound (collide.wav etc.) when its parent
 * is destroyed  ported in the destroy path (Rocket boom) */
function playOnRemoveSound(inst){
  const url=soundUrlOf(inst);
  if (!url||!window.Sounds||!window.Sounds.load) return;
  const vol=(inst.props.Volume!=null)? Number(inst.props.Volume) : 1;
  window.Sounds.load(url).then(buf=>{
    window.Sounds.playBuf(buf, {volume:vol, position:soundPositionOf(inst)});
    return buf;
  }).catch(()=>{});
}
function applyTimeOfDay(mins){
  if (state.world&&state.world.applyTimeOfDay) state.world.applyTimeOfDay(Number(mins)||0);
}
function parseTimeOfDay(str){
  const m=/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/.exec(String(str||'').trim());
  if (!m) return null;
  const h=+m[1], mi=+m[2], s=m[3]!=null? +m[3] : 0;
  if (h>23||mi>59||s>=60) return null;
  return h*60+mi+s/60;
}
function formatTimeOfDay(mins){
  let t=Number(mins); if (!isFinite(t)) t=720;
  t=((t%1440)+1440)%1440;
  const sec=Math.round(t*60)%86400;
  const h=Math.floor(sec/3600), mi=Math.floor((sec%3600)/60), s=sec%60;
  return (h<10?'0':'')+h+':'+(mi<10?'0':'')+mi+':'+(s<10?'0':'')+s;
}
function timeOfDayMinutes(){
  if (state.dayMinutes!=null) return state.dayMinutes;
  const fromProp=parseTimeOfDay(state.lightingInst&&state.lightingInst.props&&state.lightingInst.props.TimeOfDay);
  return fromProp!=null? fromProp : 720;
}

/* ---------- part mutation helpers ---------- */
/* Script CFrame/Position writes on a rigid welded body move the whole
 * assembly (see Dynamics.moveAssembly).  Anchored or lone parts fall back
 * to moving just the requested part. */
function moveScriptPart(inst, cf){
  const look=viewLook(inst);
  if (look&&window.RBLXdyn&&window.RBLXdyn.moveAssembly&&
      window.RBLXdyn.moveAssembly(look, cf)) return;
  placePart(inst, cf);
}
/* replicate world.buildPart's CF application + enclosing AABB math */
function placePart(inst, cf){
  const rot=(cf.rot&&cf.rot.length===9)? cf.rot.slice() : [1,0,0, 0,1,0, 0,0,1];
  const pos={ x:cf.pos.x||0, y:cf.pos.y||0, z:cf.pos.z||0 };
  inst.props.CFrame={ pos:{x:pos.x,y:pos.y,z:pos.z}, rot:rot };
  const look=viewLook(inst);
  if (!look||look.destroyed) return look;
  look.cf={pos:{x:pos.x,y:pos.y,z:pos.z}, rot:rot};
  /* face centres/normals are cached per look; a moved or rotated part must
   * recompute them or AutoJoin tests the old pose (dragging a brick with a
   * bottom Inlet onto a top Studs face never welded) */
  delete look.__faces;
  if (look.obj&&window.THREE){
    const m4=new THREE.Matrix4().set(
      rot[0], rot[1], rot[2], pos.x,
      rot[3], rot[4], rot[5], pos.y,
      rot[6], rot[7], rot[8], pos.z,
      0,0,0,1);
    /* buildPart used applyMatrix4+decompose; set position/rotation directly
     * (same net transform, no accumulation across steps) */
    look.obj.position.set(pos.x,pos.y,pos.z);
    look.obj.quaternion.setFromRotationMatrix(m4);
  }
  if (look.aabb){
    const s=look.size, hx=s.x/2, hy=s.y/2, hz=s.z/2;
    const ex=Math.abs(rot[0])*hx+Math.abs(rot[1])*hy+Math.abs(rot[2])*hz;
    const ey=Math.abs(rot[3])*hx+Math.abs(rot[4])*hy+Math.abs(rot[5])*hz;
    const ez=Math.abs(rot[6])*hx+Math.abs(rot[7])*hy+Math.abs(rot[8])*hz;
    look.aabb.min={x:pos.x-ex, y:pos.y-ey, z:pos.z-ez};
    look.aabb.max={x:pos.x+ex, y:pos.y+ey, z:pos.z+ez};
  }
  /* a moved ladder/truss part must move its climb volume too */
  if (look.climb){
    const s=look.size, hx=s.x/2, hy=s.y/2, hz=s.z/2;
    const ex=Math.abs(rot[0])*hx+Math.abs(rot[1])*hy+Math.abs(rot[2])*hz;
    const ey=Math.abs(rot[3])*hx+Math.abs(rot[4])*hy+Math.abs(rot[5])*hz;
    const ez=Math.abs(rot[6])*hx+Math.abs(rot[7])*hy+Math.abs(rot[8])*hz;
    look.volAABB={ min:{x:pos.x-ex, y:pos.y-ey, z:pos.z-ez},
                   max:{x:pos.x+ex, y:pos.y+ey, z:pos.z+ez} };
    if (state.world) state.world._climbDirty=true;
  }
  state.poseRev++;
  staticDirty(look);
  netMark(inst);
  return look;
}

/* ================================================================
 * Authored JointInstance objects (Weld/Glue/Motor/RotateP/RotateV).
 * The record lives on world.jointRecs; dynamics reads it at every
 * re-cluster.  Part0/Part1/C0/C1 writes re-sync it immediately.
 * ============================================================== */
function refInst(v){
  if (!v||typeof v!=='object') return null;
  if (v.__rinst) return v.__rinst;
  if (v.cls&&v.props) return v;
  return null;
}
function cfIdentity(){ return {pos:{x:0,y:0,z:0}, rot:[1,0,0,0,1,0,0,0,1]}; }
function cfRec(v){
  if (v&&v.pos&&v.rot&&v.rot.length===9)
    return { pos:{x:v.pos.x||0,y:v.pos.y||0,z:v.pos.z||0}, rot:v.rot.slice() };
  return cfIdentity();
}
function cfInverse(a){
  const R=a.rot||[1,0,0,0,1,0,0,0,1];
  const T=[R[0],R[3],R[6], R[1],R[4],R[7], R[2],R[5],R[8]];
  const p=a.pos||{x:0,y:0,z:0};
  return { pos:{ x:-(T[0]*p.x+T[1]*p.y+T[2]*p.z),
                 y:-(T[3]*p.x+T[4]*p.y+T[5]*p.z),
                 z:-(T[6]*p.x+T[7]*p.y+T[8]*p.z) },
           rot:T };
}
function jointKindOf(cls){
  switch (cls){
    case 'Weld': case 'Snap': return 'weld';
    case 'Glue': return 'glue';
    case 'Motor': return 'motor';
    case 'RotateP': return 'rotateP';
    case 'RotateV': return 'rotateV';
  }
  return null;
}
/* the authored weld's C0/C1 pose: Part1 = Part0 * C0 * C1^-1.  The engine
 * snaps the unanchored side when the joint is created; saved files are
 * normally already there, so this is a no-op for them. */
function alignJoint(rec){
  const a=rec.aLook, b=rec.bLook;
  if (!a||!b||a.destroyed||b.destroyed||a===b||a.anchored&&b.anchored) return;
  const A=a.cf||cfIdentity(), B=b.cf||cfIdentity();
  const C0=rec.c0||cfIdentity(), C1=rec.c1||cfIdentity();
  if (!b.anchored){
    const target=cfMulCF(cfMulCF(A,C0), cfInverse(C1));
    placePart(rec.b, target);
  } else if (!a.anchored){
    const target=cfMulCF(cfMulCF(B,C1), cfInverse(C0));
    placePart(rec.a, target);
  }
}
function syncJointInst(inst, align){
  if (!inst||!JOINT_CLASSES.has(inst.cls)) return null;
  const w=state.world;
  if (!w||!w.jointRecs) return null;
  const a=refInst(inst.props.Part0), b=refInst(inst.props.Part1);
  const aLook=a? viewLook(a):null, bLook=b? viewLook(b):null;
  if (!a||!b||!aLook||!bLook||aLook.destroyed||bLook.destroyed){
    if (w.jointRecs.delete(inst)) markJointDirty();
    return null;
  }
  const rec={ inst, kind:jointKindOf(inst.cls), a, b,
              aLook, bLook,
              c0:cfRec(inst.props.C0), c1:cfRec(inst.props.C1) };
  w.jointRecs.set(inst, rec);
  if (align) alignJoint(rec);
  markJointDirty();
  return rec;
}
function syncJointsUnder(root){
  if (!root) return 0;
  let n=0;
  for (const it of walkAll(root)) if (JOINT_CLASSES.has(it.cls)){
    if (syncJointInst(it, true)) n++;
  }
  return n;
}
function dropJointsUnder(root){
  const w=state.world;
  if (!w||!w.jointRecs||!root) return;
  for (const it of walkAll(root)) w.jointRecs.delete(it);
  for (const [inst,rec] of Array.from(w.jointRecs)){
    if (rec.a===root||rec.b===root||isDescendantOf(rec.a,root)||isDescendantOf(rec.b,root))
      w.jointRecs.delete(inst);
  }
  markJointDirty();
}
function isDescendantOf(it, root){
  let p=it&&it.parent;
  while (p){ if (p===root) return true; p=p.parent; }
  return false;
}

/* Materials come from world.materialCache and are shared by every part of
 * the same colour/surface/transparency.  A scripted BrickColor or
 * Transparency write must never mutate that shared object: one lightning
 * strike would recolour the whole mansion and the bomb's transparent
 * PrimaryPart would punch see-through holes in unrelated walls.  Copy the
 * material(s) onto this look before changing them. */
function ownLookMaterials(look){
  const src=look&&look.obj? look.obj.material : null;
  if (!src) return [];
  const arr=Array.isArray(src)? src : [src];
  const copy=arr.map(m=>m&&m.clone? m.clone() : m);
  look.obj.material=Array.isArray(src)? copy : copy[0];
  return copy;
}
function recolorPart(inst, cl){
  const look=viewLook(inst);
  if (!look||!look.obj) return;
  const mats=ownLookMaterials(look);
  for (const m of mats){
    if (m&&m.color) m.color.setRGB(cl[0],cl[1],cl[2]);
  }
  if (look.entry){
    const rgb=[Math.round(cl[0]*255),Math.round(cl[1]*255),Math.round(cl[2]*255)];
    const id=matchBrickColorId(rgb);
    const e=window.BrickColorFromId(id);
    look.entry.rgb=rgb;
    look.entry.id=id;
    if (e) look.entry.name=e.name;
  }
  staticDirty(look);
  netMark(inst);
}

function matchBrickColorId(rgb){
  if (!rgb||!window.BrickColorFromId) return 2;
  /* callers pass 0-255 int triples (both the BrickColor-write path and
   * BrickColor.new(r,g,b))  the old ×255 here double-scaled every lookup
   * and matched ~everything to White (the Rally GoButton turned white,
   * not red) */
  const r=rgb[0], g=rgb[1], b=rgb[2];
  let best=2, bd=1e18;
  for (const e of paletteEntries()){
    if (!e||!e.rgb) continue;
    const dr=e.rgb[0]-r, dg=e.rgb[1]-g, db=e.rgb[2]-b;
    const d2=dr*dr+dg*dg+db*db;
    if (d2<bd){ bd=d2; best=e.id; }
  }
  return best;
}

function moverRegister(inst, vel){
  const look=viewLook(inst);
  if (!look||look.destroyed) return;
  look.velocity={ x:(vel&&vel.x)||0, y:(vel&&vel.y)||0, z:(vel&&vel.z)||0 };
  look.scriptMover=true;      /* dynamics must not free-fall this body too */
  state.movers.add(look);
}

/* ---------- sounds ---------- */
function soundUrlOf(inst){
  const s=inst.props&&inst.props.SoundId;
  if (typeof s==='string') return window.Sounds&&window.Sounds.resolve? window.Sounds.resolve(s) : s;
  if (s&&typeof s==='object'){
    if (s.binary!=null) return s.binary;
    if (s.url!=null) return s.url;
    if (s.text!=null) return window.Sounds&&window.Sounds.resolve? window.Sounds.resolve(s.text) : s.text;
  }
  return null;
}
/* positional source: the nearest ancestor BasePart (FMOD 3D channel).  A
 * Sound directly under Workspace/SoundService has no emitter and stays 2D. */
function soundPositionOf(inst){
  let p=inst&&inst.parent;
  while (p){
    if (PART_CLASSES.has(p.cls)){
      const look=viewLook(p);
      if (look&&look.cf) return {x:look.cf.pos.x, y:look.cf.pos.y, z:look.cf.pos.z};
      return null;
    }
    p=p.parent;
  }
  return null;
}
function soundPlay(inst){
  const url=soundUrlOf(inst);
  if (!url||!window.Sounds||!window.Sounds.load) return;
  const vol=(inst.props.Volume!=null)? Number(inst.props.Volume) : 0.5;
  const loop=inst.props.Looped===true;
  /* A stop/remove may race the async decode (Rocket hits within the first
   * frames).  Tag the request so a stale decode can never start a loop. */
  const seq=(inst.__soundSeq=(inst.__soundSeq||0)+1);
  const old=state.soundHandles.get(inst);
  if (old&&old.handle){ try{ old.handle.stop(); }catch(_){ } }
  state.soundHandles.delete(inst);
  window.Sounds.load(url).then(buf=>{
    if (inst.__soundSeq!==seq) return null;
    const pos=soundPositionOf(inst);
    const h=window.Sounds.playBuf(buf, {volume:vol, loop, position:pos});
    if (inst.__soundSeq!==seq || !h){ if (h) try{ h.stop(); }catch(_){} return null; }
    state.soundHandles.set(inst, {handle:h, inst});
    return h;
  }).catch(()=>{ /* missing audio stays silent  engine behavior */ });
}
function soundStop(inst){
  inst.__soundSeq=(inst.__soundSeq||0)+1;
  const h=state.soundHandles.get(inst);
  if (h&&h.handle){ try{ h.handle.stop(); }catch(_){ } }
  state.soundHandles.delete(inst);
}
/* loop sound emitters follow their part (rocket swoosh, footsteps) */
function tickSoundPositions(){
  for (const [inst,rec] of state.soundHandles){
    if (!rec||!rec.handle||!rec.handle.setPosition) continue;
    const pos=soundPositionOf(inst);
    if (pos) rec.handle.setPosition(pos.x,pos.y,pos.z);
  }
}

/* ---------- read a props value as Lua ---------- */
function vec3Read(v){
  if (v&&v.pv) return {x:v.pv[0], y:v.pv[1], z:v.pv[2]};
  if (typeof v==='object'&&v&&typeof v.x==='number') return {x:v.x, y:v.y, z:v.z};
  return null;
}
function propToLua(pv){
  if (pv&&typeof pv==='object'&&pv.cls&&pv.props!==undefined)
    return wrap(pv);                       /* resolved object reference */
  if (pv&&typeof pv==='object'&&pv.pos!==undefined&&pv.rot!==undefined)
    return CF({x:pv.pos.x||0,y:pv.pos.y||0,z:pv.pos.z||0}, pv.rot);
  if (pv&&typeof pv==='object'&&pv.x!==undefined)
    return V3(pv.x||0, pv.y||0, pv.z||0);
  return pv;
}

/* ---- Tool grip -------------------------------------------------------
 * decomp FUN_005d1450 (Tool::equip weld) and the property table:
 *   "Grip"       CFrame  (registered at 0x775140, stored at Tool+0x1ac)
 *   "GripPos"    Vector3 = Grip.p
 *   "GripRight"  Vector3 = column 0
 *   "GripUp"     Vector3 = column 1
 *   "GripForward"Vector3 = -column 2
 * The four vectors are views of the CFrame, so Grip is canonical here and
 * the vectors are derived/synced.  Older files may store only the four.
 * -------------------------------------------------------------------- */
function toolGripCF(inst){
  const p=(inst&&inst.props)||{};
  const g=p.Grip;
  if (g&&g.pos&&g.rot&&g.rot.length>=9){
    return { pos:{x:g.pos.x||0,y:g.pos.y||0,z:g.pos.z||0},
             rot:[g.rot[0],g.rot[1],g.rot[2],g.rot[3],g.rot[4],g.rot[5],g.rot[6],g.rot[7],g.rot[8]] };
  }
  /* derive from the serialized vectors (GripRight/Up/Forward, GripPos) */
  const P=vec3Read(p.GripPos)||{x:0,y:0,z:0};
  let R=vec3Read(p.GripRight)||{x:1,y:0,z:0};
  let U=vec3Read(p.GripUp)||{x:0,y:1,z:0};
  let F=vec3Read(p.GripForward)||{x:0,y:0,z:-1};
  const norm=v=>{ const l=Math.hypot(v.x,v.y,v.z)||1; return {x:v.x/l,y:v.y/l,z:v.z/l}; };
  const cross=(a,b)=>({x:a.y*b.z-a.z*b.y, y:a.z*b.x-a.x*b.z, z:a.x*b.y-a.y*b.x});
  R=norm(R); U=norm(U); F=norm(F);
  let B={x:-F.x,y:-F.y,z:-F.z};
  R=norm(cross(U,B));
  if (!isFinite(R.x)||!isFinite(R.y)||!isFinite(R.z)||Math.hypot(R.x,R.y,R.z)<1e-6)
    R={x:1,y:0,z:0};
  U=cross(B,R);
  if (Math.hypot(U.x,U.y,U.z)<1e-6) U={x:0,y:1,z:0};
  B=cross(R,U);
  return { pos:P, rot:[R.x,U.x,B.x, R.y,U.y,B.y, R.z,U.z,B.z] };
}
function toolGripVectors(g){
  const r=g.rot, p=g.pos;
  return {
    GripPos:{x:p.x,y:p.y,z:p.z},
    GripRight:{x:r[0],y:r[3],z:r[6]},
    GripUp:{x:r[1],y:r[4],z:r[7]},
    GripForward:{x:-r[2],y:-r[5],z:-r[8]},
  };
}
function setToolGrip(inst, cf){
  const g=toolGripCF({ cls:'Tool', props:{ Grip:cf } });
  inst.props.Grip=g;
  const v=toolGripVectors(g);
  inst.props.GripPos=v.GripPos;
  inst.props.GripRight=v.GripRight;
  inst.props.GripUp=v.GripUp;
  inst.props.GripForward=v.GripForward;
  return g;
}
function ton(v){ const n=(typeof v==='number')? v : parseFloat(v); return isFinite(n)? n : 0; }

/* ================================================================
 * signals
 * ============================================================== */
function signalsOf(inst){
  let m=state.signals.get(inst);
  if (!m){ m={}; state.signals.set(inst, m); }
  return m;
}
function touchedSignal(inst, name){
  const nm=name||'Touched';
  const m=signalsOf(inst);
  let s=m[nm];
  if (!s){ s=new Signal(nm); m[nm]=s; if (nm==='Touched'&&isPartLike(inst)) state.watchSet.add(inst); }
  return s;
}
function wrapSignal(sig){
  return { [MT]:{
    __index(args){
      const k=String(args[1]);
      switch (k){
        case 'connect': case 'Connect':
          return [mkM(a=>[sig.connect(a[1])])];
        case 'disconnect': case 'Disconnect':
          return [mkM(()=>{ sig.list.length=0; return []; })];
        case 'wait': case 'Wait':
          return [L.mkNative(function*(ip,args){
            let fired=false, vals=null;
            const handler=L.mkNative(function*(hIp,hArgs){
              fired=true; vals=hArgs||[]; return [];
            },true);
            const conn=sig.connect(handler, ip);
            try {
              while (!fired) yield {t:'wait', d:0};
            } finally {
              if (conn.__sigEntry) dropConnection(sig, conn.__sigEntry);
            }
            return vals||[];
          },true)];
      }
      return [undefined];
    }
  }};
}

/* ================================================================
 * per-frame contacts (fires Touched) + movers + Stepped
 * ============================================================== */
/* runner _touching(): (p.x+2.2>min.x&&p.x-2.2<max.x && p.z+0.75&&… && p.y+2.2&&(p.y-3.2)<max.y) */
function torsoOverlaps(aabb, pad, ch){
  const c=ch||char();
  if (!c||!c.group||!c.group.position) return false;
  const p=c.group.position;
  const P=pad||{x:2.2, z:0.75, yt:2.2, yb:3.2};
  return (p.x+P.x>aabb.min.x && p.x-P.x<aabb.max.x &&
          p.z+P.z>aabb.min.z && p.z-P.z<aabb.max.z &&
          p.y+P.yt>aabb.min.y && p.y-P.yb<aabb.max.y);
}
function enterFlag(look, key){
  const ch=char();
  const inside=ch&&ch.alive? torsoOverlaps(look.aabb) : false;
  const was=look[key];
  look[key]=inside;
  return inside&&!was;
}
function fireTouched(inst, hitWrap){
  const m=state.signals.get(inst);
  const sig=m&&m.Touched;
  if (!sig||!sig.list.some(e=>e.active)) return;
  sig.fire([hitWrap, V3(inst.__tcx||0, inst.__tcy||0, inst.__tcz||0)]);
}

function tickContacts(dt){
  const w=state.world;
  if (!w||!w.partLook||!state.workspaceInst) return;
  /* 1) movers: integrate, then terrain/character probes */
  for (const look of state.movers){
    const inst=look.part;
    if (!look||look.destroyed||!w.partLook.get(inst)){
      state.movers.delete(look);
      continue;
    }
    const v=look.velocity||(look.velocity={x:0,y:0,z:0});
    const rv=look.rotVelocity;
    const hasV=!!(v.x||v.y||v.z);
    const hasRV=!!(rv&&(rv.x||rv.y||rv.z));
    if (!hasV&&!hasRV) continue;
    if (!look.anchored) v.y-=196.2*dt;              /* loose-part gravity */
    const rot=hasRV? spinPartRotation(look.cf.rot, rv, dt) : look.cf.rot;
    placePart(inst, {pos:{x:look.cf.pos.x+v.x*dt, y:look.cf.pos.y+v.y*dt, z:look.cf.pos.z+v.z*dt}, rot});
    /* terrain probe: the shipped raycastBoxes probe returns the look */
    const rad=Math.max(look.size.x,look.size.y,look.size.z)*0.55;
    const hit=w.raycastBoxes? w.raycastBoxes(look.cf.pos, {radius:rad}) : null;
    if (hit&&hit!==look){
      if (!look.__tc_terrain){
        look.__tc_terrain=true;
        v.x=v.y=v.z=0;                              /* first contact stops the shell */
        if (rv){ rv.x=rv.y=rv.z=0; }
        fireTouched(inst, wrap(hit.part));
      }
      v.x=v.y=v.z=0;
      if (rv){ rv.x=rv.y=rv.z=0; }
    } else {
      look.__tc_terrain=false;
    }
    /* character probe (pellet damage path) */
    if (char()&&char().alive&&look.aabb){
      const ch=char(), p=ch.group.position, a=look.aabb;
      const inside=(p.x+0.9>a.min.x&&p.x-0.9<a.max.x&&
                    p.z+0.9>a.min.z&&p.z-0.9<a.max.z&&
                    p.y+1.9>a.min.y&&p.y-1.9<a.max.y);
      if (inside&&!look.__tc_char){
        look.__tc_char=true;
        fireTouched(inst, wrap(state.torsoInst));
      }
    }
    /* remote characters hit by the same mover (rockets/pellets/etc.) */
    if (look.aabb && state.netPlayers.size){
      if (!look.__tc_net) look.__tc_net=new Map();
      const a=look.aabb;
      for (const [id,rec] of state.netPlayers){
        const ch=rec.character;
        if (!ch||!ch.alive||!ch.group) { look.__tc_net.delete(id); continue; }
        const p=ch.group.position;
        const inside=(p.x+0.9>a.min.x&&p.x-0.9<a.max.x&&
                      p.z+0.9>a.min.z&&p.z-0.9<a.max.z&&
                      p.y+1.9>a.min.y&&p.y-1.9<a.max.y);
        const was=look.__tc_net.get(id)===true;
        look.__tc_net.set(id, inside);
        if (inside&&!was) fireTouched(inst, wrap(rec.torso));
      }
    }
  }
  /* 2) static parts whose scripts connected Touched  stepping on them */
  for (const inst of state.watchSet){
    const look=w.partLook.get(inst);
    if (!look||look.destroyed||!look.aabb) continue;
    if (state.movers.has(look)) continue;          /* movers already probe in §1 */
    if (enterFlag(look, '__touchIn')) fireTouched(inst, wrap(state.torsoInst));
    if (state.netPlayers.size){
      if (!look.__netIn) look.__netIn=new Map();
      for (const [id,rec] of state.netPlayers){
        const ch=rec.character;
        const inside=ch&&ch.alive? torsoOverlaps(look.aabb, null, ch) : false;
        const was=look.__netIn.get(id)===true;
        look.__netIn.set(id, inside);
        if (inside&&!was) fireTouched(inst, wrap(rec.torso));
      }
    }
  }
}

/* part-vs-part contact edges (dynamics contactHook): fire Touched when a
 * part with listeners ENTERS contact with another part  the HHH crane's
 * Engine parks by touching the Stop pad (classic Touched is any-contact). */
function contactTouched(a, b){
  if (!a||!b||a===b) return;
  edge(a,b);
  edge(b,a);
  function edge(subject, other){
    const m=state.signals.get(subject.part);
    const sig=m&&m.Touched;
    if (!sig||!sig.list.some(e=>e.active)) return;
    if (other.destroyed){ if (subject.__pt) subject.__pt.delete(other); return; }
    if (!subject.__pt) subject.__pt=new Map();
    const was=subject.__pt.get(other)===true;
    subject.__pt.set(other, true);
    if (!was) sig.fire([wrap(other.part), V3(0,0,0)]);
  }
}
function clearContactEdges(look){
  if (look.__pt) look.__pt.clear();
}

/* BodyVelocity/BodyPosition on the character (Ghostwalk/JetBoots and the
 * harvester crane's escort lift): the engine constrains the humanoid root.
 * BodyVelocity = per-axis velocity constraint while maxForce permits;
 * BodyPosition = per-axis P·err − D·v force clamp (dynamics.js law), with
 * the engine ctor defaults P=10000 D=1250. */
const CHAR_MASS=10;                   /* classic torso mass (same as blast) */
function applyCharacterMovers(dt){
  const ch=char();
  if (!ch||!ch.velocity) return;
  let heldNow=false;
  for (const inst of Array.from(state.characterMovers)){
    if (!inst.parent||!isUnderCharacter(inst)){ state.characterMovers.delete(inst); continue; }
    if (inst.cls==='BodyVelocity'){
      const target=vec3Read(inst.props.velocity)||vec3Read(inst.props.Velocity);
      const cap=vec3Read(inst.props.maxForce)||vec3Read(inst.props.MaxForce);
      if (!target||!cap) continue;
      const axes=['x','y','z'];
      for (let i=0;i<3;i++){
        const a=axes[i];
        if ((cap[a]||0)>0) ch.velocity[a]=target[a]||0;
      }
    } else if (inst.cls==='BodyPosition'){
      const target=vec3Read(inst.props.position)||vec3Read(inst.props.Position);
      if (!target) continue;
      const P=(+inst.props.P)||0, D=(+inst.props.D)||0;
      const cap=vec3Read(inst.props.maxForce)||vec3Read(inst.props.MaxForce)||{x:0,y:0,z:0};
      const p=ch.group.position, v=ch.velocity;
      let anyForce=false;
      for (const a of ['x','y','z']){
        if (!((cap[a]||0)>0)) continue;
        const err=target[a]-p[a];
        let F=P*err-D*v[a];
        F=Math.max(-cap[a], Math.min(cap[a], F));
        v[a]+=F/CHAR_MASS*dt;
        /* explicit-Euler PD with the engine's P=10000 on a mass-10 body
         * overshoots ±3 studs per tick (the crane-hold camera strobe)
         * clip the axis speed so one tick can never CROSS the target:
         * monotone approach, critically damped in practice */
        const vmax=Math.abs(err)/Math.max(dt,1e-4)*0.85;
        v[a]=Math.max(-vmax, Math.min(vmax, v[a]));
        anyForce=anyForce||Math.abs(F)>1e-6;
      }
      if (anyForce&&P>0) heldNow=true;
    }
  }
  /* while a position servo holds the body, physics skips landing/ground
   * probing  the ground clamp zeroing vy and the probe's onGround=true
   * fought the servo tick by tick (part of the same strobe) */
  ch.heldByServo=heldNow;
}

function fireStepped(dt){
  if (!state.gameInst) return;
  applyCharacterMovers(dt);
  tickContacts(dt);
  tickSoundPositions();
  stepDebris(dt);
  stepExplosions(dt);
  if (state.signals2&&state.signals2.stepped)
    state.signals2.stepped.fire([L.sched.time+dt, dt]);
  /* humanoid Died edge */
  const ch=char();
  if (ch&&state.humanInst){
    if (!ch.alive&&!state.diedFired){
      state.diedFired=true;
      const m=state.signals.get(state.humanInst);
      if (m&&m.Died) m.Died.fire([]);
    } else if (ch.alive) state.diedFired=false;
  }
}

/* ----------------------------------------------------------------
 * PlaySolo ordering helpers.  The 2007 client starts the place scripts
 * before `Players:createLocalPlayer()`; this port creates the local
 * Player while building the tree, then launches the scripts.  Replay the
 * events the scripts missed:
 *   - Players.ChildAdded(player) once, after the script bodies have run
 *   - Player.Changed("Character") after each respawn's setCharacter()
 * -------------------------------------------------------------- */
function firePlayerAdded(){
  if (!state.playersInst||!state.playerInst) return 0;
  const p=wrap(state.playerInst);
  return fireEvent(state.playersInst, 'ChildAdded', [p])+
         fireEvent(state.playersInst, 'PlayerAdded', [p]);
}
function firePlayerChanged(prop){
  if (!state.playerInst) return 0;
  return fireEvent(state.playerInst, 'Changed', [String(prop||'')]);
}

/* ================================================================
 * Teams / TeamColor
 * 2007 Teams service: each Team carries TeamColor (BrickColor),
 * AutoAssignable and Score.  The local client joins the auto-assignable
 * team with the fewest players; Player.TeamColor follows Team.TeamColor;
 * SpawnLocation.TeamColor selects the matching pads on respawn; the
 * overhead name tag and player list use the team colour.
 * ============================================================== */
function isTeamInst(it){ return !!it && it.cls==='Team'; }
function teamInstances(){
  const ts=findService('Teams');
  if (!ts) return [];
  return ts.children.filter(isTeamInst);
}
function teamColorId(team){
  if (!team) return null;
  const v=Number(team.props.TeamColor);
  return isFinite(v)? (v|0) : 194;
}
function teamColorCSS(id, neutral){
  if (neutral||id==null) return '#ffffff';
  const e=window.BrickColorFromId? window.BrickColorFromId(id|0):null;
  return e? 'rgb('+e.rgb[0]+','+e.rgb[1]+','+e.rgb[2]+')' : '#ffffff';
}

/* Assign a team to a host-simulated remote player: fewest members wins,
 * the same tie-break the engine applies on join.  The result also colours
 * the avatar's overhead tag; the relay snapshot carries the id. */
function assignNetPlayerTeam(id){
  const rec=state.netPlayers.get(id);
  if (!rec) return null;
  const teams=teamInstances();
  if (!teams.length){
    rec.teamColor=null;
    rec.player.__teamColor=null;
    return null;
  }
  const counts=new Map();
  for (const t of teams) counts.set(t,0);
  if (state.playerTeam) counts.set(state.playerTeam,(counts.get(state.playerTeam)||0)+1);
  for (const [rid,other] of state.netPlayers){
    if (rid===id||other.teamColor==null) continue;
    const t=teams.find(t=>teamColorId(t)===other.teamColor);
    if (t) counts.set(t,(counts.get(t)||0)+1);
  }
  let pick=null, best=Infinity;
  for (const t of teams){
    if (t.props.AutoAssignable===false) continue;
    const n=counts.get(t)||0;
    if (n<best){ best=n; pick=t; }
  }
  rec.teamColor=pick? teamColorId(pick) : null;
  rec.player.__teamColor=rec.teamColor;
  if (rec.character&&rec.character.setTagColor)
    rec.character.setTagColor(teamColorCSS(rec.teamColor, rec.teamColor==null));
  return rec.teamColor;
}
function applyTeamVisuals(){
  const id=state.playerTeamColor;
  const css=teamColorCSS(id, id==null);
  if (state.character&&state.character.setTagColor) state.character.setTagColor(css);
  if (typeof document!=='undefined' && typeof document.querySelector==='function'){
    const row=document.querySelector('#playerList .plrow');
    if (row) row.style.color=id==null? '#0000ff' : css;
  }
}
function setPlayerTeam(team){
  const valid=isTeamInst(team)&&team.parent===findService('Teams');
  const old=state.playerTeam;
  state.playerTeam=valid? team : null;
  state.playerTeamColor=valid? teamColorId(team) : null;
  if (state.playerInst&&old!==state.playerTeam){
    if (old) fireEvent(old, 'PlayerRemoved', [wrap(state.playerInst)]);
    if (state.playerTeam) fireEvent(state.playerTeam, 'PlayerAdded', [wrap(state.playerInst)]);
  }
  applyTeamVisuals();
}
function autoAssignTeams(){
  const teams=teamInstances();
  if (!teams.length){ state.playerTeam=null; state.playerTeamColor=null; applyTeamVisuals(); return; }
  if (!state.playerTeam || teams.indexOf(state.playerTeam)<0){
    /* one local player: the first auto-assignable team (the engine picks
     * the team with the fewest members, which is a tie here) */
    const auto=teams.filter(t=>t.props.AutoAssignable!==false);
    setPlayerTeam(auto.length? auto[0] : null);
  } else {
    state.playerTeamColor=teamColorId(state.playerTeam);
    applyTeamVisuals();
  }
}
/* Player.TeamColor write: switch to the team with that colour (or leave
 * the player neutral when no team matches). */
function setPlayerTeamColor(id){
  if (id==null){ setPlayerTeam(null); return; }
  const team=teamInstances().find(t=>teamColorId(t)===(id|0));
  setPlayerTeam(team||null);
  if (!team){ state.playerTeamColor=id|0; applyTeamVisuals(); }
}
/* LoadCharacter spawn pick: team pads win; neutral players use the neutral
 * (Medium stone grey / missing) pads.  No match falls back to every pad. */
function chooseSpawnPad(pads, parsed){
  if (!pads||!pads.length) return null;
  const padColor=p=>{
    const v=p&&p.part&&p.part.props? p.part.props.TeamColor : null;
    if (v===null||v===undefined||v==='') return 194;
    const n=Number(v);
    return isFinite(n)? (n|0) : 194;
  };
  /* LoadCharacter can run before the bridge has built the game tree (the
   * first spawn happens before PlaceScriptRunner.init).  Peek at the file's
   * Teams service then, so the first spawn already uses the player's team
   * pads instead of a neutral one. */
  let want=state.playerTeamColor;
  if (!state.teamsReady && parsed){
    const ts=parsed.instances.find(i=>i.cls==='Teams');
    const teams=ts? ts.children.filter(isTeamInst) : [];
    const auto=teams.filter(t=>t.props.AutoAssignable!==false);
    const pick=auto.length? auto[0] : null;
    want=pick? teamColorId(pick) : null;
  }
  let pool;
  if (want!=null) pool=pads.filter(p=>padColor(p)===want);
  else pool=pads.filter(p=>padColor(p)===194);
  if (!pool.length) pool=pads;
  return pool[Math.floor(Math.random()*pool.length)];
}
function brickColorIdOf(v){
  if (typeof v==='number' && isFinite(v)) return v|0;
  if (v&&typeof v==='object'){
    if (typeof v.bid==='number') return v.bid|0;
    if (v.cl) return matchBrickColorId([Math.round(v.cl[0]*255),
                                        Math.round(v.cl[1]*255),
                                        Math.round(v.cl[2]*255)]);
  }
  return null;
}
/* Run queued script fibers without advancing physics time (wait(0) is
 * deferred to the next call, exactly like Scheduler.tick). */
function tickScripts(dt){
  if (L&&L.sched&&typeof L.sched.tick==='function') L.sched.tick(dt||0);
}

/* ================================================================
 * global objects: game tree, services, character fakes
 * ============================================================== */
function serviceKey(name){
  return String(name||'').replace(/[\s_]+/g,'').replace(/Service$/i,'').toLowerCase();
}
function findService(name){
  const wanted=String(name||'');
  if (!wanted) return null;
  const direct=childByName(state.gameInst, wanted);
  if (direct) return direct;
  const k=serviceKey(wanted);
  for (const c of state.gameInst.children){
    if (c.cls===wanted) return c;
    if (serviceKey(c.cls)===k) return c;
    if (serviceKey(c.props&&c.props.Name)===k) return c;
  }
  const known=state.services.get(k);
  return known||null;
}
function ensureService(cls, name, fakeFlag){
  let inst=findService(cls);
  if (inst) { state.services.set(serviceKey(cls), inst); return inst; }
  inst=mkInst(cls, name||cls);
  if (fakeFlag) inst[fakeFlag]=true;
  inst.parent=state.gameInst;
  state.gameInst.children.push(inst);
  state.services.set(serviceKey(cls), inst);
  return inst;
}
/* Every Player instance owns a Backpack, including players added after
 * the place loaded (the local Player1 is the one StarterPack fills). */
function ensureBackpackForPlayer(p){
  if (!p) return null;
  p.__player=true;
  let bp=childByName(p,'Backpack');
  if (!bp){ bp=mkInst('Backpack','Backpack'); bp.parent=p; p.children.push(bp); }
  bp.__backpack=true;
  return bp;
}
function buildGameTree(parsed){
  const game=mkInst('Game','Game');
  state.gameInst=game;
  state.services=new Map();
  state.rootInsts=[];
  const all=(parsed&&parsed.instances)? parsed.instances
           : (Array.isArray(parsed)? parsed : []);
  for (const r of all){
    if (r&&r.parent==null){
      r.parent=game; game.children.push(r); state.rootInsts.push(r);
      /* Every top-level Item in a .rbxl is a DataModel service.  The file
       * often gives it a display name that differs from its class
       * ("Run Service", "Soundscape", "Instance"); service lookup below is
       * class/alias based, never name-only. */
      r.__service=true;
      if (r.cls) state.services.set(serviceKey(r.cls), r);
    }
  }
  const ws=ensureService('Workspace','Workspace');
  state.workspaceInst=ws;
  const li=ensureService('Lighting','Lighting','__fakeLighting');
  state.lightingInst=li;
  const rs=ensureService('RunService','Run Service','__fakeRunService');
  rs.__fakeRunService=true;
  state.runServiceInst=rs;
  const pl=ensureService('Players','Players','__fakePlayers');
  state.playersInst=pl;
  /* The 2007 client has these services even when a place file omits them. */
  ensureService('StarterPack','StarterPack');
  ensureService('SoundService','SoundService');
  ensureService('Selection','Selection');
  ensureService('ControllerService','ControllerService');
  ensureService('Teams','Teams');
  ensureService('StarterGui','StarterGui');
  ensureService('Debris','Debris');
  ensureService('JointsService','JointsService');

  /* Local player + Backpack.  StarterPack contents are replicated into the
   * local player's Backpack on join (classic inventory architecture); they
   * are NOT live 3D objects until selected.  Every Player in Players gets
   * a Backpack, even if a place file supplied extra Player instances.
   * The local player is named after the start-page username (startpage.js). */
  const localName=(window.RBLXplayer&&window.RBLXplayer.name)||'Player1';
  let player=childByName(pl,localName)||childByName(pl,'Player1');
  if (!player){ player=mkInst('Player',localName); player.parent=pl; pl.children.push(player); }
  player.__player=true;
  state.playerInst=player;
  const players=pl.children.filter(c=>c===player||c.cls==='Player'||c.__player);
  if (!players.includes(player)) players.push(player);
  let localBackpack=null;
  for (const p of players){
    const bp=ensureBackpackForPlayer(p);
    if (p===player) localBackpack=bp;
  }
  state.backpackInst=localBackpack;
  const starter=findService('StarterPack');
  if (starter){
    const moved=[];
    for (const it of walkAll(starter)){
      if (it.cls==='Tool'||it.cls==='HopperBin') moved.push(it);
    }
    for (const it of moved){
      if (it.parent!==localBackpack) reparent(it, localBackpack);
    }
  }
  state.signals2={ stepped:new Signal('Stepped') };
  state.dayMinutes=null;
  state.mouse=MOUSE;
}

/* fake character tree bound to the runtime character object.
 * The classic DataModel exposes every limb as a Part under the character
 * Model, a Humanoid sibling, and Motor6D joints under Torso.  The shipped
 * humanoidAnimate.rbxm walks exactly that tree (waitForChild(Torso,
 * "Right Shoulder") / Figure:findFirstChild("Right Arm")). */
function setCharacter(ch){
  state.character=ch||null;
  state.diedFired=false;
  state.characterMovers=new Set();
  state.animateInst=null;
  if (state.playerInst) state.playerInst.__charModel=null;
  /* drop the previous fake rig from the workspace tree on respawn */
  if (state.modelInst&&state.modelInst.parent){
    /* kill the old Animate script and any tool scripts still under it so
     * their Humanoid/mouse connections cannot outlive the old rig */
    for (const it of walkAll(state.modelInst)) if (isRunnableScript(it)) killScript(it);
    const p=state.modelInst.parent;
    const i=p.children.indexOf(state.modelInst);
    if (i>=0) p.children.splice(i,1);
    state.modelInst.parent=null;
  }
  if (!ch) return;
  const wsl=state.workspaceInst;
  if (!wsl) return;
  const model=mkInst('Model',(window.RBLXplayer&&window.RBLXplayer.name)||'Player1');
  model.__character=true;
  model.__charObj=ch;
  model.parent=wsl; wsl.children.push(model);
  const hum=mkInst('Humanoid','Humanoid'); hum.__fakeHumanoid=true; hum.__charObj=ch;
  hum.parent=model; model.children.push(hum);
  const parts={};
  for (const nm of ['Torso','Head','Left Arm','Right Arm','Left Leg','Right Leg']){
    const p=mkInst('Part',nm);
    p.__fakeTorso=true;
    p.__charPart=nm;
    p.__charObj=ch;
    p.parent=model; model.children.push(p);
    parts[nm]=p;
  }
  const torso=parts['Torso'], head=parts['Head'];
  model.props.PrimaryPart=torso;
  /* Motor6D joints under Torso; the bridge forwards these four properties
   * to character.Motors, so the real Animate script drives the same servo
   * objects the renderer chases. */
  for (const nm of ['Right Shoulder','Left Shoulder','Right Hip','Left Hip','Neck']){
    const m=mkInst('Motor6D',nm);
    m.__motor=nm;
    m.parent=torso; torso.children.push(m);
  }
  /* the shipped scripts reach limb parts through the humanoid
   * (TeamBeacon joinTeam paints humanoid.LeftLeg / humanoid.RightLeg):
   * under the classic Humanoid the limb parts hang off the instance */
  for (const nm of ['Left Leg','Right Leg','Left Arm','Right Arm','Torso','Head']){
    hum.children.push(parts[nm]);
  }
  /* Backpack stays on the Player; equipped Tools parent to this Model. */
  state.modelInst=model;
  state.torsoInst=torso;
  state.humanInst=hum;
  if (state.playerInst) state.playerInst.__charModel=model;

  /* Launch the actual shipped Animate script.  It is the source of truth
   * for servo targets (running/idle amplitudes, jump/fall/climb poses, the
   * tool arm pose via RightArm:children()).  If the asset is unavailable or
   * the interpreter rejects it, character.js keeps its literal fallback. */
  ch.animateLua=false;
  ch.toolEquipped=false;
  if (window.CORE_ASSETS&&window.CORE_ASSETS['fonts/humanoidAnimate.rbxm']){
    try {
      const parsed=window.RBLXxml.parseRbx(window.CORE_ASSETS['fonts/humanoidAnimate.rbxm']);
      const tpl=parsed.instances.find(i=>i.cls==='Script');
      if (tpl&&tpl.props.Source){
        const animate=mkInst('Script','Animate');
        animate.props.Source=tpl.props.Source;
        animate.props.Disabled=false;
        animate.parent=model; model.children.push(animate);
        state.animateInst=animate;
        const fiber=launchScript(animate);
        ch.animateLua=!!fiber;
      }
    } catch(e){
      console.warn('[rbxenv] humanoidAnimate launch failed: '+(e&&e.message));
    }
  }
  /* the fresh rig re-applies the start-page T-shirt (any ShirtGraphic
   * parented later overrides it  syncShirts) */
  syncShirts();
  applyTeamVisuals();
}

/* Remote players get a fake DataModel tree too.  Place scripts use the
 * classic hit.Parent:findFirstChild("Humanoid") pattern; the fake tree's
 * property accessors map to the host-simulated Character, so a jumppad's
 * Torso.Velocity write or a beacon's Humanoid.Health write lands on the
 * real remote body.  Host only; joiners never run place scripts. */
function addNetPlayer(id, name, ch){
  if (!id || !ch || !state.playersInst || !state.workspaceInst) return null;
  let rec = state.netPlayers.get(id);
  if (rec){
    rec.character = ch;
    rec.name = String(name||rec.name);
    rec.player.props.Name = rec.name;
    rec.model.props.Name = rec.name;
    rec.player.__charObj = ch;
    rec.player.__charModel = rec.model;
    rec.model.__charObj = ch;
    rec.humanoid.__charObj = ch;
    for (const nm in rec.parts) rec.parts[nm].__charObj = ch;
    assignNetPlayerTeam(id);
    return rec;
  }
  const label = String(name||'Player');
  const player = mkInst('Player', label);
  player.__player = true;
  player.__playerNet = true;
  player.__charObj = ch;
  player.parent = state.playersInst;
  state.playersInst.children.push(player);
  ensureBackpackForPlayer(player);

  const model = mkInst('Model', label);
  model.__character = true;
  model.__playerNet = true;
  model.__charObj = ch;
  model.parent = state.workspaceInst;
  state.workspaceInst.children.push(model);

  const hum = mkInst('Humanoid', 'Humanoid');
  hum.__fakeHumanoid = true;
  hum.__charObj = ch;
  hum.parent = model;
  model.children.push(hum);

  const parts = {};
  for (const nm of ['Torso','Head','Left Arm','Right Arm','Left Leg','Right Leg']){
    const p = mkInst('Part', nm);
    p.__fakeTorso = true;
    p.__charPart = nm;
    p.__charObj = ch;
    p.parent = model;
    model.children.push(p);
    parts[nm] = p;
  }
  const torso = parts['Torso'];
  model.props.PrimaryPart = torso;
  for (const nm of ['Left Leg','Right Leg','Left Arm','Right Arm','Torso','Head'])
    hum.children.push(parts[nm]);

  player.__charModel = model;
  rec = { id, name:label, player, model, humanoid:hum, torso, parts, character:ch };
  state.netPlayers.set(id, rec);
  assignNetPlayerTeam(id);
  try {
    fireEvent(state.playersInst, 'ChildAdded', [wrap(player)]);
    fireEvent(state.playersInst, 'PlayerAdded', [wrap(player)]);
  } catch(_){}
  return rec;
}

function removeNetPlayer(id){
  const rec = state.netPlayers.get(id);
  if (!rec) return;
  state.netPlayers.delete(id);
  const rm = (parent, child) => {
    if (!parent || !child) return;
    const i = parent.children.indexOf(child);
    if (i >= 0) parent.children.splice(i, 1);
    child.parent = null;
  };
  try { fireEvent(state.playersInst, 'PlayerRemoved', [wrap(rec.player)]); } catch(_){}
  rm(state.workspaceInst, rec.model);
  rm(state.playersInst, rec.player);
  rec.player.__charModel = null;
}

/* Humanoid events are the low-level feed the shipped Animate script
 * listens for.  character.js calls this on pose transitions. */function fireHumanoidEvent(name, args){
  if (!state.humanInst) return 0;
  return fireEvent(state.humanInst, name, args||[]);
}

/* ================================================================
 * Instance.new
 * ============================================================== */
function initDefaults(cls, inst){
  if (isPartLike(inst)){
    inst.props.size={x:4, y:1.2, z:2};
    inst.props.shape=1;
    inst.props.CFrame={pos:{x:0,y:70,z:0}, rot:[1,0,0, 0,1,0, 0,0,1]};
    inst.props.Anchored=false;
    inst.props.CanCollide=true;
    inst.props.Transparency=0;
    /* PartInstance property defaults (the runtime descriptors registered by
     * FUN_00772da0..FUN_00773360).  Keep every property present so scripts
     * can read defaults before the first write. */
    inst.props.Reflectance=0;
    inst.props.Locked=false;
    inst.props.CastsShadows=true;
    inst.props.Cullable=true;
    inst.props.DraggingV1=false;
    inst.props.Controller=0;
    inst.props.ControllerFlagShown=true;
    inst.props.Elasticity=0.5;
    inst.props.Friction=0.3;
    inst.props.FormFactor=1;
    inst.props.formFactorRaw=1;
    inst.props.Velocity={x:0,y:0,z:0};
    inst.props.RotVelocity={x:0,y:0,z:0};
    inst.props.archivable=true;
    /* PartInstance ctor defaults (Roblox.exe.c:356583): Top=Studs,
     * Bottom=Inlet, all other faces Smooth; Surface params {0,-0.5,0.5}. */
    for (let i=0;i<SURFACE_FACE_KEYS.length;i++){
      const f=SURFACE_FACE_KEYS[i];
      inst.props[f+'Surface']=SURFACE_DEFAULT[i];
      inst.props[f+'SurfaceInput']=0;
      inst.props[f+'ParamA']=-0.5;
      inst.props[f+'ParamB']=0.5;
    }
    if (cls==='SpawnLocation' && inst.props.TeamColor==null)
      inst.props.TeamColor=194;          /* neutral (Medium stone grey) */
  } else if (cls==='Message'){
    inst.props.Text='';
  } else if (cls==='Hint'){
    inst.props.Text='';
  } else if (cls==='Team'){
    inst.props.TeamColor=194;            /* Medium stone grey */
    inst.props.AutoAssignable=true;
    inst.props.Score=0;
  } else if (cls==='Explosion'){
    inst.props.BlastRadius=4;
    inst.props.BlastPressure=500000;
  } else if (cls==='Sound'){
    inst.props.Volume=0.5;
    inst.props.PlayOnRemove=false;
  } else if (/^(Number|Int)Value$/.test(cls)){
    inst.props.Value=0;
  } else if (cls==='BoolValue'){
    inst.props.Value=false;
  } else if (cls==='StringValue'){
    inst.props.Value='';
  } else if (cls==='Script'||cls==='LocalScript'){
    inst.props.Source='';
  } else if (cls==='BodyVelocity'||cls==='BodyPosition'){
    /* era movers serialize their props lowercase; the engine BodyPosition
     * ctor defaults are P=10000, D=1250 (the PD law dynamics.js applies) */
    inst.props.velocity={x:0,y:0,z:0};
    inst.props.maxForce={x:0,y:0,z:0};
    inst.props.position={x:0,y:0,z:0};
    inst.props.Position=inst.props.position;
    if (cls==='BodyPosition'){ inst.props.P=10000; inst.props.D=1250; }
  } else if (cls==='BodyForce'){
    /* RBX::BodyForce  constant force (GoButton cars write lowercase force) */
    inst.props.force={x:0,y:0,z:0};
  } else if (cls==='BodyThrust'){
    /* RBX::BodyThrust: force applied at Location, both in assembly-local
     * axes.  The legacy serialization uses lowercase force/location. */
    inst.props.Force={x:0,y:0,z:0};
    inst.props.Location={x:0,y:0,z:0};
    inst.props.force={x:0,y:0,z:0};
    inst.props.location={x:0,y:0,z:0};
  } else if (cls==='ShirtGraphic'||cls==='Shirt'){
    /* decomp: ShirtGraphic : CharacterAppearance carries TextureId;
     * Shirt : ShirtGraphic adds BrickColor.  The T-shirt is one texture
     * drawn on the character's torso front. */
    inst.props.TextureId='';
    if (cls==='Shirt') inst.props.BrickColor=(inst.props.BrickColor!=null)? inst.props.BrickColor : 194;
  } else if (cls==='BodyGyro'){
    inst.props.maxTorque={x:0,y:0,z:0};
  } else if (cls==='Tool'){
    /* Tool ctor defaults: Grip is the canonical CFrame property (the four
     * Grip* vector properties are views; see toolGripCF above). */
    setToolGrip(inst, {pos:{x:0,y:0,z:0}, rot:[1,0,0, 0,1,0, 0,0,1]});
    inst.props.RequiresHandle=true;
    inst.props.CanBeDropped=true;
  } else if (cls==='HopperBin'){
    inst.props.BinType=0;
  } else if (cls==='Weld'||cls==='Glue'||cls==='Motor'||cls==='RotateP'||cls==='RotateV'||cls==='Snap'||cls==='Motor6D'){
    inst.props.Part0=null;
    inst.props.Part1=null;
    inst.props.C0=cfIdentity();
    inst.props.C1=cfIdentity();
    if (cls==='Motor'){
      inst.props.MaxVelocity=0.15;
      inst.props.DesiredAngle=0;
      inst.props.CurrentAngle=0;
    }
  } else if (/Value$/.test(cls)){
    inst.props.Value=null;
  }
}
function instanceNew(cls, parentW){
  cls=String(cls);
  if (!cls) throw new L.LuaThrow('Instance.new requires a class name');
  const inst=mkInst(cls, cls);
  initDefaults(cls, inst);
  if (parentW!==undefined&&parentW!==null) reparent(inst, unwrap(parentW));
  return wrap(inst);
}

/* constructor tables */
const INSTANCE_T={ [MT]:{ __index(args){
  const k=String(args[1]);
  if (k==='new'||k==='New') return [mkM(a=>[instanceNew(String(a[0]), a[1])])];
  return [undefined];
}}};
const V3T={ [MT]:{ __index(args){
  if (String(args[1])==='new') return [mkM(a=>[V3(ton(a[0]), ton(a[1]), ton(a[2]))])];
  return [undefined];
}}};
/* CFrame.new(pos, lookAt)  the 2007 constructor builds a basis whose
 * LookVector points from pos at lookAt (LookVector = -col3). */
function lookCF(pos, target){
  const p=vec3Read(pos)||{x:0,y:0,z:0};
  const t=vec3Read(target);
  let dx=0,dy=0,dz=-1;
  if (t){ dx=t.x-p.x; dy=t.y-p.y; dz=t.z-p.z; }
  let len=Math.hypot(dx,dy,dz);
  if (len<1e-8){ dx=0; dy=0; dz=-1; len=1; }
  const look={x:dx/len,y:dy/len,z:dz/len};
  const up=(Math.abs(look.y)>0.999)? {x:1,y:0,z:0} : {x:0,y:1,z:0};
  /* right = look × up, back = -look, up = back × right */
  let rx=look.y*up.z-look.z*up.y;
  let ry=look.z*up.x-look.x*up.z;
  let rz=look.x*up.y-look.y*up.x;
  len=Math.hypot(rx,ry,rz)||1; rx/=len; ry/=len; rz/=len;
  const bx=-look.x, by=-look.y, bz=-look.z;
  const ux=by*rz-bz*ry, uy=bz*rx-bx*rz, uz=bx*ry-by*rx;
  /* row-major with columns right/up/back */
  return CF(p, [rx,ux,bx, ry,uy,by, rz,uz,bz]);
}
const CFT={ [MT]:{ __index(args){
  if (String(args[1])==='new') return [mkM(a=>{
    if (a.length>=2&&vec3Read(a[0])&&vec3Read(a[1]))
      return [lookCF(a[0], a[1])];
    /* CFrame.new(x,y,z, R00..R22)  the 12-number exact-frame form several
     * shipped scripts use; the old constructor silently dropped rotation */
    if (a.length>=12){
      const rot=[];
      for (let i=3;i<12;i++) rot.push(ton(a[i]));
      return [CF({x:ton(a[0]),y:ton(a[1]),z:ton(a[2])}, rot)];
    }
    if (a.length>=3&&typeof a[0]==='number')
      return [CF({x:ton(a[0]),y:ton(a[1]),z:ton(a[2])}, [1,0,0, 0,1,0, 0,0,1])];
    const o=a[0];
    if (o&&o.pos!==undefined&&o.rot!==undefined)
      return [CF({x:o.pos.x||0,y:o.pos.y||0,z:o.pos.z||0}, o.rot||undefined)];
    const p=vec3Read(o);
    if (p) return [CF(p)];
    return [CF({x:0,y:0,z:0})];
  })];
  return [undefined];
}}};
const C3T={ [MT]:{ __index(args){
  const k=String(args[1]);
  if (k==='new') return [mkM(a=>[Color3(ton(a[0]), ton(a[1]), ton(a[2]))])];
  if (k==='fromRGB') return [mkM(a=>[Color3(ton(a[0])/255, ton(a[1])/255, ton(a[2])/255)])];
  return [undefined];
}}};
/* BrickColor preset constructors (BrickColor.Red()/White()/…  the shipped
 * harvester pump script uses them).  The decomp's preset id literals were not
 * recovered, so each maps to the shipped 2007 palette entry of that name
 * (APPROX: chosen by palette name, the era's canonical colors). */
const BC_PRESETS={
  red:['bright red','really red'],
  green:['dark green','bright green'],
  blue:['bright blue','really blue'],
  yellow:['bright yellow','cool yellow'],
  white:['white','institutional white'],
  black:['black','really black'],
  gray:['medium stone grey','grey'],
  grey:['medium stone grey','gray'],
  brown:['brown','reddish brown'],
  orange:['br. yellowish orange','bright orange'],
  pink:['pink','light reddish violet'],
  purple:['bright reddish violet','bright violet'],
};
function bcPreset(name){
  const wanted=BC_PRESETS[name.toLowerCase()];
  if (!wanted) return null;
  for (const nm of wanted){
    for (const e of paletteEntries()){
      if (e && e.name.toLowerCase()===nm) return BrickColor(e.id);
    }
  }
  return null;
}
const BCT={ [MT]:{ __index(args){
  const k=String(args[1]);
  if (k==='new') return [mkM(a=>{
    /* BrickColor.new(r,g,b) is used by the shipped FireShot script; map it
     * to the nearest palette entry so BrickColor.Color still round-trips. */
    if (a.length>=3 && typeof a[0]==='number' && typeof a[1]==='number' && typeof a[2]==='number'){
      const rgb=[Math.round(a[0]*255),Math.round(a[1]*255),Math.round(a[2]*255)];
      return [BrickColor(matchBrickColorId(rgb))];
    }
    return [BrickColor(a.length? a[0] : 2)];
  })];
  /* BrickColor.Red()/White()/Random()/… preset constructors */
  if (k==='Random'||k==='random'){
    return [mkM(()=>{
      const pal=paletteEntries();
      return [BrickColor(pal.length? pal[Math.floor(Math.random()*pal.length)].id : 2)];
    })];
  }
  if (BC_PRESETS[k.toLowerCase()]){
    return [mkM(()=>{ const b=bcPreset(k); return [b||BrickColor(2)]; })];
  }
  return [undefined];
}}};

/* ================================================================
 * script launching  one isolated env each (classic 2007 semantics)
 * ============================================================== */
function applyBridge(env){
  const G=env.G;
  G.set('game', wrap(state.gameInst));
  G.set('workspace', wrap(state.workspaceInst));
  G.set('Workspace', wrap(state.workspaceInst));
  G.set('Instance', INSTANCE_T);
  G.set('Vector3', V3T);
  G.set('CFrame', CFT);
  G.set('Color3', C3T);
  G.set('BrickColor', BCT);
  G.set('shared', new L.LuaTable());
  G.set('script', wrap(state.gameInst));     /* launchScript overrides */
}

function launchScript(inst, onUnsupported){
  if (inst.__launched) return;
  const src=String(inst.props.Source!==undefined? inst.props.Source : '');
  if (!src.trim()||inst.props.Disabled===true) return;
  inst.__launched=true;
  inst.__env=null;
  const env=L.makeEnv();
  applyBridge(env);
  env.G.set('script', wrap(inst));
  inst.__env=env;
  let prog;
  try {
    prog=L.compile(src);
  } catch (e){
    console.error('[rbxenv] '+sName(inst)+': parse error: '+e.message);
    inst.__launched=false;
    if (onUnsupported){ try { onUnsupported(e); } catch(_){} }
    return;
  }
  const gen=(function*(){
    return (yield* env.execBlock(prog, L.newScope(null)));
  })();
  const fiber=L.sched.launchGen(gen, ()=>{}, onUnsupported||null);
  state.scriptFibers.push({inst, fiber});
  return fiber;
}

/* ================================================================
 * gear spawn from shipped rbxm (tools.js calls this)
 * ============================================================== */
function spawnFromXml(xml, opts){
  opts=opts||{};
  let parsedGear=null;
  try {
    parsedGear=window.RBLXxml.parseRbx(xml);
  } catch (e){
    console.error('[rbxenv] gear rbxm parse failed: '+e.message);
    return null;
  }
  const roots=(parsedGear&&parsedGear.instances)? parsedGear.instances.filter(i=>i&&i.parent==null) : [];
  const made=[];
  for (const r of roots){
    r.parent=state.workspaceInst;
    state.workspaceInst.children.push(r);
    if (opts.cf){
      /* opts.cf poses the model's first part; keep every other part's
       * offset relative to it instead of collapsing a multi-part model. */
      const parts=walkAll(r).filter(isPartLike);
      if (parts.length){
        const pose=cfRec(opts.cf)||cfIdentity();
        const oldRoot=cfRec(parts[0].props.CFrame)||cfIdentity();
        const delta=cfMulCF(pose, cfInverse(oldRoot));
        for (const p of parts) placePart(p, cfMulCF(delta, cfRec(p.props.CFrame)||cfIdentity()));
      }
    }
    attachToWorld(r);
    made.push(r);
  }
  if (opts.velocity){
    for (const r of made)
      for (const p of walkAll(r))
        if (isPartLike(p)) moverRegister(p, opts.velocity);
  }
  return made;
}

/* ================================================================
 * place lifecycle
 * ============================================================== */
function forPlace(parsed, world, ui, character){
  /* a failed/repeated join must not leave the previous place's fibers or
   * looping sounds running under the new DataModel */
  for (const e of state.scriptFibers) if (e.fiber) e.fiber.state='dead';
  for (const inst of Array.from(state.soundHandles.keys())) soundStop(inst);
  if (state.ui&&state.ui.hideSystemMessage) state.ui.hideSystemMessage();
  state.world=world||null;
  state.ui=ui||null;
  state.parsed=parsed||null;
  state.wrapCache=new WeakMap();
  state.wrpInfo=new WeakMap();
  state.signals=new WeakMap();
  state.soundHandles=new Map();
  state.movers=new Set();
  state.watchSet=new Set();
  state.scriptFibers=[];
  state.explosions=[];
  state.pendingExplosions=[];
  state.debris=[];
  state.activeHint=null;
  state.playerTeam=null;
  state.playerTeamColor=null;
  state.teamsReady=false;
  if (state.ui&&state.ui.hideHint) state.ui.hideHint();
  state.activeMessage=null;
  state.mouseRay=null;
  state.poseRev=0;
  mouseState.sig={};
  mouseState.target=null;
  mouseState.leftDown=false;
  mouseState.leftPressed=false;
  mouseState.icon='ArrowCursor.png';
  netAssignParsed(parsed);
  buildGameTree(parsed);
  setCharacter(character);
  syncJointsUnder(state.workspaceInst);
  autoAssignTeams();
  state.teamsReady=true;
  /* saved display objects under Workspace are live on join */
  if (state.workspaceInst){
    for (const it of walkAll(state.workspaceInst)){
      if (it.cls==='Message'){
        if (String(it.props.Text||'').trim()) messageShow(it);
      } else if (it.cls==='Hint'){
        hintShow(it);
      }
    }
  }
  if (window.RBLXdyn) window.RBLXdyn.contactHook=contactTouched;   /* part-vs-part Touched */
  L.sched.onUnhandled=(msg,f,e)=>{ console.error('[rbxenv]', msg); };
}

function launchPlaceScripts(onUnsupported){
  let n=0;
  const ws=state.workspaceInst;
  if (ws){
    /* Only Workspace scripts run at place start.  StarterPack/Backpack gear
     * scripts must wait until the Tool/HopperBin is parented into the
     * character; launching them early leaked connections and made the
     * first equip work by accident while every later equip was dead. */
    for (const it of walkAll(ws)) if (isRunnableScript(it)&&launchScript(it, onUnsupported)) n++;
  }
  return n;
}

window.RBLXenv={
  state,
  forPlace, setCharacter, fireStepped, launchPlaceScripts,
  firePlayerAdded, firePlayerChanged, tickScripts,
  launchScript, instanceNew, spawnFromXml,
  wrap, unwrap, viewLook, rebuild:attachToWorld,
  placePart, mkInst, walkAll, childByName,
  findService, fireEvent, invokeCallback, fireHumanoidEvent,
  netDrain, applyNetPart, createNetPart, netIdOf,
  addNetPlayer, removeNetPlayer,
  updateMouse, mouseDown, mouseUp, keyDown, keyUp, getMouse:()=>MOUSE, mouseHasHandlers,
  getMouseInfo:()=>({target:mouseState.target, hit:mouseState.hit, icon:mouseState.icon,
                     x:mouseState.x, y:mouseState.y, leftDown:mouseState.leftDown}),
  syncCharacterMover, isUnderCharacter, attachToWorld, detachFromWorld, reparent,
  V3, CF, Color3, BrickColor,
  toolGripCF, setToolGrip, toolGripVectors,
  chooseSpawnPad, teamInstances, setPlayerTeam,
};

/* __VAL4__ */
})();

