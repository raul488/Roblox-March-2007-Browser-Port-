/* ============================================================
 * character.js  the player figure (engine LoadCharacter port).
 *
 * The rig is built AT RUNTIME by parsing content/fonts/character.rbxm
 * with the same XML parser used for places  sizes, colors, CFrames,
 * the Head SpecialMesh (MeshType 0 = Head, Scale 1.25) and the decals
 * (face + the "roblox" logo) all come from that file, unmodified.
 *   Verified rig (from the file):
 *     Torso 2x2x1  bc23 (0,3,25.5) top=Studs bottom=Inlet
 *     Head  2x1x1  bc24 (0,4.5,25.5) + SpecialMesh Head scale 1.25
 *     Arms  1x2x1  bc24 (±1.5,3,25.5)
 *     Legs  1x2x1  bc119(±0.5,1,25.5)
 *
 * The three core scripts (loaded by the engine on EVERY character,
 * decomp FUN_0048a940 loads fonts\humanoidSound.rbxm, humanoidHealth
 * .rbxm, humanoidAnimate.rbxm right after character.rbxm) are ported
 * to JS using their literal constants:
 *  - humanoidAnimate:  amplitude*sin(time*frequency)  run 1/9,
 *    idle 0.1/1; MaxVelocity 0.15 walk / 0.5 jump; tool → 1.57
 *  - humanoidSound: uuhhh/splat/swoosh/hit/button one-shots on their
 *    Died/FallingDown/FreeFalling/GettingUp/Jumping event edges, plus
 *    the ONE looped sound, bfsl-minifigfoots1 (sRunning Looped=true
 *    the shipped script loops nothing else)
 *  - humanoidHealth: +0.01*MaxHealth per second until 95% (1.05 check)
 * ============================================================ */
