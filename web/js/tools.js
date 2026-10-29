/* ============================================================
 * tools.js  HopperBin behaviors port (BinType enum from decomp:
 * 0 Script, 1 GameTool, 2 Grab, 3 Clone, 4 Hammer, 5 Slingshot,
 * 6 Rocket, 7 Laser  line ~395596).
 *
 * ShootTool mining (decomp):
 *   - Rocket spawn:   torso position + dir*5.0  (FUN_005c9230)
 *   - Slingshot:      torso position + dir*3.0, muzzle velocity 85.0
 *                     (0x42AA0000 literal in FUN_005c8f70)
 *   - Rocket.rbxm:    velocity = 7*error each tick (error = tracked
 *                     position − shaft), Touched → Instance.new
 *                     ("Explosion") + remove; flight cap t + 10 - s
 *   - SlingshotPellet.rbxm: damage 8, halve per touch, stop < 0.1,
 *                     ttl = t + 1 - s
 *   - Explosion child on the shaft: PlayOnRemove=true → engine plays
 *     its Sound (collide.wav, volume 1) on remove  ported.
 * ============================================================ */
(function(){
"use strict";

class Explosion {
  constructor(scene, position, radius){
    this.scene=scene; this.radius=radius||4; this.t=0; this.live=true;
    this.mesh=new THREE.Mesh(
      new THREE.SphereGeometry(1, 15, 15),    // decomp draw: gluSphere(q, r, 0xf, 0xf)
      new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, opacity:0.85,
                                    depthWrite:false }));
    this.mesh.position.copy(position);
    this.scene.add(this.mesh);
    this.life=0.55;
  }
  step(dt){
    if (!this.live) return false;
    this.t+=dt;
    const p=Math.min(1, this.t/this.life);
    const r=this.radius*(1-Math.pow(1-p,3));
    this.mesh.scale.setScalar(Math.max(0.01,r));
    this.mesh.material.color.setRGB(1, Math.max(0,1-p*0.9), Math.max(0,1-p));
    this.mesh.material.opacity=0.9*(1-p*0.4)+0.1;
    if (p>=1){
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose(); this.mesh.material.dispose();
      this.live=false;
    }
    return true;
  }
}

/* rocket script port  literal per-tick dynamics */
class Rocket {
  constructor(scene, world, spawnPos, dir){
    this.scene=scene; this.world=world;
    this.pos=spawnPos.clone();
    this.target=spawnPos.clone();          // script: position = shaft.Position
    this.dir=dir.clone().normalize();
    this.t=0; this.maxT=10.0;              // script: d = t + 10.0 - s
    this.alive=true;
    this.mesh=new THREE.Mesh(
      new THREE.BoxGeometry(1,1,4),
      new THREE.MeshLambertMaterial({ color:0xC4281C }));   // BrickColor 23 = red
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1), this.dir);
    this.scene.add(this.mesh);
    this.swoosh=window.Sounds.makeLoop('Rocket whoosh 01.wav', {volume:0.7});
    this.swoosh.play();
    this.smokeT=0;
  }
  step(dt){
    if (!this.alive) return false;
    this.t+=dt;
    /* script.fly(): direction=lookVector; position=position+direction;
       error=position−shaft.Position; shaft.Velocity=7*error
       (Stepped is 1/60 → position advances exactly one stud per tick) */
    this.target.addScaledVector(this.dir, dt*60);
    const vel=this.target.clone().sub(this.pos).multiplyScalar(7);
    this.pos.addScaledVector(vel, dt);
    this.mesh.position.copy(this.pos);
    const q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1), vel.clone().normalize());
    this.mesh.quaternion.slerp(q, 0.5);
    /* Touched port */
    const solid=this.world.raycastBoxes(this.pos, {radius:0.9});
    const selfHit=this.world.character && this.pos.distanceTo(this.world.character.group.position)<2.5 && this.t>0.35;
    if (solid || selfHit || this.t>=this.maxT){
      this.blow(solid);
      return false;
    }
    return true;
  }
  blow(blockedLook){
    // Instance.new("Explosion") + explosion.PlayOnRemove sound on remove
    window.Sounds.sound('collide.wav', {volume:1});
    if (this.swoosh) this.swoosh.pause();
    this.scene.remove(this.mesh);
    this.world.lastExplosion={ pos:this.pos.clone(), radius:4, pressure:500000, hitPart:blockedLook };
  }
}

