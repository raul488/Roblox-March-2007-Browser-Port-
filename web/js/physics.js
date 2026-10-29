/* ============================================================
 * physics.js  Humanoid kinematic solver.
 * The classic Humanoid ran a custom kinematic stepper: gravity
 * 196.2 studs/s², walkspeed 16, jump impulse 50 (canonical 2007
 * values  see PORT.md), axis-separated AABB sweeps with auto
 * step-up onto 2-stud ledges. World colliders come from the
 * parsed place (world.colliders), never approximated by hand.
 * ============================================================ */
(function(){
"use strict";

class Humanoid {
  constructor(character, world){
    this.c=character;
    this.world=world;
    this.onGround=false;
    this.stepHeight=2.3;       // easy walk-up over 2-stud borders like the classic rig
    this.walkSpeed=16;
    this.jumpPower=50;
    this.gravity=-196.2;
    this.friction=0.3;         // mined surface friction uniform value
    this.wasLeftReleased=false;
    this.jumpLatch=false;
    this.jumping=false;
    this.jumpTime=0;           // Jumping state safety window (decomp ~0.5 s)
    /* Climbing (ladders/trusses)  a real state, not the 2007 quirk.
     * The mined rate is 0.7 × WalkSpeed: FUN_005e9b90 sets
     * vy = sqrt(vx²+vy²+vz²)·0.7 (:477260-477268); 0.7f lives at VA
     * 0x7a03d0 and WalkSpeed 16.0f at 0x7ad42c. The original triggered it
     * from a downward "ground ahead" ray (FUN_005e96b0, 0.8·size long,
     * :477019), which chained only while rung gaps stayed under ~1.2 studs;
     * this port attaches to a whole ladder volume instead. */
    this.climbing=false;
    this.climbVol=null;
    this.climbN={x:0,z:0};
    this.climbSpeed=this.walkSpeed*0.7;
  }
  /* velocity is owned by the character (scripts read/write it
   * the pads' Torso.Velocity=(0,200,0) port writes straight to it) */
  get velocity(){ return this.c.velocity; }

  /* the character collision box, torso-relative (from the real rig:
   * torso 2x2x1 centered at 0; arms at ±1.5 (1 wide → ±2);
   * legs bottom at torso_y-3; head top at torso_y+2 (+ SpecialMesh) */
  /* body band (vertical): legs bottom to head top */
  viewBox(){
    const p=this.c.group.position;
    return { min:{x:p.x-2.02, y:p.y-3.0, z:p.z-0.55},
             max:{x:p.x+2.02, y:p.y+2.1,  z:p.z+0.55} };
  }

  /* ---- horizontal collisions are genuinely ORIENTED ----
   * The rig rotates to face the walk direction, so the fat ±2.02 arm span
   * must never sit IN FRONT of the torso (the old world-axis box made the
   * character stop well before walls when walking along X). The footprint
   * is a yawed box (forward 0.72 = torso 0.5 + margin, sideways 1.06) and
   * parts are tested as oriented boxes too  rotated walls no longer block
   * at their fat enclosing AABB. 2D SAT over the four box axes. */
  _basis(yaw){
    const cy=Math.cos(yaw), sy=Math.sin(yaw);
    return { fx:-sy, fz:-cy, rx:cy, rz:-sy };   /* rig front = local −Z */
  }
  yawBox(){
    const p=this.c.group.position, B=this._basis(this.c.group.rotation.y||0);
    const k={ cx:p.x, cz:p.z, fx:B.fx, fz:B.fz, rx:B.rx, rz:B.rz,
              hf:0.72, hs:1.06, yLo:p.y-3.0, yHi:p.y+2.1 };
    k.ex=k.hf*Math.abs(k.fx)+k.hs*Math.abs(k.rx);   /* world AABB half-extents */
    k.ez=k.hf*Math.abs(k.fz)+k.hs*Math.abs(k.rz);
    return k;
  }
  _sat2(A, B){
    const axes=[[A.fx,A.fz],[A.rx,A.rz],[B.fx,B.fz],[B.rx,B.rz]];
    for (const u of axes){
      const eA=A.hf*Math.abs(A.fx*u[0]+A.fz*u[1])+A.hs*Math.abs(A.rx*u[0]+A.rz*u[1]);
      const eB=B.hf*Math.abs(B.fx*u[0]+B.fz*u[1])+B.hs*Math.abs(B.rx*u[0]+B.rz*u[1]);
      if (Math.abs((A.cx-B.cx)*u[0]+(A.cz-B.cz)*u[1]) > eA+eB) return false;
    }
    return true;
  }
  _satPen(A, B){                 /* smallest-penetration SAT axis → push */
    const axes=[[A.fx,A.fz],[A.rx,A.rz],[B.fx,B.fz],[B.rx,B.rz]];
    let best=1e9, bx=0, bz=0;
    for (const u of axes){
      const eA=A.hf*Math.abs(A.fx*u[0]+A.fz*u[1])+A.hs*Math.abs(A.rx*u[0]+A.rz*u[1]);
      const eB=B.hf*Math.abs(B.fx*u[0]+B.fz*u[1])+B.hs*Math.abs(B.rx*u[0]+B.rz*u[1]);
      const sep=(A.cx-B.cx)*u[0]+(A.cz-B.cz)*u[1];
      const pen=eA+eB-Math.abs(sep);
      if (pen<0) return null;
      if (pen<best){ best=pen; const s=sep<0?-1:1; bx=u[0]*s; bz=u[1]*s; }
    }
    return { pen:best, ux:bx, uz:bz };
  }
  /* a part whose local Y axis is not world-vertical (a hinged ramp, a
   * toppled slab).  Yaw-only parts stay on the cheap AABB-top path. */
  _tilted(o){
    const rot=(o.cf&&o.cf.rot)||o.rot;
    if (!rot) return false;
    return Math.abs(rot[4]) < 0.999;
  }
  /* vertical ray (world +Y) through a part at (x,z): returns the world-y
   * span [min,max] of the box along that line, or null if it misses.
   * Slab test in the part's local frame (rows of rot map local→world). */
  _boxRaySpan(o, x, z){
    const rot=(o.cf&&o.cf.rot)||o.rot;
    if (!rot){
      const a=o.aabb;
      if (x<a.min.x||x>a.max.x||z<a.min.z||z>a.max.z) return null;
      return { min:a.min.y, max:a.max.y };
    }
    const P=(o.cf&&o.cf.pos)||{ x:(o.aabb.min.x+o.aabb.max.x)/2,
                                y:(o.aabb.min.y+o.aabb.max.y)/2,
                                z:(o.aabb.min.z+o.aabb.max.z)/2 };
    const s=o.size||{ x:o.aabb.max.x-o.aabb.min.x,
                      y:o.aabb.max.y-o.aabb.min.y,
                      z:o.aabb.max.z-o.aabb.min.z };
    const dx=x-P.x, dz=z-P.z, oy=-P.y;
    /* local coordinates of the ray origin (world y=0) and its direction */
    const O=[rot[0]*dx+rot[3]*oy+rot[6]*dz,
             rot[1]*dx+rot[4]*oy+rot[7]*dz,
             rot[2]*dx+rot[5]*oy+rot[8]*dz];
    const D=[rot[3], rot[4], rot[5]];
    const H=[s.x/2, s.y/2, s.z/2];
    let tmin=-Infinity, tmax=Infinity;
    for (let i=0;i<3;i++){
      if (Math.abs(D[i])<1e-9){
        if (Math.abs(O[i])>H[i]) return null;
      } else {
        let t1=(-H[i]-O[i])/D[i], t2=(H[i]-O[i])/D[i];
        if (t1>t2){ const t=t1; t1=t2; t2=t; }
        if (t1>tmin) tmin=t1;
        if (t2<tmax) tmax=t2;
        if (tmin>tmax) return null;
      }
    }
    return { min:tmin, max:tmax };
  }
  /* support/clearance of a tilted part under the yawed footprint:
   * min/max top over the centre and four corners */
  _obbSupport(o, k){
    const pts=[[k.cx,k.cz],
      [k.cx+k.hf*k.fx+k.hs*k.rx, k.cz+k.hf*k.fz+k.hs*k.rz],
      [k.cx+k.hf*k.fx-k.hs*k.rx, k.cz+k.hf*k.fz-k.hs*k.rz],
      [k.cx-k.hf*k.fx+k.hs*k.rx, k.cz-k.hf*k.fz+k.hs*k.rz],
      [k.cx-k.hf*k.fx-k.hs*k.rx, k.cz-k.hf*k.fz-k.hs*k.rz]];
    let mn=Infinity, mx=-Infinity, any=false;
    for (let i=0;i<pts.length;i++){
      const sp=this._boxRaySpan(o, pts[i][0], pts[i][1]);
      if (!sp) continue;
      any=true;
      if (sp.min<mn) mn=sp.min;
      if (sp.max>mx) mx=sp.max;
    }
    return any? { min:mn, max:mx } : null;
  }
  /* top of the surface in the direction the body is moving  the leading
   * edge decides whether a tilted part is a walkable slope or a wall */
  _leadSupport(o, k, dx, dz){
    let n=Math.hypot(dx,dz);
    if (n<1e-6){ dx=k.fx; dz=k.fz; n=1; }
    dx/=n; dz/=n;
    const reach=k.hf*Math.abs(k.fx*dx+k.fz*dz)+k.hs*Math.abs(k.rx*dx+k.rz*dz);
    const sp=this._boxRaySpan(o, k.cx+dx*reach, k.cz+dz*reach);
    return sp? sp.max : null;
  }
  _footprintOverlap(o, k){
    return this._sat2(k, this._partBox(o));
  }
  /* collider OBB cache: rebuilt only when the look's cf object is swapped
   * (placePart assigns a fresh cf; static looks keep theirs forever)  the
   * old code re-derived a box object for every collider on every query */
  _partBox(o){
    const c=o.__pbox;
    if (c && c.cf===(o.cf||null)) return c.box;
    const a=o.aabb;
    /* look.cf.rot is the live row-major CFrame; look.rot was never assigned
     * (the old check made every collider axis-aligned). */
    const rot=(o.cf&&o.cf.rot)||o.rot;
    let box;
    if (!rot){
      const hx=(a.max.x-a.min.x)/2, hz=(a.max.z-a.min.z)/2;
      box={ cx:(a.min.x+a.max.x)/2, cz:(a.min.z+a.max.z)/2,
            fx:1, fz:0, rx:0, rz:1, hf:hx, hs:hz };
    } else if (this._tilted(o)) {
      /* tilted part: the old local-Z footprint ignored the long axis when
       * it was tilted out of the horizontal plane (the drawbridge plank
       * became a 1×12 sliver at its centre).  Use the projected world
       * footprint; walkable slopes are filtered by _leadSupport in _sweep. */
      const hx=(a.max.x-a.min.x)/2, hz=(a.max.z-a.min.z)/2;
      box={ cx:(a.min.x+a.max.x)/2, cz:(a.min.z+a.max.z)/2,
            fx:1, fz:0, rx:0, rz:1, hf:hx, hs:hz };
    } else {
      let fx=-rot[2], fz=-rot[8];               /* lookVector = −col3 */
      const n=Math.hypot(fx,fz)||1; fx/=n; fz/=n;
      box={ cx:(a.min.x+a.max.x)/2, cz:(a.min.z+a.max.z)/2,
            fx, fz, rx:-fz, rz:fx,
            hf:o.size? o.size.z/2:0.5, hs:o.size? o.size.x/2:1.0 };
    }
    o.__pbox={cf:(o.cf||null), box};
    return box;
  }
  boxOverlap(o, k){
    k=k||this.yawBox();
    const a=o.aabb;
    if (a.max.y <= k.yLo || a.min.y >= k.yHi) return false;
    /* cheap world-AABB reject before the SAT (the yawed footprint's world
     * extent covers every orientation the SAT could accept) */
    if (a.max.x <= k.cx-k.ex || a.min.x >= k.cx+k.ex) return false;
    if (a.max.z <= k.cz-k.ez || a.min.z >= k.cz+k.ez) return false;
    return this._sat2(k, this._partBox(o));
  }
  charAABB(){                       /* world AABB of the yawed footprint */
    const k=this.yawBox();
    return { min:{x:k.cx-k.ex, y:k.yLo, z:k.cz-k.ez},
             max:{x:k.cx+k.ex, y:k.yHi, z:k.cz+k.ez} };
  }

  step(dt, input){
    const c=this.c;
    if (!c.alive) return;
    /* rides: dynamic assemblies (beacon pads, debris stacks) translate the
     * character standing on them before its own gravity acts */
    if (window.RBLXdyn){
      const cd=window.RBLXdyn.takeCarry();
      if (cd){
        const p0=c.group.position;
        p0.x+=cd.x; p0.y+=cd.y; p0.z+=cd.z;
      }
    }
    const v=this.velocity;

    // gather desired ground velocity from camera-relative input
    let ix=0, iz=0;
    const md=input.moveDir;
    if (md && (md.x||md.z)){ ix=md.x; iz=md.z; }
    const want=new THREE.Vector3(ix,0,iz);
    if (want.lengthSq()>1) want.normalize();
    want.multiplyScalar(this.walkSpeed);

    /* ---- climbing ---- */
    if (this.climbing){
      this._climbStep(dt, input);
      return;
    }
    /* walking/pushing into a ladder or truss attaches to it */
    if (want.lengthSq()>0.001 && this._tryClimb(want, input)){
      this._climbStep(dt, input);
      return;
    }

    /* FUN_005e9b90 (Running): desired horizontal velocity is
     * MoveDirection * 16  the ground state tracks it directly. Air keeps
     * a small control lerp; the decomp base state is force-based (PD 1250)
     * and is approximated here by the kinematic solver. */
    if (this.onGround){
      if (want.lengthSq()>0.001){
        v.x=want.x; v.z=want.z;
      } else {
        const damp=Math.max(0.002, Math.pow(this.friction, dt*60)); // classic friction per tick
        v.x*=damp; v.z*=damp;
      }
    } else {
      const accel=2.4;
      v.x+=(want.x-v.x)*Math.min(1, accel*dt);
      v.z+=(want.z-v.z)*Math.min(1, accel*dt);
    }
    v.y+=this.gravity*dt;

    if (input.jump && !this.jumpLatch){
      this.jumpLatch=true;
      /* Humanoid.Jumping(true) is the jump-input edge (classic event feeds
       * the JetPack toggle and the humanoidSound jump sound).  It must fire
       * even mid-air so a second press can toggle a jetpack off. */
      if (window.RBLXenv&&window.RBLXenv.fireHumanoidEvent)
        window.RBLXenv.fireHumanoidEvent('Jumping', [true]);
      if (this.onGround){
        this.jumping=true;
        this.jumpTime=0;
        this.onGround=false;
        if (c.onJumped) c.onJumped();
      }
    }
    if (!input.jump) this.jumpLatch=false;
    /* FUN_00611430: force = (50 − vy) * 5000, applied mass-scaled. The
     * integrator divides by the same mass, so the effective acceleration is
     * (50 − vy) * 5000  NOT /112. The old /112 made the ramp's steady state
     * ~48.9, so `jumping` never cleared and the character floated upward. */
    if (this.jumping){
      this.jumpTime+=dt;
      if (v.y < this.jumpPower){
        const k=Math.min(1, 5000*dt);
        v.y+=(this.jumpPower-v.y)*k;
        if (v.y>=this.jumpPower-0.1){ v.y=this.jumpPower; this.jumping=false; }
      } else this.jumping=false;
      /* hard safety: never keep the jump force alive indefinitely */
      if (this.jumpTime>=0.5) this.jumping=false;
    }

    /* 2007 humanoid: the rig turns to face the direction it walks. The
     * rig/decal front is local -Z (Face=5 decal planes sit at -Z), so the
     * world forward for yaw θ is (-sinθ, -cosθ)  matching the camera
     * move basis in main.js  giving θ = atan2(-vx, -vz). Turn is servo
     * smooth; the decomp idle yaw servo uses ×8.0. */
    const hspeed=Math.hypot(v.x, v.z);
    if (hspeed>0.6){
      const target=Math.atan2(-v.x, -v.z);
      let d=target-c.group.rotation.y;
      while (d> Math.PI) d-=Math.PI*2;
      while (d<-Math.PI) d+=Math.PI*2;
      c.group.rotation.y+=d*Math.min(1, 8*dt);   /* idle yaw servo ×8.0 (decomp) */
    }

    /* tunneling guard: how far the feet can sink below a top face in one
     * step (falling at 50..150 studs/s crosses a 1-stud brick between frames) */
    const sink=Math.max(1.0, -v.y*dt+0.4);
    this._sinkWindow=sink;

    const p=c.group.position;
    const prevFeet=p.y-3.0;

    /* ---- axis-separated movement ---- */
    p.x += v.x*dt;
    this._sweep('x');
    p.z += v.z*dt;
    this._sweep('z');

    this.groundLook=null;                 // rebuilt under the feet each step
    p.y += v.y*dt;
    if (c.heldByServo){
      /* a BodyPosition servo (crane escort) owns the body: no landing
       * face, no ground probe, no head bump  those clamps zeroed the
       * servo's vy every tick and the fight strobed the camera */
      this.onGround=false;
    } else {
      const landed=this._vertical(v.y, prevFeet, input);
      if (v.y<=0 && landed){
        const wasAir=!this.onGround;
        v.y=0;
        this.jumping=false;
        if (wasAir && c.onLanded) c.onLanded();
        this.onGround=true;
        /* close the boolean jump state: humanoidSound pauses the jump
         * sound and a JetPack turns off when the character lands */
        if (wasAir && window.RBLXenv&&window.RBLXenv.fireHumanoidEvent)
          window.RBLXenv.fireHumanoidEvent('Jumping', [false]);
      } else {
        const gp=this._groundProbe();
        this.groundLook = gp||null;         // collider record (friction/elasticity/velocity)
        this.onGround = gp;
      }
    }
    /* dynamic geometry that moved into the idle body between physics
     * steps: push the character out (car/prop hits the player) */
    this._pushOutDynamic();
    /* mirror the ground collider onto the character  dynamics.js reads
     * c.groundLook to detect rides (beacon pads / moving assemblies) */
    this.c.groundLook = this.groundLook;
    /* mirror ground state onto the character  the Animate port's pose
     * classifier reads c.onGround (Running/Standing vs Jumping/FreeFall);
     * leaving it unset latched FreeFall forever (the frozen-arms bug) */
    this.c.onGround = this.onGround;
    if (p.y < -80){                      // fell through the world
      c.takeDamage(100);
    }
  }

  _colliders(){ return this.world? this.world.colliders : []; }

  /* Candidate colliders around the character.  The dynamics spatial hash
   * indexes every world look with exact AABBs; before this the humanoid ran
   * five to six full collider scans per step (RobloxHQ: 8k parts).  The pad
   * covers one step of travel, so the candidate set is a superset of the
   * old linear scan.  Falls back to the full list before dynamics is up. */
  _near(k, padXZ, padY){
    const D=window.RBLXdyn;
    if (D&&D._ready&&D._neighbors){
      const px=padXZ==null?3:padXZ, py=padY==null?3:padY;
      const out=[];
      for (const o of D._neighbors({
        min:{ x:k.cx-k.ex-px, y:k.yLo-py, z:k.cz-k.ez-px },
        max:{ x:k.cx+k.ex+px, y:k.yHi+py, z:k.cz+k.ez+px },
      })) if (o.canCollide!==false) out.push(o);
      return out;
    }
    return this._colliders();
  }

  /* Classic humanoid body mass: the sum of the rig part volumes (the same
   * density scalar the assembly solver uses).  The character is kinematic,
   * but contacts with free bodies still need a mass to share momentum. */
  bodyMass(){
    let m=0;
    const parts=this.c&&this.c.parts;
    if (parts){
      for (const nm of Object.keys(parts)){
        const s=parts[nm]&&parts[nm].size;
        if (s&&isFinite(s.x)&&isFinite(s.y)&&isFinite(s.z))
          m+=Math.max(0.25, Math.abs(s.x*s.y*s.z));
      }
    }
    return m>0? m : 13;
  }
  /* Push a free assembly along the axis the humanoid walked into it.  The
   * character keeps its kinematic position (so it cannot tunnel through a
   * heavy wall), but a light brick receives the momentum-shared velocity
   * and wakes instead of behaving like an immovable collider. */
  _pushDynamic(o, axis, speed, dir){
    const D=window.RBLXdyn;
    if (!D||!D.asmMap) return false;
    const a=D.asmMap.get(o);
    if (!a||a.static||a.hinge||a.charAttach||(a.movers&&a.movers.length)) return false;
    const Ma=Math.max(0.25, a.mass||0.25);
    const Mc=this.bodyMass();
    const v0=a.vel[axis]||0;
    if ((speed-v0)*dir<=1e-6) return false;
    const share=(Mc*speed+Ma*v0)/(Mc+Ma);
    if ((share-v0)*dir>1e-6) a.vel[axis]=share;
    a.asleep=false;
    if (D.wakeAround) D.wakeAround(a);
    return true;
  }

  /* ---------------- climbing (ladders / TrussParts) ----------------
   * The 2007 engine had no ladder state: a downward ray from the torso
   * (FUN_005e96b0) found ground/next rung ahead and the Running state then
   * forced vy = 0.7·speed every tick (FUN_005e9b90). That only chained while
   * gaps stayed under the ray reach (~1.2 studs) and could not be held or
   * reversed. Here a ladder model/truss is one climb VOLUME: the body
   * overlaps it, W/S drive up/down, no input holds, jump detaches, and the
   * top steps out. Rate is still the mined 0.7 × WalkSpeed. */
  _climbVolumes(){
    const w=this.world;
    if (!w) return [];
    if (w._climbDirty && w._rebuildClimbVolumes) w._rebuildClimbVolumes();
    return w.climbVolumes||[];
  }

  _findClimb(want, input){
    const p=this.c.group.position;
    const feet=p.y-3.0, head=p.y+2.1;
    const axis=(input&&input.climbAxis)||0;
    let best=null, bestD=1e9;
    for (const vol of this._climbVolumes()){
      if (!vol || !vol.parts || !vol.parts.length) continue;
      /* vertical overlap with the ladder; the small top lip lets a climber
       * standing on the top rung grab it again to climb down */
      if (vol.max.y < feet-0.35 || vol.min.y > head-0.2) continue;
      const dxl=p.x-vol.min.x, dxr=vol.max.x-p.x;
      const dzl=p.z-vol.min.z, dzr=vol.max.z-p.z;
      const ox=Math.max(vol.min.x-p.x, 0, p.x-vol.max.x);
      const oz=Math.max(vol.min.z-p.z, 0, p.z-vol.max.z);
      const d=Math.hypot(ox,oz);
      if (d>1.05) continue;                    // touching/near the ladder only
      /* outward normal of the face the climber is nearest to */
      const m=Math.min(dxl,dxr,dzl,dzr);
      let nx=0, nz=0;
      if (m===dxl) nx=-1; else if (m===dxr) nx=1;
      else if (m===dzl) nz=-1; else nz=1;
      const atTop=feet>=vol.max.y-0.35;
      /* standing on the top rung, W must STEP OFF onto the platform  only
       * S (axis<0, "climb down") re-grabs the ladder there */
      if (atTop && axis>0) continue;
      if (want){
        const wl=Math.hypot(want.x,want.z);
        const into=wl>0.1 ? (want.x*(-nx)+want.z*(-nz))/wl : 0;
        /* must be pushing INTO the ladder, not walking along it  except
         * at the top, where S (which moves the body away) grabs to descend */
        if (!(into>=0.25 || (atTop && axis<0))) continue;
      }
      if (d<bestD){ bestD=d; best={vol, nx, nz}; }
    }
    return best;
  }

  _tryClimb(want, input){
    const hit=this._findClimb(want, input);
    if (!hit) return false;
    this._enterClimb(hit.vol, hit.nx, hit.nz);
    return true;
  }

  _enterClimb(vol, nx, nz){
    const c=this.c, p=c.group.position;
    this.climbing=true;
    this.climbVol=vol;
    this.climbN={x:nx, z:nz};
    this.velocity.set(0,0,0);
    this.jumping=false;
    this.onGround=false;
    this.groundLook=null;
    /* hug the face  torso centre 0.55 out; the yawed footprint half-depth
     * is 0.72, so the feet still overlap the top rung (standing on the
     * ladder top after the exit) while the chest is against the rungs */
    if (nx) p.x=(nx>0?vol.max.x:vol.min.x)+nx*0.55;
    if (nz) p.z=(nz>0?vol.max.z:vol.min.z)+nz*0.55;
    c.group.rotation.y=Math.atan2(nx, nz);   // face the ladder (rig front −Z)
    c.climbing=true; c.onGround=false; c.groundLook=null;
  }

  _exitClimb(){
    this.climbing=false;
    this.climbVol=null;
    if (this.c) this.c.climbing=false;
  }

  _climbStep(dt, input){
    const c=this.c, p=c.group.position, v=this.velocity, vol=this.climbVol;
    if (!vol || !vol.parts || !vol.parts.length ||
        (vol.parts[0] && vol.parts[0].destroyed)){
      this._exitClimb(); return;
    }
    const axis=(input && input.climbAxis)||0;
    v.x=0; v.z=0; v.y=axis*this.climbSpeed;
    p.y+=v.y*dt;
    /* stay snapped to the face while climbing */
    if (this.climbN.x) p.x=(this.climbN.x>0?vol.max.x:vol.min.x)+this.climbN.x*0.55;
    if (this.climbN.z) p.z=(this.climbN.z>0?vol.max.z:vol.min.z)+this.climbN.z*0.55;
    c.group.rotation.y=Math.atan2(this.climbN.x, this.climbN.z);
    /* Space = push off the ladder */
    if (input && input.jump && !this.jumpLatch){
      this.jumpLatch=true;
      if (window.RBLXenv&&window.RBLXenv.fireHumanoidEvent)
        window.RBLXenv.fireHumanoidEvent('Jumping', [true]);
      this._exitClimb();
      v.x=this.climbN.x*8; v.z=this.climbN.z*8; v.y=this.jumpPower;
      this.jumping=true; this.jumpTime=0;
      this.onGround=false;
      if (c.onJumped) c.onJumped();
      return;
    }
    if (!(input && input.jump)) this.jumpLatch=false;
    const feet=p.y-3.0;
    /* top: step onto the ladder instead of climbing into air */
    if (feet>=vol.max.y-0.02 && axis>0){
      this._exitClimb();
      p.y=vol.max.y+3.0;                  // feet on the top face
      v.set(0,0,0);
      this.onGround=true;
      c.onGround=true;
      return;
    }
    /* bottom: slid off the last rung, or deliberately climbed down past it */
    if (feet<vol.min.y-1.2 || (axis<0 && feet<=vol.min.y+0.02)){
      this._exitClimb();
      if (v.y>0) v.y=0;
      this.onGround=false;
      c.onGround=false;
      return;
    }
    if (feet>vol.max.y) p.y=vol.max.y+3.0;      // hold at the top while idle
    this.onGround=false;
    this.groundLook=null;
    c.onGround=false; c.climbing=true; c.groundLook=null;
  }

  _sweep(axis){
    const c=this.c, p=c.group.position;
    const myV=axis==='x'? this.velocity.x : this.velocity.z;
    /* No motion on this axis → no sweep. Resolving an axis the player did
     * not move along is what ejected the character sideways out of long
     * walls (the old code pushed to the nearer of the two faces). */
    if (Math.abs(myV)<1e-6) return;
    const feet=p.y-3.0;
    const k=this.yawBox();
    /* step-up assist is a GROUNDED behavior: on the ground, ledges within
     * stepHeight are walked over (they never block horizontally  pushing
     * the body out of the brick it stands on was the walk-on-plate
     * teleport); airborne, only the flush-support epsilon is skipped so a
     * jump still collides with low walls */
    const stepBand=this.onGround? this.stepHeight : 0.06;
    for (const o of this._near(k,4,3)){
      if (o.destroyed || !o.aabb || o.__charIgnore) continue;
      if (o.aabb.max.y - feet <= stepBand) continue;
      /* tilted (hinged/toppled) part: its fat AABB top is not a surface.
       * If the leading edge under the feet is within step reach it is a
       * ramp/ledge to climb, not a wall; otherwise it blocks horizontally. */
      if (this._tilted(o)){
        if (!this._footprintOverlap(o, k)) continue;
        const span=this._obbSupport(o, k);
        if (!span) continue;
        if (span.max <= k.yLo || span.min >= k.yHi) continue;
        let lead=this._leadSupport(o, k, this.velocity.x, this.velocity.z);
        if (lead==null){
          const cen=this._boxRaySpan(o, k.cx, k.cz);
          lead=cen? cen.max : null;
        }
        if (lead!=null && lead - feet <= stepBand+0.02) continue;
        const r=this._satPen(k, this._partBox(o));
        if (!r) continue;
        const mvx=axis==='x'?myV:0, mvz=axis==='z'?myV:0;
        if (mvx*r.ux+mvz*r.uz>=-1e-6) continue;
        this._pushDynamic(o, axis, myV, myV>0?1:-1);
        p.x+=r.ux*r.pen; p.z+=r.uz*r.pen;
        if (r.ux) this.velocity.x=0;
        if (r.uz) this.velocity.z=0;
        continue;
      }
      if (!this.boxOverlap(o, k)) continue;
      const rot=(o.cf&&o.cf.rot)||o.rot;
      if (rot){
        /* oriented collider: only accept a normal opposing the motion */
        const r=this._satPen(k, this._partBox(o));
        if (!r) continue;
        const mvx=axis==='x'?myV:0, mvz=axis==='z'?myV:0;
        if (mvx*r.ux+mvz*r.uz>=-1e-6) continue;
        this._pushDynamic(o, axis, myV, myV>0?1:-1);
        p.x+=r.ux*r.pen; p.z+=r.uz*r.pen;
        if (r.ux) this.velocity.x=0;
        if (r.uz) this.velocity.z=0;
      } else {
        const a=o.aabb;
        let push=0;
        if (myV>0){
          const d=(k.cx+k.ex)-a.min[axis];     // entered the min face
          if (d>0) push=-d;
        } else {
          const d=a.max[axis]-(k.cx-k.ex);     // entered the max face
          if (d>0) push=d;
        }
        if (push!==0){
          this._pushDynamic(o, axis, myV, myV>0?1:-1);
          p[axis]+=push;
        }
        /* top is above step-up reach ⇒ a genuine wall: stop this axis */
        this.velocity[axis]=0;
      }
    }
  }

  /* A moved dynamic assembly can enter the stationary body between those
   * bodies' steps (the character had no horizontal velocity, so _sweep
   * skipped the axis).  Resolve that overlap from the body's side and carry
   * the pusher's velocity, like the classic humanoid mass response. */
  _pushOutDynamic(){
    const D=window.RBLXdyn;
    if (!D||!D.asmMap) return;
    const p=this.c.group.position;
    for (let pass=0; pass<2; pass++){
      const k=this.yawBox();
      let best=null;
      for (const o of this._near(k,3,1)){
        if (o.destroyed||!o.aabb||o.__charIgnore) continue;
        const a=D.asmMap.get(o);
        if (!a||a.static||a.hinge||a.charAttach) continue;
        const av=a.vel||{x:0,y:0,z:0};
        if (Math.abs(av.x||0)+Math.abs(av.y||0)+Math.abs(av.z||0)<0.02) continue;
        if (o.aabb.max.y<=k.yLo+0.05 || o.aabb.min.y>=k.yHi-0.05) continue;
        const r=this._satPen(k, this._partBox(o));
        if (!r||r.pen<=0.001) continue;
        if (!best||r.pen>best.pen) best={ r, a, av };
      }
      if (!best) break;
      const pen=Math.min(best.r.pen, 2.0);
      p.x+=best.r.ux*pen;
      p.z+=best.r.uz*pen;
      const v=this.velocity;
      if (best.r.ux*best.av.x>0) v.x=best.av.x;
      if (best.r.uz*best.av.z>0) v.z=best.av.z;
    }
  }

  /* Swept head/ceiling test.  A 50-stud jump moves 0.83 studs per 60 Hz
   * tick, so checking only a thin band above the new head let the head
   * pass straight through a low roof (then the player stood on top of it).
   * Sweep the whole interval the head travelled and clamp against the
   * lowest underside in that interval. */
  _ceilingSweep(prevFeet, k, p){
    const prevHead=prevFeet+5.1;      // feet + torso 3 + head 2.1
    const head=p.y+2.1;
    let under=Infinity, hit=null;
    for (const o of this._near(k,2,6)){
      if (o.destroyed||!o.aabb||o.__charIgnore) continue;
      if (!this._sat2(k, this._partBox(o))) continue;
      let u;
      if (this._tilted(o)){
        const span=this._obbSupport(o, k);
        if (!span) continue;
        u=span.min;
      } else u=o.aabb.min.y;
      /* only surfaces the head crosses this tick, not the floor below or
       * a roof too high to reach */
      if (u < prevHead-0.06) continue;
      if (u > head+0.06) continue;
      if (u < under){ under=u; hit=o; }
    }
    if (hit && head>under){
      p.y-=head-under;
      this.velocity.y=0;
      this.jumping=false;
      return hit;
    }
    return null;
  }

  _vertical(vy, prevFeet, input){
    const c=this.c, p=c.group.position;
    const feet=p.y-3.0;
    const k=this.yawBox();
    const md=input&&input.moveDir;
    const moving=!!(md&&(md.x*md.x+md.z*md.z)>1e-6);
    if (vy>0){
      this._ceilingSweep(prevFeet, k, p);
      return false;
    }
    /* Resolve the whole tick once: highest landing face, or the highest
     * low ledge in front. Never iterate a stack of bricks upward  that
     * let a wall of 2-stud bricks be climbed in a single frame. */
    let land=null, step=null, landY=null, stepY=null;
    for (const o of this._near(k,4,4)){
      if (o.destroyed||!o.aabb||o.__charIgnore) continue;
      const tilted=this._tilted(o);
      let top;
      const a=o.aabb;
      const cx=(a.min.x+a.max.x)/2, cz=(a.min.z+a.max.z)/2;
      if (tilted){
        if (!this._footprintOverlap(o, k)) continue;
        const span=this._obbSupport(o, k);
        if (!span) continue;
        top=span.max;
      } else {
        if (!this.boxOverlap(o)) continue;
        top=a.max.y;
      }
      if (top<=prevFeet+0.06 && top>=feet-this._sinkWindow){
        if (!land||top>landY){ land=o; landY=top; }
      } else if (top>feet && top-feet<=this.stepHeight && (tilted||moving)){
        /* a tilted surface under the footprint is always underfoot; an
         * upright ledge must be in the direction of travel */
        if (tilted || (cx-p.x)*md.x+(cz-p.z)*md.z>=-0.01){
          if (!step||top>stepY){ step=o; stepY=top; }
        }
      }
    }
    /* The floor under the feet is a landing candidate every tick; a low
     * ledge in front must win over it or walking into a 2-stud border just
     * stops at the face. Pick the higher of the two. */
    let support=land, supportTop=landY;
    if (step && (!support || stepY>supportTop)){ support=step; supportTop=stepY; }
    if (!support) return false;
    p.y+=supportTop-feet;
    this.velocity.y=0;
    this.groundLook=support;
    return true;
  }

  _groundProbe(){
    /* Choose the highest top at/below the feet. The old probe returned the
     * first collider whose vertical span contained feet-0.08, so a wall
     * beside the player counted as ground. */
    const k=this.yawBox();
    const feet=k.yLo;
    let best=null, bestTop=-Infinity;
    for (const o of this._near(k,2,2)){
      if (o.destroyed || !o.aabb || o.__charIgnore) continue;
      const tilted=this._tilted(o);
      if (!this._sat2(k, this._partBox(o))) continue;
      let top;
      if (tilted){
        const span=this._obbSupport(o, k);
        if (!span) continue;
        top=span.max;
      } else {
        top=o.aabb.max.y;
      }
      if (top>feet+0.12) continue;       // a wall/step, not support
      if (top<feet-0.6) continue;        // too far below to stand on
      if (top>bestTop){ bestTop=top; best=o; }
    }
    return best||false;
  }
}

window.RBLXphysics = { Humanoid };
})();