(function(){
"use strict";

function cfmulT(T, c){ /* inv(TorsoCF) * part : R^T*(p-Tpos), R^T*R_p */
  const rx=T.rot, rt=[ rx[0],rx[3],rx[6], rx[1],rx[4],rx[7], rx[2],rx[5],rx[8] ];  // transpose
  const q=c.rot;
  const out=new Array(9);
  for (let i=0;i<3;i++) for (let j=0;j<3;j++){
    out[i*3+j]= rt[i*3]*q[j] + rt[i*3+1]*q[3+j] + rt[i*3+2]*q[6+j];
  }
  const p=c.pos, t=T.pos;
  const dx=p.x-t.x, dy=p.y-t.y, dz=p.z-t.z;
  return { pos:{ x:rt[0]*dx + rt[1]*dy + rt[2]*dz,
                 y:rt[3]*dx + rt[4]*dy + rt[5]*dz,
                 z:rt[6]*dx + rt[7]*dy + rt[8]*dz },
           rot: out };
}
function rotToQuat(r){
  // build three.Matrix4 from row-major 3x3 then decompose rotation
  const m=new THREE.Matrix4().set(
    r[0], r[1], r[2], 0,
    r[3], r[4], r[5], 0,
    r[6], r[7], r[8], 0,
    0,0,0,1);
  const q=new THREE.Quaternion();
  m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return q;
}

/* R6 Motor6D joint offsets in torso-local space (engine makeJoints
 * FUN_005a4490): C0 from the torso centre.  The shoulder joints are at the
 * torso edge (±1, +0.5), not the arm's top centre, so a 90-degree arm
 * raise is flush with the torso top instead of half a stud above and
 * outboard of it.  Hip joints are the leg-top centres; the neck is the
 * torso top.  This is the shipped rig's joint layout, not game data. */
const R6_JOINT={
  'Head':     {x:0,    y:1,   z:0},
  'Right Arm':{x:1,    y:0.5, z:0},
  'Left Arm': {x:-1,   y:0.5, z:0},
  'Right Leg':{x:0.5,  y:-1,  z:0},
  'Left Leg': {x:-0.5, y:-1,  z:0},
};

class Character {
  constructor(scene, world, playerName){
    this.scene=scene;
    this.world=world;
    this.group=new THREE.Group();
    scene.add(this.group);
    this.playerName=playerName||'Player1';
    this.tagColor='#ffffff';          // Team.TeamColor overrides the classic white
    this.parts={};                    // part name -> record
    this.torso=null; this.head=null;
    this.rigReady=false;
    this.health=100; this.maxHealth=100;
    this.alive=true;
    this.pose='Standing';
    this.animTime=0;
    this.lastMoveT=0;
    this.footStepT=0;
    this.toolEquipped=false;
    this.climbing=false;              // physics sets this on a ladder/truss
    this.animateLua=false;            // true once the shipped Animate script runs
    this.walkSpeed=16;                // classic humanoid
    this.jumpVelocity=50;
    this.velocity=new THREE.Vector3(0,0,0);    // set by physics each step
    /* the Motor joints created at load time by engine makeJoints.
     * Their servo dynamics (MaxVelocity chase) drive the animate port
     * exactly like torso children "Right Shoulder" etc. did. */
    this.Motors={
      'Right Shoulder':{ MaxVelocity:0.15, DesiredAngle:0, CurrentAngle:0 },
      'Left Shoulder' :{ MaxVelocity:0.15, DesiredAngle:0, CurrentAngle:0 },
      'Right Hip'     :{ MaxVelocity:0.15, DesiredAngle:0, CurrentAngle:0 },
      'Left Hip'      :{ MaxVelocity:0.15, DesiredAngle:0, CurrentAngle:0 }
    };
    this.joints={};                   // name -> pivot Group
    this.onJumped=null; this.onLanded=null; this.onDeath=null;
    this.sndRun=null; this.sndFall=null;
  }

  halfHeight(){ return 3.0; }        // feet at group.y - 3 (rig verified)

  async load(){
    let text=(window.CORE_ASSETS||{})['fonts/character.rbxm'];
    if (!text){
      const r=await fetch('content/fonts/character.rbxm'); text=await r.text();
    }
    const parsed=window.RBLXxml.parseRbx(text);
    const model=parsed.instances.find(i=>i.cls==='Model');
    if (!model) throw new Error('character.rbxm: no Model');
    const torso=model.findFirst('Torso')||model.children.find(c=>c.cls==='Part');
    const T=torso.props.CFrame;
    for (const part of model.children){
      if (part.cls!=='Part') continue;
      const size=part.props.size;
      const local=cfmulT({pos:T.pos, rot:sqOf(T.rot)}, part.props.CFrame);
      const bcid=part.props.BrickColor;
      const e=window.BrickColorFromId(bcid)||{rgb:[163,163,163]};
      const color=new THREE.Color(e.rgb[0]/255, e.rgb[1]/255, e.rgb[2]/255);
      const sm=part.children.find(c=>c.cls==='SpecialMesh');
      let mesh;
      if (sm && (sm.props.MeshType===0)){
        // built-in HeadMesh  exact decomp mesh (js/headmesh.js); no head
        // file is loaded
        const real=window.RBLXworld.builtHeadGeometry?
          window.RBLXworld.builtHeadGeometry(size, sm.props.Scale||{x:1,y:1,z:1}) : null;
        if (real){
          mesh=new THREE.Mesh(real.geo, new THREE.MeshLambertMaterial({ color }));
          mesh.userData.meshDim=real.dim;
          this.headDesc={ size, scl:sm.props.Scale||{x:1,y:1,z:1}, dim:real.dim, kind:real.kind||'decomp' };
        } else {
          mesh=new THREE.Mesh(window.RBLXworld.headGeometry(size, sm.props.Scale||{x:1,y:1,z:1}),
                              new THREE.MeshLambertMaterial({ color }));
          this.headDesc=null;
        }
      } else {
        /* The rig's parts carry their own surface tokens (the shipped
         * character.rbxm has Studs on the torso/arms/legs tops and Inlet
         * on some bottoms).  Use the same six-face material builder as
         * workspace parts instead of a flat box material.  The HeadMesh
         * branch above is intentionally separate: the shipped Head has
         * TopSurface Smooth(0), so it gets no stud. */
        const rgb=[e.rgb[0]/255,e.rgb[1]/255,e.rgb[2]/255];
        let mat=(this.world&&this.world.materialsForPart)
          ? this.world.materialsForPart(part, size, rgb)
          : new THREE.MeshLambertMaterial({ color });
        /* Character colour/transparency writes must not mutate a world
         * part that happened to share the same material-cache key (the
         * rig now uses world's six-face builder).  Give the rig its own
         * material instances. */
        if (Array.isArray(mat)) mat=mat.map(m=>m&&m.clone?m.clone():m);
        else if (mat&&mat.clone) mat=mat.clone();
        mesh=new THREE.Mesh(new THREE.BoxGeometry(size.x,size.y,size.z), mat);
        this.headDesc=null;
      }
      this._attachDecals(part, mesh, size, sm);
      const name=part.props.Name;
      /* makeJoints port: engine R6 joint layout (see R6_JOINT).  It puts
       * the shoulder joints at the torso edge (±1, +0.5) from the torso
       * centre, not at the arm's top centre, and the hip joints at
       * (±0.5, -1).  This is why a 90-degree arm raise ends flush with the
       * torso instead of half a stud above and outboard of it. */
      const jp=R6_JOINT[name]||null;
      const pivot=new THREE.Group();
      const limb=/Arm|Leg/.test(name);
      if (jp){
        pivot.position.set(jp.x, jp.y, jp.z);
        mesh.position.set(local.pos.x-jp.x, local.pos.y-jp.y, local.pos.z-jp.z);
      } else {
        pivot.position.set(local.pos.x, local.pos.y, local.pos.z);
        mesh.position.set(0, 0, 0);
      }
      if (limb) pivot.rotation.set(0,0,0);
      else pivot.quaternion.copy(rotToQuat(local.rot));
      if (this.torso && name!=='Torso'){
        this.torso.mount.add(pivot);
      } else {
        this.group.add(pivot);
      }
      pivot.add(mesh);
      const rec={ name, mesh, size, pivot, color, brickColor:e, brickColorId:bcid, mount: pivot };
      this.parts[name]=rec;
      if (name==='Torso'){ this.torso=rec; }
      else if (name==='Head'){ this.head=rec; }
      else if (name==='Right Arm') this.joints['Right Shoulder']=pivot;
      else if (name==='Left Arm')  this.joints['Left Shoulder']=pivot;
      else if (name==='Right Leg') this.joints['Right Hip']=pivot;
      else if (name==='Left Leg')  this.joints['Left Hip']=pivot;
    }
    this._addNameTag();
    this._ensureCoreSounds();
    this.rigReady=true;
    return this;
  }

  _attachDecals(part, mesh, size, sm){
    for (const d of part.children){
      if (d.cls!=='Decal' || !d.props.Texture) continue;
      const face=d.props.Face||5;    // Front (verified: both decals are Face=5)
      const content=d.props.Texture;
      const url=content.url||content.binary;
      if (!url) continue;
      if (sm && sm.props.MeshType===0){
        // classic face patch on the front (-Z). The decomp head is a rounded
        // cube; the square face texture has a wide transparent border, so a
        // 1.12×bbox plane gives the 2007 screenshot smiley size. The plane
        // sits just proud of the mesh bbox with a polygon offset to defeat
        // z-fight; it is a flat-plane approximation, not a mesh projection.
        const d=(this.headDesc&&this.headDesc.dim)||null;
        const kind=this.headDesc&&this.headDesc.kind;
        const rx=size.x*0.5*(sm.props.Scale.x||1), ry=size.y*0.5*(sm.props.Scale.y||1), rz=size.z*0.5*(sm.props.Scale.z||1);
        let w, h, z, py;
        if (d && kind==='decomp'){
          // The classic head is the rounded cube from the engine's
          // HeadBuilder.  The decal texture is square with a wide transparent
          // border; 1.12*dim puts the visible smiley at roughly 0.61 x 0.48
          // on the 1.25 head, the size seen in 2007 screenshots.
          w=d.x*1.12; h=d.y*1.12;
          z=-d.z*0.5-0.015;
          py=d.y*0.02;
        } else {
          // file-mesh / legacy fallback sizing
          w=d? d.x*0.62 : rx*1.55;
          h=d? d.y*0.95 : ry*1.6;
          z=-(d? d.z*0.5 : rz*1.02) - 0.015;
          py=d? d.y*0.02 : 0;
        }
        const plane=new THREE.Mesh(
          new THREE.PlaneGeometry(w, h),
          new THREE.MeshLambertMaterial({ map:window.RBLXworld.mkTex(url), transparent:true,
                                          polygonOffset:true, polygonOffsetFactor:-2 }));
        plane.position.set(0, py, z);
        plane.rotation.y=Math.PI;
        mesh.add(plane);
      } else {
        // torso graphic plane on the box front (-Z).  The default decal IS
        // the classic T-shirt slot (the shipped rig's torso logo); a
        // ShirtGraphic.TextureId replaces it (applyTshirt).
        // NOTE: rotation.y=PI alone reads un-mirrored from the front  the
        // old mkTex mirror:true compensation (repeat.x=-1) is what mirrored
        // the logo.
        const w=size.x*0.92, h=size.y*0.92, z=-(size.z*0.5+0.012);
        const plane=new THREE.Mesh(
          new THREE.PlaneGeometry(w, h),
          new THREE.MeshLambertMaterial({ map:window.RBLXworld.mkTex(url), transparent:true }));
        plane.position.set(0, 0, z);
        plane.rotation.y=Math.PI;
        mesh.add(plane);
        if (part.props.Name==='Torso') this.torsoDecal=plane;
      }
    }
  }

  /* ---- ShirtGraphic (decomp RBX::ShirtGraphic : CharacterAppearance,
   * TextureId)  the 2007 T-shirt: one texture drawn on the torso front.
   * A custom shirt REPLACES the default torso decal (the classic logo);
   * null restores it.  Accepts data URLs (start-page browse), content
   * paths and rbxasset:// urls (mkTex maps those). */
  applyTshirt(url){
    if (!this.torsoDecal) return;
    if (!url){
      if (this._defaultTorsoTex!=null){
        this.torsoDecal.material.map=this._defaultTorsoTex;
        this.torsoDecal.material.needsUpdate=true;
        this.torsoDecal.visible=true;
      }
      this.tshirtUrl=null;
      return;
    }
    if (!this._defaultTorsoTex) this._defaultTorsoTex=this.torsoDecal.material.map;
    this.tshirtUrl=url;
    const map=window.RBLXworld.mkTex(url);
    map.wrapS=THREE.RepeatWrapping;          // keep the decal upright
    this.torsoDecal.material.map=map;
    this.torsoDecal.material.transparent=true;
    this.torsoDecal.material.needsUpdate=true;
    this.torsoDecal.visible=true;
  }

  /* Overhead tag  name plus, when damaged, the decomp's billboard health
   * bar (Roblox.exe.c FUN_0060d5f0: bar width = character bounds width/8,
   * height = width/10; "Health" label color = the (0,0,1) palette getter
   * FUN_005007d0; bar fill = the (0,1,0) getter FUN_005007a0). */
  _addNameTag(){
    this.tagCanvas=document.createElement('canvas');
    this.tagCanvas.width=256; this.tagCanvas.height=96;
    this.tagHealthPct=-1;
    this._drawTag();
  }

  _drawTag(){
    const c=this.tagCanvas, g=c.getContext('2d');
    const FONT='"Comic Sans MS","Comic Sans",sans-serif';
    g.clearRect(0,0,c.width,c.height);
    g.font='bold 26px '+FONT;   // comics.fnt  the client's own UI font (decomp :526125)
    g.textAlign='center';
    g.lineWidth=5; g.strokeStyle='rgba(0,0,0,0.9)';
    g.strokeText(this.playerName, 128, 34);
    g.fillStyle=this.tagColor||'#ffffff';          // name color: white or TeamColor
    g.fillText(this.playerName, 128, 34);
    const pct=Math.max(0, Math.min(1, this.health/(this.maxHealth||1)));
    if (pct<0.999){
      // mined literals: bar = character bounds width/8 over heads, height/10
      g.font='bold 16px '+FONT;
      g.fillStyle='#0000ff';                      // "Health" label (FUN_005007d0)
      g.fillText('Health', 128, 58);
      const bw=128, bh=15, bx=128-bw/2, by=64;
      g.fillStyle='rgba(0,0,0,0.75)'; g.fillRect(bx-2, by-2, bw+4, bh+4);
      const fill = pct>0.55? '#00ff00' : (pct>0.25? '#ffff00' : '#ff0000');
      g.fillStyle=fill;                           // fill (FUN_005007a0)
      g.fillRect(bx, by, bw*pct, bh);
    }
    const tex=new THREE.CanvasTexture(c);
    const sp=new THREE.Sprite(new THREE.SpriteMaterial({ map:tex, transparent:true, depthTest:false }));
    sp.scale.set(4,1.5,1);
    sp.position.y=3.8;
    if (this.nameTag){ this.group.remove(this.nameTag); this.nameTag.material.map.dispose(); }
    this.nameTag=sp;
    this.group.add(sp);
  }

  _tagRedraw(){                                   // cheap: only when pct moved
    if (!this.tagCanvas) return;
    const pct=this.health/(this.maxHealth||1);
    if (Math.abs(pct-this.tagHealthPct) > 0.01){ this.tagHealthPct=pct; this._drawTag(); }
  }
  /* Teams: the overhead name uses Player.TeamColor (RBX::Teams behaviour) */
  setTagColor(css){
    if (!css||css===this.tagColor) return;
    this.tagColor=css;
    if (this.rigReady) this._drawTag();
  }

  /* Live Part.CFrame/Position for the fake DataModel limbs.  The pivot is
   * the engine's Motor6D joint (at the torso edge for the shoulders), not
   * the part centre, so read the part mesh  scripts that fire from
   * Head.Position/PrimaryPart.Position need the actual part frame. */
  partWorldCF(name){
    const rec=this.parts[name]||this.torso;
    if (!rec) return {pos:{x:0,y:0,z:0}, rot:[1,0,0,0,1,0,0,0,1]};
    const node=rec.mesh||rec.pivot;
    const p=new THREE.Vector3(), q=new THREE.Quaternion();
    node.getWorldPosition(p);
    node.getWorldQuaternion(q);
    const m=new THREE.Matrix4().makeRotationFromQuaternion(q);
    const e=m.elements;
    return { pos:{x:p.x,y:p.y,z:p.z},
             rot:[e[0],e[4],e[8], e[1],e[5],e[9], e[2],e[6],e[10]] };
  }
  /* A script teleport (Character.Head.CFrame = ...) moves the whole body by
   * the delta, matching the humanoid's rigid root translation. */
  movePartTo(name, target){
    if (!target) return;
    const rec=this.parts[name]||this.torso;
    if (!rec) return;
    const p=new THREE.Vector3();
    (rec.mesh||rec.pivot).getWorldPosition(p);
    this.group.position.x += target.x-p.x;
    this.group.position.y += target.y-p.y;
    this.group.position.z += target.z-p.z;
  }
  setPartTransparency(name, t){
    const rec=this.parts[name]||this.torso;
    if (!rec) return;
    const v=Math.max(0,Math.min(1,Number(t)||0));
    rec.transparency=v;
    const apply=(o, overlay)=>{
      if (!o) return;
      const mats=Array.isArray(o.material)? o.material : [o.material];
      for (const m of mats){
        if (!m) continue;
        /* Decal/face/T-shirt planes carry PNG alpha.  Forcing transparent
         * off when the ghost effect ended made their transparent border
         * render as an opaque black square; overlays keep alpha always. */
        m.transparent=overlay? true : (v>0.001);
        m.opacity=1-v;
        m.needsUpdate=true;
      }
      if (o.isMesh||o.isSprite) o.visible=v<0.999;
    };
    apply(rec.mesh, false);
    for (const c of rec.mesh.children||[]) apply(c, true);
  }
  getPartTransparency(name){
    const rec=this.parts[name]||this.torso;
    return rec&&rec.transparency!=null? rec.transparency : 0;
  }
  setPartColor(name, cl){
    const rec=this.parts[name]||this.torso;
    if (!rec||!cl) return;
    rec.color.setRGB(cl[0],cl[1],cl[2]);
    const mats=Array.isArray(rec.mesh.material)? rec.mesh.material : [rec.mesh.material];
    for (const m of mats){ if (m&&m.color) m.color.setRGB(cl[0],cl[1],cl[2]); }
    if (window.BrickColors&&window.BrickColorFromId){
      const rgb=[Math.round(cl[0]*255),Math.round(cl[1]*255),Math.round(cl[2]*255)];
      // nearest palette id for reads back through Part.BrickColor
      let best=rec.brickColorId, bd=1e18;
      for (const pal of window.BrickColors){
        if (!pal||!pal.rgb) continue;
        const dr=pal.rgb[0]-rgb[0], dg=pal.rgb[1]-rgb[1], db=pal.rgb[2]-rgb[2];
        const d2=dr*dr+dg*dg+db*db;
        if (d2<bd){ bd=d2; best=pal.id; }
      }
      rec.brickColorId=best;
    }
  }

  /* the start-page body-color GUI (startpage.js): recolor limb groups to
   * BrickColor ids. Defaults stay the shipped rig (head/arms 24, torso 23,
   * legs 119); null/malformed config is a no-op. */
  applyBodyColors(cfg){
    if (!cfg) return;
    const groups={ head:['Head'], torso:['Torso'],
                   arms:['Left Arm','Right Arm'], legs:['Left Leg','Right Leg'] };
    for (const key in groups){
      const entry=window.BrickColorFromId(cfg[key]);
      if (!entry||!entry.rgb) continue;
      const cl=[entry.rgb[0]/255, entry.rgb[1]/255, entry.rgb[2]/255];
      for (const nm of groups[key]) this.setPartColor(nm, cl);
    }
  }

  /* Move(time)  literal port; called each Stepped like the script loop
   * (the script samples at 10Hz via `nextTime`, we run at 60Hz  the
   * servo chase dynamics are identical) */
  move(time){
    if (!this.rigReady) return;
    const M=this.Motors;
    const pose=this.pose;
    if (pose==='Jumping'){
      M['Right Shoulder'].MaxVelocity=0.5; M['Left Shoulder'].MaxVelocity=0.5;
      M['Right Shoulder'].DesiredAngle= 3.14; M['Left Shoulder'].DesiredAngle=-3.14;
      M['Right Hip'].DesiredAngle=0; M['Left Hip'].DesiredAngle=0;
    } else if (pose==='FreeFall'){
      M['Right Shoulder'].MaxVelocity=0.5; M['Left Shoulder'].MaxVelocity=0.5;
      M['Right Shoulder'].DesiredAngle= 1; M['Left Shoulder'].DesiredAngle=-1;
      M['Right Hip'].DesiredAngle=0; M['Left Hip'].DesiredAngle=0;
    } else if (pose==='Climbing'){
      /* moveClimb(): the shipped Animate pose  arms raise via the mirrored
       * sweep while physics holds the body on a ladder/truss */
      M['Right Shoulder'].MaxVelocity=0.5; M['Left Shoulder'].MaxVelocity=0.5;
      M['Right Shoulder'].DesiredAngle=-3.14; M['Left Shoulder'].DesiredAngle=3.14;
      M['Right Hip'].DesiredAngle=0; M['Left Hip'].DesiredAngle=0;
    } else {
      M['Right Shoulder'].MaxVelocity=0.15; M['Left Shoulder'].MaxVelocity=0.15;
      let amplitude=0.1, frequency=1;
      if (pose==='Running'){ amplitude=1; frequency=9; }
      const desired=amplitude*Math.sin(time*frequency);
      M['Right Shoulder'].DesiredAngle= desired;
      M['Left Shoulder'].DesiredAngle = desired;
      M['Right Hip'].DesiredAngle     =-desired;
      M['Left Hip'].DesiredAngle      =-desired;
      if (this.toolEquipped) M['Right Shoulder'].DesiredAngle=1.57;   // hasTool()
    }
  }

  _chase(j, dt){
    /* engine Motor servo: CurrentAngle chases DesiredAngle limited by
     * MaxVelocity rad per Stepped tick (60Hz). */
    const speed=j.MaxVelocity;                    // radians per tick
    const d=j.DesiredAngle-j.CurrentAngle;
    j.CurrentAngle += Math.max(-speed, Math.min(speed, d));
    return j.CurrentAngle;
  }

  takeDamage(d){
    this.health=Math.max(0, this.health-d);
    if (this.health<=0 && this.alive) this.die();
  }

  die(){
    this.alive=false;
    this.pose='Dead';
    this.climbing=false;
    if (this.sndRun) this.sndRun.pause();
    this._fallSfxArmed=false;                 /* no swoosh for the corpse */
    window.Sounds.sound('uuhhh.wav', {volume:1});              // humanoidSound: Died → sDied
    if (this.nameTag) this.nameTag.visible=false;
    if (this.onDeath) this.onDeath();
  }

  respawn(){
    this.health=this.maxHealth;
    this.alive=true;
    this.velocity.set(0,0,0);
    this.pose='Standing';
    this.climbing=false;
    this._fallSfxArmed=true;                   /* fresh rig can swoosh again */
    if (this.nameTag) this.nameTag.visible=true;
  }

  /* per-frame driver (fixed 60Hz step) */
  step(dt, input){
    if (!this.rigReady) return;
    this.animTime+=dt;
    /* pose transitions mirror the Animate/Sound event handlers:
     * FreeFalling = !onGround && vy<0        (FreeFall event)
     * Jumping     = just jumped               (Jumping event)
     * Running     = onGround & speed>0       (Running event, speed>0) */
    const v=this.velocity;
    const speed=Math.hypot(v.x, v.z);
    let pose;
    if (!this.alive) pose='Dead';
    else if (this.climbing) pose='Climbing';    // ladder/truss state wins
    else if (!this.onGround){
      pose = (v.y>0)? 'Jumping' : 'FreeFall';    // ascent = Jumping event; descent = FreeFalling
    }
    else pose = (speed>0.1)? 'Running' : 'Standing';  // Animate: speed>0; 0.1 floors physics jitter
    if (pose!==this.pose){
      const prev=this.pose;
      this.pose=pose;
      this._poseSFX(pose, prev);
      /* Climbing's speed arg is the climb rate (the engine's Humanoid
       * Climbing event carries speed; horizontal speed is 0 while on a
       * ladder because the body is snapped to the face) */
      this._fireHumanoidEvent(pose, this.climbing? Math.abs(v.y) : speed);
    }
    /* humanoidSound loops/one-shots, driven per frame with hysteresis  the pose can
     * flap Running↔FreeFall between collision frames on slopes/stairs, and
     * chop-playing loops each flap was the source of the "jump sound spam":
     * footsteps need sustained ground contact.  Death pauses everything:
     * the fall state freezes (v.y stays < -7, airborne), so a dead body
     * must never (re)drive sound. */
    this.gT=this.onGround? (this.gT||0)+dt : 0;
    this.aT=this.onGround? 0 : (this.aT||0)+dt;
    if (this.sndRun){
      if (this.alive && this.onGround && this.gT>0.08 && speed>0.8) this.sndRun.play();
      else this.sndRun.pause();
    }
    /* sFreeFalling: one swoosh per flight  armed on ground contact,
     * fired once when the fall is real (the shipped script's
     * FreeFalling(true) → play() edge; FreeFalling(false) → pause() is
     * implicit: one-shots finish on their own, and death never fires) */
    if (this.onGround){
      this._fallSfxArmed=true;
    } else if (this.alive && !this.climbing && this._fallSfxArmed && this.aT>0.12 && v.y<-7){
      this._fallSfxArmed=false;
      window.Sounds.sound('swoosh.wav', {volume:0.35});
    }
    /* the Animate main loop samples servo targets at 10Hz
     * (`if time > nextTime then move(time); nextTime = time + 0.1`): the
     * per-tick servo chase against those held targets produces the classic
     * stair-lagged robotic swing  recomputing targets every frame would
     * smooth it away and lose the look */
    if (!this.animateLua && this.animTime > (this.animNext||0)){
      this.move(this.animTime);
      this.animNext=this.animTime+0.1;
    }
    /* apply: makeJoints hands the left-side servos a MIRRORED axis, so the
     * world rotation for left limbs is the negated motor angle  same-sign
     * targets then walk contra-laterally like the classic rig */
    this.joints['Right Shoulder'] && (this.joints['Right Shoulder'].rotation.x =  this._chase(this.Motors['Right Shoulder'], dt));
    this.joints['Left Shoulder']  && (this.joints['Left Shoulder'].rotation.x  = -this._chase(this.Motors['Left Shoulder'],  dt));
    this.joints['Right Hip']      && (this.joints['Right Hip'].rotation.x      =  this._chase(this.Motors['Right Hip'],      dt));
    this.joints['Left Hip']       && (this.joints['Left Hip'].rotation.x       = -this._chase(this.Motors['Left Hip'],       dt));
    /* humanoidHealth: +1%/s while alive (loop body ported) */
    this._regen(dt);
    this._tagRedraw();
  }

  _fireHumanoidEvent(pose, speed){
    const E=window.RBLXenv;
    if (!E||!E.fireHumanoidEvent) return;
    switch (pose){
      case 'Running':   E.fireHumanoidEvent('Running', [speed]); break;
      case 'Standing':  E.fireHumanoidEvent('Running', [0]); break;
      /* Jumping is an INPUT event, not a pose edge: the JetPack script
       * toggles on every jump press and its own upward motion must not
       * re-enter Jumping and toggle it back off.  physics.js fires it at the
       * jump input edge.  The remaining state events carry a boolean
       * (humanoidSound's `onState(state, sound)`). */
      case 'FreeFall':  E.fireHumanoidEvent('FreeFalling', [true]); break;
      case 'Climbing':  E.fireHumanoidEvent('Climbing', [speed]); break;  // engine event carries speed
      case 'GettingUp': E.fireHumanoidEvent('GettingUp', [true]); break;
      case 'FallingDown': E.fireHumanoidEvent('FallingDown', [true]); break;
    }
  }

  _poseSFX(pose, prev){
    /* humanoidSound one-shots only here  the looped sounds (sRunning,
     * sFreeFalling) are driven per frame in step() with hysteresis, and
     * the Jumping "button.wav" fires from the jump event (onJumped),
     * not from pose classification, so a flapped airborne estimate can
     * never re-play it. */
    if (pose==='GettingUp') window.Sounds.sound('hit.wav', {volume:0.6});
    if (pose==='FallingDown') window.Sounds.sound('splat.wav', {volume:0.8});
  }

  _ensureCoreSounds(){
    /* shipped humanoidSound.rbxm: ONLY sRunning is Looped=true  every
     * other sound (sDied/sFallingDown/sFreeFalling/sGettingUp/sJumping)
     * is a plain one-shot fired on its Humanoid event edge. The old port
     * made the swoosh a per-frame LOOP, which kept re-play()ing forever
     * once death froze the fall state (v.y<-7, airborne). */
    this.sndRun=window.Sounds.makeLoop('bfsl-minifigfoots1.mp3', {volume:0.3});   // sRunning Looped
    this._fallSfxArmed=true;                                       // sFreeFalling one-shot per flight
  }

  /* the equipped tool's real hand model  BinTypes carry the shipped
   * fonts/<tool>.mesh (GameTool=trowel, Clone=clonewand, Hammer=hammer,
   * Slingshot=slingshot, Rocket=rocketlauncher).  The engine holds a tool
   * at RightArm.CFrame * C0 * Grip^-1 (C0 = CFrame.new(0,-1,0) *
   * CFrame.Angles(-pi/2,0,0); HopperBins have the identity Grip).  The
   * shoulder joint is at the torso edge, so the arm's centre is
   * (0.5,-0.5,0) from it and the hand (arm bottom) is (0.5,-1.5,0).
   * The model goes there with the C0 rotation  no per-tool offsets. */
  setToolVisual(binType){
    if (this.toolMesh){
      /* remove from wherever it was mounted  the old code removed from
       * torso.mount, but the mesh lives on the ARM pivot, so unequip left
       * every held gear floating on the arm forever */
      if (this.toolMesh.parent) this.toolMesh.parent.remove(this.toolMesh);
      this.toolMesh=null;
    }
    if (binType==null) return;
    const built=window.RBLXworld.buildToolModel? window.RBLXworld.buildToolModel(binType) : null;
    if (!built) return;
    const m=new THREE.Mesh(built.geo, built.mat);
    const arm=this.joints['Right Shoulder'];
    if (arm){
      const R=(window.RBLXworld&&window.RBLXworld.TOOL_HAND_ROT)||[1,0,0, 0,0,1, 0,-1,0];
      const mat4=new THREE.Matrix4().set(
        R[0],R[1],R[2],0,
        R[3],R[4],R[5],0,
        R[6],R[7],R[8],0,
        0,0,0,1);
      m.position.set(0.5,-1.5,0);
      m.quaternion.setFromRotationMatrix(mat4);
      arm.add(m);
    } else {
      m.position.set(1.5, -0.8, 0);
      this.torso.mount.add(m);
    }
    this.toolMesh=m;
  }

  _regen(dt){
    /* humanoidHealth: while true do local s=wait(1) ...  accumulate to 1s */
    if (!this.alive || this.health<=0) return;
    if (this.health>=this.maxHealth) return;
    this._regenAcc=(this._regenAcc||0)+dt;
    if (this._regenAcc>=1){
      const s=this._regenAcc; this._regenAcc=0;
      let h=this.health + 0.01*s*this.maxHealth;
      this.health = (h*1.05 < this.maxHealth)? h : this.maxHealth;
    }
  }
}

function sqOf(r){ return r; }   // rotation already row-major

window.RBLXcharacter={ Character };
})();