/* SlingshotPellet script port */
class Pellet {
  constructor(scene, world, spawnPos, dir){
    this.scene=scene; this.world=world;
    this.pos=spawnPos.clone();
    this.velocity=dir.clone().normalize().multiplyScalar(85.0);   // decomp muzzle 85
    this.t=0; this.maxT=1.0;                                      // script ttl
    this.damage=8;
    this.alive=true;
    this.mesh=new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),                         // 2×2×2 ball
      new THREE.MeshLambertMaterial({ color:(function(){
        const e=window.BrickColorFromId(194); return e? new THREE.Color(e.rgb[0]/255,e.rgb[1]/255,e.rgb[2]/255) : new THREE.Color(0.63,0.63,0.63); })() }));
    this.mesh.position.copy(this.pos);
    this.scene.add(this.mesh);
  }
  step(dt){
    if (!this.alive) return false;
    this.t+=dt;
    // pellet part was anchored=false → engine gravity applies
    this.velocity.y+=(-196.2)*dt;
    this.pos.addScaledVector(this.velocity, dt);
    this.mesh.position.copy(this.pos);
    /* Touched port: humanoid hit → hurt(damage)+disconnect;
       else damage/=2, disconnect when < 0.1 */
    for (const h of this.world.humanoidWithin(this.pos, 1.4)){
      if (this.t>0.05){ h.hurt(this.damage); this.die(); return false; }
    }
    if (this.world.raycastBoxes(this.pos, {radius:1})){
      // bounce: reflect up a bit off the face (simple wall bounce)
      const solid=this.world.raycastBoxes(this.pos, {radius:1});
      // knock damage in half against world parts (script semantic)
      this.damage/=2;
      window.Sounds.sound('collide.wav', {volume:0.2});
      if (this.damage<0.1){ this.die(); return false; }
      this.velocity.multiplyScalar(-0.35);
      this.pos.addScaledVector(this.velocity, dt*2);
    }
    if (this.t>=this.maxT){ this.die(); return false; }
    return true;
  }
  die(){ this.alive=false; this.scene.remove(this.mesh); }
}

/* vector readers for parsed/runtime Grip values */
function readVec(v){
  if (!v) return null;
  if (v.pv) return {x:v.pv[0]||0, y:v.pv[1]||0, z:v.pv[2]||0};
  if (typeof v.x==='number') return {x:v.x||0, y:v.y||0, z:v.z||0};
  return null;
}
function vnorm(v){ const l=Math.hypot(v.x,v.y,v.z)||1; return {x:v.x/l,y:v.y/l,z:v.z/l}; }
function vcross(a,b){ return {x:a.y*b.z-a.z*b.y, y:a.z*b.x-a.x*b.z, z:a.x*b.y-a.y*b.x}; }
function vdot(a,b){ return a.x*b.x+a.y*b.y+a.z*b.z; }
/* row-major 3x3 helpers (CFrame.rot is row-major in this port) */
function rotMul(A,B){
  const M=new Array(9);
  for (let i=0;i<3;i++) for (let j=0;j<3;j++)
    M[i*3+j]=A[i*3]*B[j]+A[i*3+1]*B[3+j]+A[i*3+2]*B[6+j];
  return M;
}
function rotAxisAngle(axis, angle){
  const a=vnorm(axis), c=Math.cos(angle), s=Math.sin(angle), t=1-c;
  return [
    t*a.x*a.x+c,   t*a.x*a.y-s*a.z, t*a.x*a.z+s*a.y,
    t*a.x*a.y+s*a.z, t*a.y*a.y+c,   t*a.y*a.z-s*a.x,
    t*a.x*a.z-s*a.y, t*a.y*a.z+s*a.x, t*a.z*a.z+c,
  ];
}
/* dominant signed world axis of a direction (the engine's FUN_005a74d0
 * picks the same nearest axis for the T rotate key) */
function dominantAxis(v){
  const ax=Math.abs(v.x), ay=Math.abs(v.y), az=Math.abs(v.z);
  if (ax>=ay&&ax>=az) return {x:v.x<0?-1:1, y:0, z:0};
  if (ay>=az) return {x:0, y:v.y<0?-1:1, z:0};
  return {x:0, y:0, z:v.z<0?-1:1};
}

class ToolManager {
  constructor(scene, world, camera){
    this.scene=scene; this.world=world; this.camera=camera;
    this.character=null;
    this.activeInst=null; this.activeKind=null;
    this.binType=null; this.toolName=''; this.hasScript=false;
    this.explosions=[]; this.rockets=[]; this.pellets=[];
    this.lastExplosion=null;      // consumed by world.explodeAt in main
    this.coolDown=0;
    this.grabbed=null;
    this.rightGrip=null;          // fake Weld under Right Arm
    this.toolHandle=null;         // Tool.Handle Part instance
    this.toolLook=null;           // live world look for Handle
    this.toolVisual=null;         // THREE object attached to the arm
    this.pendingEquip=null;       // fire Equipped after tool scripts start
    this.lastLeftDown=false;
    this._heldKeys=new Set();     // ignore keyboard auto-repeat for R/T
  }
  setCharacter(ch){ this.character=ch||this.character; }
  /* the shipped gear rbxm files (embedded in coreAssets.js) are run by the
   * Lua translation layer when it owns the live place */
  gearLua(){
    const E=window.RBLXenv;
    if (!E||!window.CORE_ASSETS||!E.state||!E.state.gameInst) return false;
    return !!E.state.world;
  }
  /* row-major 3x3 with LookVector = dir (col3 = -dir); camera-facing basis */
  static dirCF(dir){
    const d=dir.clone().normalize();
    // build any orthonormal right/up for the launch ray
    const up=Math.abs(d.y)>0.9? new THREE.Vector3(1,0,0) : new THREE.Vector3(0,1,0);
    const x=new THREE.Vector3().crossVectors(up, d).normalize();
    const y=new THREE.Vector3().crossVectors(d, x).normalize();
    return [x.x,x.y,x.z, y.x,y.y,y.z, -d.x,-d.y,-d.z];
  }

  /* Tool.Grip CFrame.  The engine's canonical property is the CFrame
   * (decomp "Grip", Tool+0x1ac); GripRight/Up/Forward/Pos are its vector
   * views.  RBLXenv.toolGripCF reads Grip and falls back to the four
   * vectors for old files. */
  static gripCF(tool){
    const E=window.RBLXenv;
    if (E&&E.toolGripCF) return E.toolGripCF(tool);
    const p=tool&&tool.props? tool.props : {};
    if (p.Grip&&p.Grip.pos&&p.Grip.rot)
      return {pos:{x:p.Grip.pos.x||0,y:p.Grip.pos.y||0,z:p.Grip.pos.z||0},
              rot:p.Grip.rot.slice(0,9)};
    const P=readVec(p.GripPos)||{x:0,y:0,z:0};
    let R=readVec(p.GripRight)||{x:1,y:0,z:0};
    let U=readVec(p.GripUp)||{x:0,y:1,z:0};
    let F=readVec(p.GripForward)||{x:0,y:0,z:-1};
    R=vnorm(R); U=vnorm(U); F=vnorm(F);
    let B={x:-F.x,y:-F.y,z:-F.z};
    /* right = up × back, then re-orthogonalise up */
    R=vnorm(vcross(U,B));
    if (!isFinite(R.x)||!isFinite(R.y)||!isFinite(R.z)||Math.hypot(R.x,R.y,R.z)<1e-6)
      R={x:1,y:0,z:0};
    U=vcross(B,R);
    if (Math.hypot(U.x,U.y,U.z)<1e-6) U={x:0,y:1,z:0};
    B=vcross(R,U);
    return {pos:P, rot:[R.x,U.x,B.x, R.y,U.y,B.y, R.z,U.z,B.z],
            R,U,B};
  }

  /* Engine RightGrip C0 (decomp FUN_005d1450): the handle CFrame is
   *   RightArm.CFrame * C0 * Tool.Grip^-1
   * C0 = CFrame.new(0,-1,0) * CFrame.Angles(-pi/2, 0, 0)  the hand is the
   * arm's bottom end (1 stud below the part centre).  The rotation turns
   * the hand frame so the tool's authored +Y runs down the arm and its
   * -Z faces forward (the classic held pose once the arm raises). */
  static HAND_ROT=[1,0,0, 0,0,1, 0,-1,0];

  /* handle CFrame relative to the right-shoulder pivot:
   *   pivot * translate(0.5,-1.5,0) * C0(rot) * Grip^-1
   * The R6 shoulder joint is at the torso edge, so the arm's centre is
   * (0.5,-0.5,0) from it and its bottom end (the hand) another 1 down. */
  _gripLocal(tool){
    const g=ToolManager.gripCF(tool);
    const R=g.rot;
    const P=g.pos;
    /* Grip^-1 translation = -Grip.rotation^T * Grip.position */
    const ix=-(R[0]*P.x + R[3]*P.y + R[6]*P.z);
    const iy=-(R[1]*P.x + R[4]*P.y + R[7]*P.z);
    const iz=-(R[2]*P.x + R[5]*P.y + R[8]*P.z);
    /* C0 rotation applied to the inverse translation: (x,y,z) -> (x,z,-y) */
    const px=0.5+ix, py=-1.5+iz, pz=-iy;
    /* rotation = HAND_ROT * Grip^-1 */
    const invRot=[R[0],R[3],R[6], R[1],R[4],R[7], R[2],R[5],R[8]];
    const rot=rotMul(ToolManager.HAND_ROT, invRot);
    const m=new THREE.Matrix4().set(
      rot[0],rot[1],rot[2],0,
      rot[3],rot[4],rot[5],0,
      rot[6],rot[7],rot[8],0,
      0,0,0,1);
    const quat=new THREE.Quaternion().setFromRotationMatrix(m);
    return { pos:new THREE.Vector3(px,py,pz), quat, grip:g };
  }

  _armInst(){
    const E=window.RBLXenv;
    const model=E&&E.state&&E.state.modelInst;
    if (!model) return null;
    return model.children.find(c=>c.props.Name==='Right Arm')||null;
  }
  _armPivot(){
    return this.character&&this.character.joints? this.character.joints['Right Shoulder'] : null;
  }
  _removeRightGrip(){
    if (this.rightGrip&&this.rightGrip.parent){
      const p=this.rightGrip.parent;
      const i=p.children.indexOf(this.rightGrip);
      if (i>=0) p.children.splice(i,1);
      this.rightGrip.parent=null;
    }
    this.rightGrip=null;
  }
  _makeRightGrip(handle){
    const E=window.RBLXenv;
    if (!E||!E.mkInst) return null;
    this._removeRightGrip();
    const arm=this._armInst();
    if (!arm) return null;
    const weld=E.mkInst('Weld','RightGrip');
    weld.props.Part0=arm;
    weld.props.Part1=handle||null;
    weld.props.C0=E.CF({x:0,y:-1,z:0}, ToolManager.HAND_ROT);
    const g=ToolManager.gripCF(this.activeInst);
    weld.props.C1=E.CF(g.pos, g.rot);
    weld.parent=arm; arm.children.push(weld);
    this.rightGrip=weld;
    if (this.character) this.character.toolEquipped=true;
    return weld;
  }

  _findHandle(tool){
    const E=window.RBLXenv;
    if (!E) return null;
    let h=E.childByName(tool,'Handle');
    if (h&&h.cls==='Part') return h;
    return (tool.children||[]).find(c=>c.cls==='Part')||null;
  }

  _mountTool(tool){
    const E=window.RBLXenv;
    if (!E) return;
    const handle=this._findHandle(tool);
    this.toolHandle=handle;
    if (!handle){ this._makeRightGrip(null); return; }
    const look=E.viewLook(handle);
    if (look){
      look.anchored=true;
      look.canCollide=false;
      const ci=this.world.colliders.indexOf(look);
      if (ci>=0) this.world.colliders.splice(ci,1);
      if (E.state.movers) E.state.movers.delete(look);
      if (window.RBLXdyn&&window.RBLXdyn.detach){ try{ window.RBLXdyn.detach(look); }catch(_){} }
      const arm=this._armPivot();
      const obj=look.obj;
      if (arm&&obj){
        if (obj.parent) obj.parent.remove(obj);
        arm.add(obj);
        const local=this._gripLocal(tool);
        obj.position.copy(local.pos);
        obj.quaternion.copy(local.quat);
        this.toolVisual=obj;
        this.toolLook=look;
      }
      /* every other part of the tool is welded to Handle: keep the
       * instances (scripts can read them) but hide the duplicate render. */
      for (const p of E.walkAll(tool)){
        if (p===handle||p.cls!=='Part') continue;
        const l=E.viewLook(p);
        if (l&&l.obj){ l.obj.visible=false; l.anchored=true; l.canCollide=false; }
      }
    }
    this._makeRightGrip(handle);
  }

  _updateHeldHandleCF(){
    if (!this.toolLook||!this.toolLook.obj) return;
    const obj=this.toolLook.obj;
    const p=new THREE.Vector3(), q=new THREE.Quaternion();
    obj.getWorldPosition(p); obj.getWorldQuaternion(q);
    const m=new THREE.Matrix4().makeRotationFromQuaternion(q), e=m.elements;
    this.toolLook.cf={ pos:{x:p.x,y:p.y,z:p.z},
      rot:[e[0],e[4],e[8], e[1],e[5],e[9], e[2],e[6],e[10]] };
    if (this.toolHandle) this.toolHandle.props.CFrame=this.toolLook.cf;
  }

  _equipBin(inst){
    const E=window.RBLXenv;
    this.binType=('BinType' in inst.props)? Number(inst.props.BinType)||0 : 0;
    this.hasScript=E? E.walkAll(inst).some(c=>(c.cls==='Script'||c.cls==='LocalScript')&&c.props.Disabled!==true) : false;
    /* classic HopperBin selection moves the bin into the character too */
    if (E&&E.state&&E.state.modelInst) E.reparent(inst, E.state.modelInst);
    this._makeRightGrip(null);
    if (this.character){
      this.character.toolEquipped=true;
      /* custom BinType 0 bins draw their own models/effects; only the
       * built-in BinType meshes use the canonical hand model. */
      this.character.setToolVisual && this.character.setToolVisual(this.hasScript? null : this.binType);
    }
    if (E){
      const m=E.getMouse();
      /* The bin's scripts were launched by the reparent above.  Run their
       * main bodies to the first wait BEFORE Selected, so `bin.Selected:
       * connect(onSelected)` exists.  Without this the first equip worked
       * only because StarterPack scripts had been launched at startup, and
       * every unequip/re-equip fired into an empty signal. */
      if (E.tickScripts) E.tickScripts(0);
      E.fireEvent(inst,'Selected',[m]);
      E.invokeCallback(inst,'onSelected',[m]);
    }
    this.coolDown=0.25;
  }

  _equipTool(inst){
    const E=window.RBLXenv;
    this.binType=null;
    this.hasScript=E? E.walkAll(inst).some(c=>(c.cls==='Script'||c.cls==='LocalScript')&&c.props.Disabled!==true) : false;
    if (E&&E.state&&E.state.modelInst){
      E.reparent(inst, E.state.modelInst);      /* scripts start here */
      this._mountTool(inst);
      /* one full frame: the newly launched Tool Script must run its main
       * body (where Equipped:connect lives) before we fire the event. */
      this.pendingEquip={ inst, args:[E.getMouse()], delay:1 };
    }
    if (this.character){
      this.character.toolEquipped=true;
      this.character.setToolVisual && this.character.setToolVisual(null);
    }
  }

  equip(inst, character){
    if (character) this.setCharacter(character);
    if (!inst) return;
    if (this.activeInst===inst) return;
    this.unequip();
    this.activeInst=inst;
    this.activeKind=inst.cls;
    this.toolName=inst.props.Name||inst.cls;
    this.coolDown=0.2;
    this.lastLeftDown=false;
    if (inst.cls==='Tool') this._equipTool(inst);
    else this._equipBin(inst);
  }

  unequip(){
    const E=window.RBLXenv;
    const inst=this.activeInst;
    if (inst&&E){
      const m=E.getMouse();
      if (inst.cls==='Tool'){
        E.fireEvent(inst,'Unequipped',[m]);
        E.invokeCallback(inst,'onUnequipped',[m]);
        this._removeRightGrip();
        const backpack=E.state&&E.state.backpackInst;
        E.reparent(inst, backpack||null);
      } else {
        E.fireEvent(inst,'Deselected',[m]);
        E.invokeCallback(inst,'onDeselected',[m]);
        this._removeRightGrip();
        /* return the HopperBin to the Backpack, like a Tool */
        const backpack=E.state&&E.state.backpackInst;
        E.reparent(inst, backpack||null);
      }
    } else {
      this._removeRightGrip();
    }
    if (this.character){
      this.character.toolEquipped=false;
      this.character.setToolVisual && this.character.setToolVisual(null);
    }
    this.activeInst=null; this.activeKind=null;
    this.binType=null; this.toolName=''; this.hasScript=false;
    this.toolHandle=null; this.toolLook=null; this.toolVisual=null;
    this.pendingEquip=null;
    this.coolDown=0.15;
  }

  _activeEvent(name, args, mouseEvent){
    const E=window.RBLXenv;
    if (!E||!this.activeInst) return;
    E.fireEvent(this.activeInst, name, args||[]);
    /* Shipped HopperBin scripts connect mouse.Button1Down/Up themselves;
     * only fall back to the global onButton1Down if neither the instance
     * event nor the mouse event has a listener (otherwise it double-fires). */
    if (mouseEvent&&E.mouseHasHandlers&&E.mouseHasHandlers(mouseEvent)) return;
    E.invokeCallback(this.activeInst, 'on'+name, args||[]);
  }

  keyDown(key){
    const E=window.RBLXenv;
    if (E) E.keyDown(key);
    const fresh=!this._heldKeys.has(key);
    this._heldKeys.add(key);
    if (fresh && this.grabbed && this.binType===1) this._rotateGrab(key);
    if (this.activeInst){
      const m=E? E.getMouse() : null;
      this._activeEvent('KeyDown', [m, key], 'KeyDown');
    }
  }
  keyUp(key){
    const E=window.RBLXenv;
    this._heldKeys.delete(key);
    if (E) E.keyUp(key);
    if (this.activeInst){
      const m=E? E.getMouse() : null;
      this._activeEvent('KeyUp', [m, key], 'KeyUp');
    }
  }

  /* MoveTool/GameTool rotate keys from PartDragTool (FUN_00604a60):
   *   R -> 90 degrees around world Y
   *   T -> 90 degrees around the world axis nearest the part's RightVector
   * Rotation is around the grabbed part's centre; an assembly rotates as a
   * unit when the drag owns more than one member. */
  _rotateGrab(key){
    const g=this.grabbed;
    if (!g||!g.look||g.look.destroyed) return;
    let axis=null;
    if (key==='r') axis={x:0,y:1,z:0};
    else if (key==='t'){
      const R=g.look.cf.rot;
      axis=dominantAxis({x:R[0], y:R[3], z:R[6]});
    }
    if (!axis) return;
    const Q=rotAxisAngle(axis, Math.PI/2);
    const pivot=g.look.cf.pos;
    const E=window.RBLXenv;
    for (const m of g.members){
      if (!m||m.destroyed||!m.cf) continue;
      const R=m.cf.rot, P=m.cf.pos;
      const rel={x:P.x-pivot.x, y:P.y-pivot.y, z:P.z-pivot.z};
      const np={
        x:pivot.x+Q[0]*rel.x+Q[1]*rel.y+Q[2]*rel.z,
        y:pivot.y+Q[3]*rel.x+Q[4]*rel.y+Q[5]*rel.z,
        z:pivot.z+Q[6]*rel.x+Q[7]*rel.y+Q[8]*rel.z,
      };
      const rot=rotMul(Q,R);
      if (E&&E.placePart) E.placePart(m.part,{pos:np,rot});
      else if (m.obj){
        m.cf={pos:np,rot};
        m.obj.position.set(np.x,np.y,np.z);
        m.obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().set(
          rot[0],rot[1],rot[2],np.x, rot[3],rot[4],rot[5],np.y,
          rot[6],rot[7],rot[8],np.z, 0,0,0,1));
      }
      if (window.RBLXdyn&&window.RBLXdyn._refresh) window.RBLXdyn._refresh(m);
    }
    /* drag offsets are measured from the current poses after a rotation */
    g.starts=g.members.map(m=>({x:m.cf.pos.x, y:m.cf.pos.y, z:m.cf.pos.z}));
    g.offset={x:0,y:0,z:0};
    const n=g.planeN;
    g.planeN={ x:Q[0]*n.x+Q[1]*n.y+Q[2]*n.z,
               y:Q[3]*n.x+Q[4]*n.y+Q[5]*n.z,
               z:Q[6]*n.x+Q[7]*n.y+Q[8]*n.z };
    g.planeP={x:g.look.cf.pos.x, y:g.look.cf.pos.y, z:g.look.cf.pos.z};
    if (window.Sounds) window.Sounds.sound('snap.wav',{volume:0.25});
  }
  /* Face of the dragged part that should meet the target surface: the one
   * whose normal is most nearly opposite the target normal (bottom Inlet on
   * a Top Studs face, for example). */
  _matingFace(look, targetNormal){
    if (!look||!look.cf||!look.size) return null;
    const R=look.cf.rot, h=[look.size.x/2, look.size.y/2, look.size.z/2];
    let best=null;
    for (let axis=0;axis<3;axis++) for (const sign of [1,-1]){
      const n={ x:R[axis]*sign, y:R[3+axis]*sign, z:R[6+axis]*sign };
      const d=vdot(n,targetNormal);
      if (!best||d<best.dot) best={ normal:n, half:h[axis], dot:d };
    }
    return best;
  }

  update(dt, mouse, character){
    const w=this.world;
    if (character) this.setCharacter(character);
    for (let i=this.explosions.length-1;i>=0;i--)
      if (!this.explosions[i].step(dt)) this.explosions.splice(i,1);
    for (let i=this.rockets.length-1;i>=0;i--)
      if (!this.rockets[i].step(dt)) this.rockets.splice(i,1);
    for (let i=this.pellets.length-1;i>=0;i--)
      if (!this.pellets[i].step(dt)) this.pellets.splice(i,1);
    /* process the explosion a rocket registered this tick */
    if (this.lastExplosion){
      const ex=new Explosion(this.scene, this.lastExplosion.pos, this.lastExplosion.radius);
      this.explosions.push(ex);
      w.explodeAt(this.lastExplosion.pos, this.lastExplosion.radius,
                  this.lastExplosion.pressure||500000);
      this.lastExplosion=null;
    }

    const E=window.RBLXenv;
    if (E&&E.updateMouse) E.updateMouse(mouse);
    const mouseW=E? E.getMouse() : null;

    /* Tool scripts are launched when the Tool parents into the character;
     * fire Equipped on the next frame so their main body has connected. */
    if (this.pendingEquip&&E){
      if (this.pendingEquip.delay>0) this.pendingEquip.delay--;
      else {
        const pe=this.pendingEquip; this.pendingEquip=null;
        E.fireEvent(pe.inst,'Equipped',pe.args);
        E.invokeCallback(pe.inst,'onEquipped',pe.args);
      }
    }

    const pressed=!!mouse.leftPressed;
    const down=!!mouse.leftDown;
    if (E){
      if (pressed) E.mouseDown();
      if (this.lastLeftDown&&!down) E.mouseUp();
    }
    if (pressed&&this.activeInst){
      if (this.activeKind==='Tool') this._activeEvent('Activated',[mouseW],'Button1Down');
      else this._activeEvent('Button1Down',[mouseW],'Button1Down');
    }
    if (this.lastLeftDown&&!down&&this.activeInst){
      if (this.activeKind==='Tool') this._activeEvent('Deactivated',[mouseW],'Button1Up');
      else this._activeEvent('Button1Up',[mouseW],'Button1Up');
    }
    this.lastLeftDown=down;
    this._updateHeldHandleCF();

    /* Built-in BinType fallbacks only when the bin has no shipped Script
     * (custom BinType 0 gears run entirely through the Lua layer). */
    if (this.activeKind!=='HopperBin'||this.hasScript) return;
    if (this.coolDown>0){ this.coolDown-=dt; return; }
    if (!this.binType||this.binType===0) return;
    const ray=w.rayFromCamera(mouse.x, mouse.y);
    switch (this.binType){
      /* 6 Rocket  ShootTool port (FUN_005c9230); the shaft comes from the
       * shipped Rocket.rbxm and the script itself drives the 7*error servo */
      case 6:
        if (mouse.leftPressed){
          const o=character.group.position.clone();
          const spawn=o.add(ray.dir.clone().multiplyScalar(5.0));
          if (this.gearLua()){
            const dir=ray.dir.clone().normalize();
            const made=window.RBLXenv.spawnFromXml(window.CORE_ASSETS['fonts/Rocket.rbxm'],
              { cf:{pos:{x:spawn.x,y:spawn.y,z:spawn.z}, rot:ToolManager.dirCF(dir)},
                velocity:{x:dir.x*60, y:dir.y*60, z:dir.z*60} });
            window.Sounds.sound('Shoulder fired rocket.wav', {volume:0.5});
            this.coolDown=3.0;
            if (made) break;
          }
          this.rockets.push(new Rocket(this.scene, w, spawn, ray.dir));
          window.Sounds.sound('Shoulder fired rocket.wav', {volume:0.5});
          this.coolDown=3.0;
        }
        break;
      /* 5 Slingshot  ShootTool port (FUN_005c8f70); muzzle 85 from decomp */
      case 5:
        if (mouse.leftPressed){
          const o=character.group.position.clone();
          const spawn=o.add(ray.dir.clone().multiplyScalar(3.0));
          if (this.gearLua()){
            const dir=ray.dir.clone().normalize();
            const made=window.RBLXenv.spawnFromXml(window.CORE_ASSETS['fonts/SlingshotPellet.rbxm'],
              { cf:{pos:{x:spawn.x,y:spawn.y,z:spawn.z}, rot:ToolManager.dirCF(dir)},
                velocity:{x:dir.x*85, y:dir.y*85, z:dir.z*85} });
            window.Sounds.sound('Rubber band sling shot.wav', {volume:0.55});
            this.coolDown=0.45;
            if (made) break;
          }
          this.pellets.push(new Pellet(this.scene, w, spawn, ray.dir));
          window.Sounds.sound('Rubber band sling shot.wav', {volume:0.55});
          this.coolDown=0.45;
        }
        break;
      /* 7 Laser  classic tracer feed */
      case 7:
        if (mouse.leftPressed){
          const hit=w.rayHit(ray.origin, ray.dir, 400);
          const end=hit? hit.hit : ray.origin.clone().addScaledVector(ray.dir, 400);
          const geo=new THREE.BufferGeometry().setFromPoints([character.group.position.clone().setY(character.group.position.y+1), end]);
          const line=new THREE.Line(geo, new THREE.LineBasicMaterial({ color:0xff3010, transparent:true, opacity:0.85 }));
          this.scene.add(line);
          const f=setTimeout(()=>{ this.scene.remove(line); geo.dispose(); }, 120);
          window.Sounds.sound('flashbulb.wav', {volume:0.45});
          this.coolDown=1.1;
        }
        break;
      /* 3 Clone  classic clonewand: duplicate part under cursor */
      case 3:
        if (mouse.leftPressed){
          const pick=w.pickPartRaw(ray);
          if (pick){
            const p=pick.look.part;
            const clone={
              cls:'Part', ref:null, parent:null, children:p.children.slice(), props:Object.assign({}, p.props)
            };
            const s=p.props.size;
            clone.props.CFrame={ pos:{ x:p.props.CFrame.pos.x, y:p.props.CFrame.pos.y+ (s? s.y/2+1:1), z:p.props.CFrame.pos.z },
                                 rot:p.props.CFrame.rot.slice() };
            w.buildPart(clone);
            window.Sounds.sound('snap.wav', {volume:0.5});
          }
          this.coolDown=0.4;
        }
        break;
      /* 4 Hammer  classic destruct tool */
      case 4:
        if (mouse.leftPressed){
          const pick=w.pickPartRaw(ray);
          if (pick){
            w.destroyPart(pick.look.part);
            window.Sounds.sound('snap.wav', {volume:0.65});
            window.Sounds.sound('collide.wav', {volume:0.35});
          }
          this.coolDown=0.3;
        }
        break;
      /* 1 GameTool / 2 Grab  the classic 2007 in-game dragger (Happy
         Home's GameTool BinType 1 is this tool; it is the original
         PartDragTool).  The engine gate is Locked, not Anchored and not
         assembly size: a house is one giant anchored weld cluster, and the
         2007 tool still picks a single brick out of it.
         - GameTool (BinType 1): one part, surface snapped to the face under
           the cursor, 1-stud grid on that face, R/T rotate in 90-degree
           steps.  Placing a bottom Inlet onto a Top Studs face is flush, so
           the normal AutoJoin flood welds them on release.
         - Grab (BinType 2): keeps the old whole-assembly drag for loose
           builds so welds/hinges survive, falling back to a single part for
           static/huge clusters. */
      case 1: case 2: {
        const gameTool=(this.binType===1);
        if (mouse.leftPressed){
          const pick=w.pickPartRaw(ray);
          if (pick){
            if (pick.look.part.props.Locked===true){
              /* FUN_005ccce0: a Locked part is not draggable */
              window.Sounds.sound('clickfast.wav', {volume:0.2});
            } else {
              const P=pick.look.cf.pos;
              const face=w.partFaceAt(pick.look, {x:pick.hit.x, y:pick.hit.y, z:pick.hit.z});
              const planeN=face? face.normal : {x:0,y:1,z:0};
              const dyn=window.RBLXdyn;
              const asm=(dyn&&dyn._ready&&dyn.asmMap.get(pick.look))||null;
              let single=true, members=[pick.look];
              if (asm&&!asm.destroyed&&!asm.static&&asm.members.length<=64){
                members=asm.members.filter(m=>!m.destroyed);
                single=members.length===1;
              }
              /* click offset inside the drag plane, so the part does not
               * jump its centre under the cursor on the first move */
              const den=vdot(ray.dir,planeN);
              let off={x:0,y:0,z:0};
              if (Math.abs(den)>1e-6){
                const t=vdot({x:P.x-ray.origin.x,y:P.y-ray.origin.y,z:P.z-ray.origin.z},planeN)/den;
                if (t>0){
                  off={
                    x:P.x-(ray.origin.x+ray.dir.x*t),
                    y:P.y-(ray.origin.y+ray.dir.y*t),
                    z:P.z-(ray.origin.z+ray.dir.z*t),
                  };
                }
              }
              this.grabbed={
                look:pick.look, gameTool, single, members,
                starts:members.map(m=>({x:m.cf.pos.x, y:m.cf.pos.y, z:m.cf.pos.z})),
                planeN, planeP:{x:P.x,y:P.y,z:P.z}, offset:off,
                exclude:new Set(members),
                startMouse:{x:mouse.x, y:mouse.y},
              };
            }
          }
        } else if (mouse.leftDown && this.grabbed){
          const g=this.grabbed;
          let np=null;
          /* A stationary cursor must not immediately surface-snap the part
           * down through its own old position; wait for a real drag. */
          const moved=Math.hypot(mouse.x-g.startMouse.x, mouse.y-g.startMouse.y)>3;
          if (g.gameTool&&g.single&&moved){
            /* surface snap: place the anti-parallel face on the hit face */
            const targ=w.rayHit(ray.origin, ray.dir, 1000, g.exclude);
            if (targ&&targ.look&&targ.look!==g.look){
              const tf=w.partFaceAt(targ.look, {x:targ.hit.x, y:targ.hit.y, z:targ.hit.z});
              const mate=tf&&this._matingFace(g.look, tf.normal);
              if (tf&&mate){
                np={
                  x:targ.hit.x-mate.normal.x*mate.half,
                  y:targ.hit.y-mate.normal.y*mate.half,
                  z:targ.hit.z-mate.normal.z*mate.half,
                };
                /* make the mating face's plane coincide with the target's */
                const fc={
                  x:np.x+mate.normal.x*mate.half,
                  y:np.y+mate.normal.y*mate.half,
                  z:np.z+mate.normal.z*mate.half,
                };
                const corr=vdot(tf.normal,{x:tf.center.x-fc.x, y:tf.center.y-fc.y, z:tf.center.z-fc.z});
                np.x+=tf.normal.x*corr; np.y+=tf.normal.y*corr; np.z+=tf.normal.z*corr;
                /* 1-stud lattice in the TARGET FACE's own tangent basis, so
                 * rotated walls snap to their stud lines too */
                const A=targ.look.cf.rot;
                const i1=(tf.axis+1)%3, i2=(tf.axis+2)%3;
                const u={x:A[i1], y:A[3+i1], z:A[6+i1]};
                const v={x:A[i2], y:A[3+i2], z:A[6+i2]};
                const dx=np.x-tf.center.x, dy=np.y-tf.center.y, dz=np.z-tf.center.z;
                const du=dx*u.x+dy*u.y+dz*u.z;
                const dv=dx*v.x+dy*v.y+dz*v.z;
                const su=Math.round(du)-du, sv=Math.round(dv)-dv;
                np.x+=u.x*su+v.x*sv; np.y+=u.y*su+v.y*sv; np.z+=u.z*su+v.z*sv;
                /* a hair outside the target prevents z-fighting; AutoJoin
                 * still sees a flush (<=0.05) Studs/Inlet pair */
                np.x+=tf.normal.x*0.0005; np.y+=tf.normal.y*0.0005; np.z+=tf.normal.z*0.0005;
              }
            }
            if (!np){
              /* free drag in the plane of the clicked face, 1-stud grid */
              const den=vdot(ray.dir,g.planeN);
              if (Math.abs(den)>1e-6){
                const t=vdot({x:g.planeP.x-ray.origin.x, y:g.planeP.y-ray.origin.y,
                              z:g.planeP.z-ray.origin.z},g.planeN)/den;
                if (t>0){
                  np={x:ray.origin.x+ray.dir.x*t+g.offset.x,
                      y:ray.origin.y+ray.dir.y*t+g.offset.y,
                      z:ray.origin.z+ray.dir.z*t+g.offset.z};
                  const pn=[Math.abs(g.planeN.x),Math.abs(g.planeN.y),Math.abs(g.planeN.z)];
                  const pAxis=(pn[0]>=pn[1]&&pn[0]>=pn[2])?0:(pn[1]>=pn[2]?1:2);
                  if (pAxis!==0) np.x=Math.round(np.x);
                  if (pAxis!==1) np.y=Math.round(np.y);
                  if (pAxis!==2) np.z=Math.round(np.z);
                }
              }
            }
            if (np){
              if (window.RBLXenv&&window.RBLXenv.placePart)
                window.RBLXenv.placePart(g.look.part, {pos:np, rot:g.look.cf.rot});
              if (window.RBLXdyn&&window.RBLXdyn._refresh) window.RBLXdyn._refresh(g.look);
              g.starts=[{x:np.x,y:np.y,z:np.z}];
              g.planeP={x:np.x,y:np.y,z:np.z};
              g.offset={x:0,y:0,z:0};
            }
          } else {
            /* loose assembly drag: keep every member's original offset */
            const pickIdx=g.members.indexOf(g.look);
            const anchor=g.starts[pickIdx>=0? pickIdx : 0];
            const denom=ray.dir.y;
            if (Math.abs(denom)>1e-6){
              const t=(anchor.y-ray.origin.y)/denom;
              if (t>0){
                const flat=ray.origin.clone().addScaledVector(ray.dir,t);
                const dx=flat.x-g.offset.x-anchor.x, dz=flat.z-g.offset.z-anchor.z;
                const dyn=window.RBLXdyn;
                for (let i=0;i<g.members.length;i++){
                  const m=g.members[i];
                  if (m.destroyed) continue;
                  const np2={ x:g.starts[i].x+dx, y:g.starts[i].y, z:g.starts[i].z+dz };
                  if (window.RBLXenv&&window.RBLXenv.placePart)
                    window.RBLXenv.placePart(m.part, { pos:np2, rot:m.cf.rot });
                  else if (m.obj) m.obj.position.set(np2.x, np2.y, np2.z);
                  if (dyn&&dyn._refresh) dyn._refresh(m);   // grid cells follow
                }
              }
            }
          }
        }
        if (!mouse.leftDown){
          if (this.grabbed){
            /* release: the joint graph re-floods so the dragged part bonds
               to whatever faces it now touches (flush Studs/Inlet pair) */
            if (window.RBLXdyn&&window.RBLXdyn.markDirty) window.RBLXdyn.markDirty();
            this.grabbed=null;
          }
        }
        break;
      }
    }
  }
}

/* interpreter-first: each gear fires the shipped rbxm + Script through
 * the Lua translation layer; the classes above stay as the fallback. */
window.RBLXtools={ ToolManager, Explosion, Rocket, Pellet };
})();
