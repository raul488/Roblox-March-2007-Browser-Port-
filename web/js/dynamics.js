 /* ============================================================
 * dynamics.js  classic assembly physics (the 2007 engine's own model).
 *
 * Mined behavior (Roblox.exe.c  see decomp/FUNCTION_MAP.md §11):
 *  - Load-time auto-join is SURFACE-DRIVEN, not contact-blind. The World
 *    AutoJoin notifier (FUN_005adba0) runs a factory chain per touching
 *    face pair (FUN_005f50a0), first hit wins:
 *      1. Hinge(6)/Motor(7)/SteppingMotor(8) on BOTH faces → rotate
 *         joints (non-rigid DOF; FUN_005ea670/ea550)  no rigid edge
 *         in v1 (rotation DOF is APPROX).
 *      2. Weld(2) face on either side → WeldJoint (FUN_006142d0).
 *      3. Studs(3)+Inlet(4) exact pair → SnapJoint (FUN_006141e0).
 *      4. Glue(1) face → GlueJoint: 4 PointToPoint corners +
 *         NormalBreakConnector, break force = min of both parts
 *         (FUN_005fbe10/005ec070)  rigid edge in v1.
 *    Alignment: faces anti-parallel (dot > -0.9), part rotation tolerance
 *    0.01 (snap/weld) / 0.05 (glue). Weld/Glue accept up to 1.2 studs of
 *    plane separation (overlap range  decomp gates 0.01/0.05, APPROX);
 *    Studs+Inlet snaps only at ≤ 0.05. The decomp's face-center check is
 *    not ported (FUN_005eb0a0).
 *  - Clusters (rigid joints: weld/snap/glue) get their root
 *    anchored-first then by mass (FUN_005f0dc0/FUN_005f0e40): any
 *    Anchored member roots the whole cluster static. Destroying a part
 *    breaks joints through it (JointStage FUN_005ef5d0) and the
 *    remainder re-clusters (ClumpStage); anchored flotsam left behind
 *    keeps the cluster static, otherwise it falls.
 *  - SurfaceType enum in this build: 0 Smooth, 1 Glue, 2 Weld, 3 Studs,
 *    4 Inlet, 5 Spawn, 6 Hinge, 7 Motor, 8 SteppingMotor (+Bumps);
 *    Smooth/Spawn/Bumps faces never bond. Fresh runtime parts use the
 *    ctor defaults (Top Studs / Bottom Inlet / other faces Smooth) and
 *    get their own assembly; scripts can bond explicitly via
 *    part:makeJoints() (the beacons' rebuildStud does).
 *      BodyVelocity = per-axis velocity *constraint* with force budget
 *        (TeamBeacon Center: velocity (0,-2,0), maxForce (0,40000,0);
 *        the Y budget holds against gravity: mass 112 · 196.2 = 22000 N
 *        < 40000 N, so beacons sink at exactly -2/s like the shipped
 *        scripts demand; X/Z budgets 0 → no lateral force).
 *      BodyPosition = per-axis P·err − D·v force clamped to maxForce
 *        (beacon: P 10000, D 1250, maxForce (500,0,500)  X/Z homing only;
 *        Y budget 0 = no vertical bp force). Targets are READ LIVE every
 *        step, so script writes (`velocity.velocity=Vector3.new(0,10,0)`,
 *        goUp) act immediately with no extra plumbing.
 *    Static support wins over movers (infinite-stiffness contact): a
 *    grounded assembly ignores a downward BodyVelocity pull, so a landed
 *    beacon rests instead of jittering through its pad.
 *  - Gravity 196.2 (canonical classic constant, same as physics.js).
 *  - Explosions: FUN_00603df0 ctor  BlastRadius default 4.0f
 *    (0x40800000, Roblox.exe.c:501387), BlastPressure default 500000.0f
 *    (0x48f42400, :501388). FUN_00604250 waits 0.1 s, queries the parts
 *    in the cube pos±radius, fires Explosion.Hit, and FUN_006029c0 adds
 *    direction * pressure * boundingRadius² to the body. This module
 *    applies that radial impulse to the welded assembly (the client's
 *    body/inverse-mass integrator is inlined, so the final Δv is capped
 *    and scaled  see web/PORT.md APPROX ledger). The blast does not
 *    destroy parts or write Health.
 *  - Contact response is the client's FORCE model, not impulses:
 *    RBX::ContactConnector::update (0x611e00) computes a spring force
 *    from a decaying stored separation reference and a tangential
 *    friction accumulator, then FUN_005c78f0 adds F at the contact
 *    point and r x F to the body torque.  RBX::Kernel::step (0x5c7dd0)
 *    runs 0x13 = 19 force/integration substeps per 1/240 s tick with
 *    h = 1/4560 s; gravity is a force (-196.2 * mass), the body integrates
 *    linear velocity from F/m, angular velocity through I^-1, and an
 *    angular momentum damped 0.9998 per substep; the rotation quaternion
 *    integrates 0.5*w*q*h and is renormalized (FUN_005f7ee0).
 *    The port mirrors that loop: 19 substeps per 1/240 of frame time,
 *    contact penalty forces at exact OBB corner penetration points,
 *    force/torque accumulators, and quaternion integration.  Sliding,
 *    rocking, tipping, bouncing and spin decay are outcomes of those
 *    forces; nothing is scripted.  Contact stiffness is calibrated as
 *    7500 * min assembly mass (the client's shape scalar times the
 *    mined 7500 mass constant) and elasticity maps 0.5 -> 0.57 via
 *    FUN_005ed340.  Contact masses, the remaining scalar tie and the
 *    contact-manifold generator are APPROX; see web/PORT.md.
 * ============================================================ */
(function(){
"use strict";

const GRAV=196.2;        // canonical classic gravity (force = -196.2*m)
const CONTACT=0.05;      // face-plane join tolerance (studs)  mined 0.05 gate
const CELL=16;           // spatial hash cell size
const SETTLE=0.4;        // |v| under which a grounded free assembly may sleep
const BLAST_PRESSURE=500000; // Explosion.BlastPressure ctor default
const BLAST_DIV=20000;       // inverse-mass/impulse scaling (APPROX)
const BLAST_CAP=80;          // gameplay cap Δv (APPROX; engine integrates mass)

/* Client solver constants  decomp/Roblox.exe.c §Kernel::step (0x5c7dd0),
 * ContactConnector::update (0x611e00), body integrator (0x5f7ee0). */
const TICK_HZ=240;           // Kernel ticks per second
const SUBSTEPS=19;           // connector/force iterations per tick
const SUB_H=1/4560;          // h passed to every connector update
const CONTACT_STIFFNESS=7500; // mass -> contact spring scale (0x7bfba0)
const CONTACT_FRICTION=0.2;  // fallback Coulomb coefficient (contact+0x28)
const CONTACT_DAMP=0.2;      // tangential spring factor (0x2c * 0.2)
const ANG_DAMP=0.9998;       // angular momentum damping per substep
const SEP_DECAY=0.999;       // stored-separation decay per substep
const SEP_OFFSET=0.01;       // stored-separation bias (0x38/0x3c math)
const ANG_SLEEP=0.15;        // |ω| under which a grounded body may sleep
const QUIET_FRAMES=6;        // low-motion frames before sleeping
/* Contact spring jitter can keep |ω| above ANG_SLEEP forever on a block
 * that is visually at rest (the residual is ~0.002-0.07 studs/s).  A
 * displacement probe catches that: if the assembly origin and rotation
 * stay within these tolerances for STILL_FRAMES, it is at rest whatever
 * the instantaneous contact velocities say. */
const STILL_FRAMES=40;       // ~0.66 s (60 Hz) of sub-tolerance motion
const STILL_POS=0.12;        // studs of origin drift allowed in that window
const STILL_ROT=0.08;        // quaternion component drift allowed
const TIP_EPS=0.02;          // support-hull tolerance for the sleep test
const WAKE_REL=1.0;          // approach speed that pre-wakes a sleeper

/* NormalId faces (classic): 0 Right +X, 1 Top +Y, 2 Back +Z,
 * 3 Left -X, 4 Bottom -Y, 5 Front -Z (Front decal planes sit on -Z) */
const FACE_AXIS=[[1,0,0],[0,1,0],[0,0,1],[-1,0,0],[0,-1,0],[0,0,-1]];
const HINGE_MIN=6, HINGE=6;       // SurfaceType 6..8 = Hinge/Motor/SteppingMotor
const SMOOTH=0, GLUE=1, WELD=2, STUDS=3, INLET=4;

function cellSplit(v){ return Math.floor(v/CELL); }
function forEachCell(a, cb){
  for (let x=cellSplit(a.min.x); x<=cellSplit(a.max.x); x++)
    for (let y=cellSplit(a.min.y); y<=cellSplit(a.max.y); y++)
      for (let z=cellSplit(a.min.z); z<=cellSplit(a.max.z); z++) cb(x+','+y+','+z);
}
function touching(a, b, eps){
  return a.min.x<=b.max.x+eps && a.max.x+eps>=b.min.x &&
         a.min.y<=b.max.y+eps && a.max.y+eps>=b.min.y &&
         a.min.z<=b.max.z+eps && a.max.z+eps>=b.min.z;
}
function vecOf(p){
  if (p&&p.pv) return p.pv.slice();
  if (p&&typeof p==='object'&&typeof p.x==='number') return [p.x||0,p.y||0,p.z||0];
  if (typeof p==='number') return [p,p,p];
  return null;
}
function surfToken(v){          // props may ship numbers or names
  if (typeof v==='number') return v|0;
  if (typeof v==='string'){
    const i={Smooth:0,Glue:1,Weld:2,Studs:3,Inlet:4,Spawn:5,Hinge:6,
             Motor:7,SteppingMotor:8,Bumps:9}[v];
    return i==null? 0 : i;
  }
  return 0;                     // missing token → Smooth
}

/* the six faces of a part in WORLD space: {n:[x,y,z], pos:u} per face.
 * n = outward unit normal, pos = the face plane offset from part center.
 * Built from the part's own rotation  the OBB axes FUN_004fe9f0 reads. */
/* ---------------- Controller input (decomp FUN_0058d900 / enums) ----------------
 * ControllerType (FUN_0058fc90): 0 None, 1 KeyboardRight, 2 KeyboardLeft,
 * 3 Joypad1, 4 Joypad2, 5 Chase, 6 Flee, 7 Player.
 * InputType: 0 NoInput, 1 LeftTread, 2 RightTread, 3 Steer, 4 Throtle,
 * 6 UpDown, 7..11 Action1..5, 12 Constant, 13 Sin.
 * KeyboardLeft is WASD, KeyboardRight is UHJK; Space is UpDown.  The
 * browser key set is published by main.js as window.RBLXkeys. */
function controllerOfInst(inst){
  let p=inst;
  while (p){
    const v=p.props&&p.props.Controller;
    const n=typeof v==='number'?v:(typeof v==='string'?Number(v):0);
    if (isFinite(n)&&n) return n|0;
    p=p.parent;
  }
  return 0;
}
function controllerAxis(type, ctrl){
  if (type===5||type===6){                 /* Chase / Flee AI */
    const d=window.RBLXdyn, ch=d&&d.char, world=d&&d.world;
    if (!ch||!ch.group||!world) return null;
    let look=ctrl&&ctrl.look;
    if (!look) return null;
    /* use the model PrimaryPart's front, not a wheel's */
    let inst=look.part, model=null;
    while (inst){ if (inst.cls==='Model'){ model=inst; break; } inst=inst.parent; }
    if (model&&world.partLook&&model.props&&model.props.PrimaryPart){
      const pl=world.partLook.get(model.props.PrimaryPart);
      if (pl) look=pl;
    }
    const R=look.cf&&look.cf.rot; if (!R) return null;
    const P=look.cf.pos, T=ch.group.position;
    const dx=T.x-P.x, dz=T.z-P.z;
    const fx=-R[2], fz=-R[8];               /* LookVector = -column3 */
    const cross=fx*dz-fz*dx;                /* + = target on the right */
    const dot=fx*dx+fz*dz;
    if (dot*dot+dx*dx+dz*dz<1e-6) return { f:0, s:0, jump:0 };
    const s=Math.max(-1,Math.min(1,cross*0.15));
    return { f:1, s:type===5? s : -s, jump:0 };
  }
  const keys=window.RBLXkeys;
  if (!keys) return null;
  const d=k=>keys.has(k)?1:0;
  switch(type){
    case 1: return { f:d('u')-d('j'), s:d('k')-d('h'), jump:d(' ') };
    case 2: return { f:d('w')-d('s'), s:d('d')-d('a'), jump:d(' ') };
    case 3:
    case 4: return { f:d('ArrowUp')-d('ArrowDown'),
                     s:d('ArrowRight')-d('ArrowLeft'), jump:d(' ') };
  }
  return null;
}
function controllerInputRate(ctrl){
  if (!ctrl) return 0;
  const input=Number(ctrl.input)||0;
  const A=Number(ctrl.paramA)||0, B=Number(ctrl.paramB)||0;
  if (input===12) return B*60;                    /* Constant */
  if (input===13){                                /* Sin */
    const t=performance.now()*0.001;
    return A*60*Math.sin(t/(Math.max(0.01,Math.abs(B)||1)));
  }
  const ax=controllerAxis(Number(ctrl.controller)||0, ctrl);
  if (!ax) return 0;
  const keys=window.RBLXkeys||new Set();
  const key=k=>keys.has(String(k))?1:0;
  let v=0;
  switch(input){
    case 1: v=ax.f+ax.s; break;                   /* LeftTread */
    case 2: v=ax.f-ax.s; break;                   /* RightTread */
    case 3: v=ax.s; break;                        /* Steer */
    case 4: v=ax.f; break;                        /* Throtle */
    case 6: v=ax.jump?1:0; break;                 /* UpDown */
    case 7: v=key(1); break;
    case 8: v=key(2); break;
    case 9: v=key(3); break;
    case 10: v=key(4); break;
    case 11: v=key(3)?1:(key(4)?-1:0); break;     /* Action5 */
    default: return 0;
  }
  v=Math.max(-1,Math.min(1,v));
  return v>0? v*A*60 : (v<0? v*B*60 : 0);
}

function partFaces(look){
  const s=look.size||{x:1,y:1,z:1};
  const R=(look.cf&&look.cf.rot)||[1,0,0,0,1,0,0,0,1];
  const P=(look.cf&&look.cf.pos)||{x:0,y:0,z:0};
  const half=[s.x/2, s.y/2, s.z/2];
  const out=[];
  const names=['Right','Top','Back','Left','Bottom','Front'];
  const pp=(look.part&&look.part.props)||{};
  for (let f=0;f<6;f++){
    const a=FACE_AXIS[f];               // local axis with sign
    const ai=a[0]?0:(a[1]?1:2);
    // world normal = R · localAxis (sign folded into a[])
    const nx=R[ai]*a[ai], ny=R[3+ai]*a[ai], nz=R[6+ai]*a[ai];
    // face plane passes P + n·half (normal already carries the sign)
    const px=P.x+nx*half[ai], py=P.y+ny*half[ai], pz=P.z+nz*half[ai];
    const fk=names[f];
    out.push({ nx, ny, nz, px, py, pz, face:f,
               surf: look.surf? look.surf[f] : 0,
               surfInput: Number(pp[fk+'SurfaceInput'])||0,
               paramA: Number(pp[fk+'ParamA']),
               paramB: Number(pp[fk+'ParamB']),
               controller: controllerOfInst(look.part), look });
  }
  return out;
}

/* ---------------- rigid-body math ---------------- */
/* quaternion [w,x,y,z] -> row-major rotation matrix (world = R * local) */
function quatToMat(q){
  const w=q[0], x=q[1], y=q[2], z=q[3];
  return [
    1-2*(y*y+z*z), 2*(x*y-w*z),   2*(x*z+w*y),
    2*(x*y+w*z),   1-2*(x*x+z*z), 2*(y*z-w*x),
    2*(x*z-w*y),   2*(y*z+w*x),   1-2*(x*x+y*y)
  ];
}
function matT3(a){
  return [a[0],a[3],a[6], a[1],a[4],a[7], a[2],a[5],a[8]];
}
function matMul3(a,b){
  const o=new Array(9);
  for (let i=0;i<3;i++)
    for (let j=0;j<3;j++)
      o[i*3+j]=a[i*3]*b[j]+a[i*3+1]*b[3+j]+a[i*3+2]*b[6+j];
  return o;
}
function matVec3(a,v){
  return { x:a[0]*v.x+a[1]*v.y+a[2]*v.z,
           y:a[3]*v.x+a[4]*v.y+a[5]*v.z,
           z:a[6]*v.x+a[7]*v.y+a[8]*v.z };
}
function inv3(m){
  const a=m[0],b=m[1],c=m[2], d=m[3],e=m[4],f=m[5], g=m[6],h=m[7],i=m[8];
  let det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  if (!isFinite(det)||Math.abs(det)<1e-12){
    return [1,0,0, 0,1,0, 0,0,1];
  }
  const k=1/det;
  return [
    (e*i-f*h)*k, (c*h-b*i)*k, (b*f-c*e)*k,
    (f*g-d*i)*k, (a*i-c*g)*k, (c*d-a*f)*k,
    (d*h-e*g)*k, (b*g-a*h)*k, (a*e-b*d)*k
  ];
}

/* ---- CFrame helpers for authored JointInstance records ---- */
function cfFrame(cf){
  return cf&&cf.rot&&cf.rot.length===9
    ? { pos:{x:(cf.pos&&cf.pos.x)||0, y:(cf.pos&&cf.pos.y)||0, z:(cf.pos&&cf.pos.z)||0},
        rot:cf.rot.slice() }
    : { pos:{x:0,y:0,z:0}, rot:[1,0,0,0,1,0,0,0,1] };
}
/* world-space origin of a joint frame and its local X axis (the legacy
 * Motor/Rotate rotation axis) */
function jointPin(parentLook, rec, useC0){
  const P=cfFrame(parentLook&&parentLook.cf);
  const C=cfFrame(useC0? rec.c0 : rec.c1);
  const R=P.rot, Q=C.rot;
  const M=[0,0,0,0,0,0,0,0,0];
  for (let r=0;r<3;r++) for (let c=0;c<3;c++)
    M[r*3+c]=R[r*3]*Q[c]+R[r*3+1]*Q[3+c]+R[r*3+2]*Q[6+c];
  const x=C.pos.x, y=C.pos.y, z=C.pos.z;
  return {
    pivot:{ x:R[0]*x+R[1]*y+R[2]*z+P.pos.x,
            y:R[3]*x+R[4]*y+R[5]*z+P.pos.y,
            z:R[6]*x+R[7]*y+R[8]*z+P.pos.z },
    axis:{ x:M[0], y:M[3], z:M[6] },
  };
}
/* q += 0.5 * (0,w) * q * h, then normalize  FUN_005f7ee0's quaternion step */
function quatIntegrate(q, w, h){
  const qw=q[0], qx=q[1], qy=q[2], qz=q[3];
  const dw=-w.x*qx-w.y*qy-w.z*qz;
  const dx=w.x*qw+w.y*qz-w.z*qy;
  const dy=w.y*qw+w.z*qx-w.x*qz;
  const dz=w.z*qw+w.x*qy-w.y*qx;
  const s=0.5*h;
  let nw=qw+dw*s, nx=qx+dx*s, ny=qy+dy*s, nz=qz+dz*s;
  const n=Math.hypot(nw,nx,ny,nz);
  if (!(n>1e-12)){ q[0]=1; q[1]=q[2]=q[3]=0; return; }
  const inv=1/n;
  q[0]=nw*inv; q[1]=nx*inv; q[2]=ny*inv; q[3]=nz*inv;
}
/* FUN_005ed340  Elasticity property to collision restitution scalar */
function elasticFactor(e){
  const v=(typeof e==='number'&&isFinite(e))? e : 0.5;
  if (v<0.05) return 0.28;
  if (v<0.26) return 0.42;
  if (v<0.51) return 0.57;
  if (v<0.76) return 0.8;
  return 1.0;
}
function frictionOf(look){
  const v=look&&look.friction;
  return (typeof v==='number'&&isFinite(v)&&v>=0)? v : CONTACT_FRICTION;
}
function elasticityOf(look){
  const v=look&&look.elasticity;
  return (typeof v==='number'&&isFinite(v)&&v>=0)? v : 0.5;
}

/* ---------------- one welded assembly ---------------- */
/* Rigid body state: mass centroid, world-aligned body frame quaternion,
 * member poses relative to that frame, and a full 3x3 body inertia built
 * from the member boxes (own box inertia + parallel axis).  The frame
 * starts aligned with the world; it is the orientation reference the
 * quaternion integrates away from. */
function Assembly(members){
  this.members=members;
  this.sets=new Set(members);
  this.static=members.some(l=>l.anchored);
  this.vel={x:0,y:0,z:0};
  this.asleep=this.static;
  this.grounded=false;
  this.restOn=new Set();       // assemblies this one rested on (this frame)
  this.supportLooks=new Set(); // exact support parts (character carry/sleep)
  this.angVel={x:0,y:0,z:0};
  this.tipping=false;          // COM currently overhangs its support patch
  this.sideContact=false;      // a real lateral normal holds this frame
  this.contactWalls=[];        // legacy driven-path contact records
  this.movers=[];
  this.thrusts=[];             // BodyThrust: force at a local point
  for (const l of members){
    for (const c of l.part.children){
      if (c.cls==='BodyVelocity'||c.cls==='BodyPosition'||c.cls==='BodyForce')
        this.movers.push({ inst:c, kind:c.cls, look:l });
      else if (c.cls==='BodyThrust')
        this.thrusts.push({ inst:c, kind:c.cls, look:l });
    }
  }
  this.driven=this.movers.length>0;

  const n=members.length;
  this.memberMass=new Array(n);
  this._localPos=new Array(n);
  this._localRot=new Array(n);
  this._wpos=new Array(n);
  this._wrot=new Array(n);

  let M=0, cx=0, cy=0, cz=0;
  for (let i=0;i<n;i++){
    const l=members[i];
    const s=l.size||{x:1,y:1,z:1};
    const mi=Math.max(0.25, s.x*s.y*s.z);
    const p=(l.cf&&l.cf.pos)||{x:0,y:0,z:0};
    this.memberMass[i]=mi;
    M+=mi; cx+=p.x*mi; cy+=p.y*mi; cz+=p.z*mi;
  }
  this.mass=M;
  this.pos=M>0? {x:cx/M, y:cy/M, z:cz/M} : {x:0,y:0,z:0};
  this.quat=[1,0,0,0];

  /* body inertia about the COM, in the initial world-aligned body frame */
  const Ib=new Array(9).fill(0);
  let radius=0;
  for (let i=0;i<n;i++){
    const l=members[i], s=l.size||{x:1,y:1,z:1}, mi=this.memberMass[i];
    const cf=l.cf||{pos:{x:0,y:0,z:0},rot:[1,0,0,0,1,0,0,0,1]};
    const p=cf.pos, R=cf.rot||[1,0,0,0,1,0,0,0,1];
    const r={x:p.x-this.pos.x, y:p.y-this.pos.y, z:p.z-this.pos.z};
    this._localPos[i]={x:r.x, y:r.y, z:r.z};
    this._localRot[i]=R.slice();
    this._wpos[i]={x:p.x, y:p.y, z:p.z};
    this._wrot[i]=R.slice();
    const Ix=mi/12*(s.y*s.y+s.z*s.z);
    const Iy=mi/12*(s.x*s.x+s.z*s.z);
    const Iz=mi/12*(s.x*s.x+s.y*s.y);
    for (let a=0;a<3;a++){
      for (let b=0;b<3;b++){
        const t=R[a*3]*R[b*3]*Ix + R[a*3+1]*R[b*3+1]*Iy + R[a*3+2]*R[b*3+2]*Iz;
        Ib[a*3+b]+=t;
      }
    }
    const rr=r.x*r.x+r.y*r.y+r.z*r.z;
    Ib[0]+=mi*(rr-r.x*r.x); Ib[1]+=mi*(-r.x*r.y); Ib[2]+=mi*(-r.x*r.z);
    Ib[3]+=mi*(-r.y*r.x);  Ib[4]+=mi*(rr-r.y*r.y); Ib[5]+=mi*(-r.y*r.z);
    Ib[6]+=mi*(-r.z*r.x);  Ib[7]+=mi*(-r.z*r.y);  Ib[8]+=mi*(rr-r.z*r.z);
    /* bounding radius for the per-frame contact search margin */
    const hx=s.x/2, hy=s.y/2, hz=s.z/2;
    for (let c=0;c<8;c++){
      const x=(c&1?hx:-hx), y=(c&2?hy:-hy), z=(c&4?hz:-hz);
      const wx=R[0]*x+R[1]*y+R[2]*z;
      const wy=R[3]*x+R[4]*y+R[5]*z;
      const wz=R[6]*x+R[7]*y+R[8]*z;
      radius=Math.max(radius, Math.hypot(wx,wy,wz));
    }
  }
  this.iInvBody=inv3(Ib);
  this.radius=Math.max(0.1, radius);

  this.force={x:0,y:0,z:0};
  this.torque={x:0,y:0,z:0};
  this._quiet=0;
  this._still=0;
  this._stillP=null;
  this._stillQ=null;
  this._supportPts=[];
  this._supportOn=new Set();
}

/* ---------------- the world of assemblies ---------------- */
class Dynamics {
  constructor(){
    this.world=null;
    this.all=new Set();          // every registered look
    this.grid=new Map();         // cell key -> [looks]
    this.asms=[];                // live assemblies
    this.asmMap=new Map();       // look -> assembly
    this.weldEdges=new Map();    // look -> Set(explicitly welded looks)
    this.noJoin=new Map();       // broken pairs: {a,b} cannot re-auto-join yet
    this.__pairSeq=1;            // stable pair-key ids (test-visible noJoin)
    this.char=null;
    this.carry=null;             // {x,y,z} consumed once per step
    this._ready=false;
    this._dirty=false;           // joints changed → re-cluster next step
    this._pairs=new Map();       // look-pair key -> {state, ...}
    this._pairList=[];
    this._frameSeq=0;
    this._contactStamp=0;
    this._prof={ pre:0, build:0, wake:0, features:0, solve:0, integrate:0, finish:0,
                 free:0, pairs:0, contactPairs:0, ticks:0, noJoin:0 };
  }

  init(world){
    if (!world||!world.colliders) return;
    this.world=world;
    this.all=new Set();
    this.grid=new Map();
    this.weldEdges=new Map();
    this.noJoin=new Map();
    this.__pairSeq=1;
    this._dirty=false;
    this._pairs=new Map();
    this._pairList=[];
    this._frameSeq=0;
    this._contactStamp=0;
    /* Every geometric part joins the joint graph, including CanCollide=false
     * decorations (they can be welded and must travel with their assembly). */
    const src=world.partLook? Array.from(world.partLook.values()) : world.colliders;
    for (const look of src){
      if (look.destroyed||!look.aabb) continue;
      this.all.add(look);
      this._insert(look);
    }
    this._reflood();                 // the load-time auto-joint pass
    this._ready=true;
  }

  /* SurfaceType property writes: force the next step to rebuild the joint
   * graph (the engine's AutoJoin notifier re-checks contact after a surface
   * change; FUN_005b4080 → FUN_005728b0 → changed notification). */
  markDirty(){ this._dirty=true; }

  /* ---------- spatial hash ---------- */
  _insert(look){
    const cells=[];
    forEachCell(look.aabb, c=>{
      cells.push(c);
      let s=this.grid.get(c); if (!s){ s=[]; this.grid.set(c,s); }
      s.push(look);
    });
    look.__cells=cells;                // exact registration → exact removal
  }
  _neighbors(a){
    /* Set-dedup: the old indexOf scan made big cells O(n²)  the load-time
     * reflood asks this once per part (8k parts in RobloxHQ) */
    const out=[], seen=new Set();
    forEachCell(a, c=>{
      const s=this.grid.get(c);
      if (s) for (const l of s) if (!seen.has(l)){ seen.add(l); out.push(l); }
    });
    return out;
  }
  /* Candidate looks along a world ray, traversed cell-by-cell through the
   * same spatial hash.  Mouse.Target and the hand tools used to test every
   * collider in a place (8k in RobloxHQ) once per frame; this visits only
   * the cells the ray crosses.  Conservative: returns every look in those
   * cells, so the exact ray tests in world.rayHit are unchanged. */
  rayCandidates(origin, dir, maxDist){
    const out=[], seen=new Set();
    if (!this.grid.size||!origin||!dir) return out;
    const L=Math.max(0.001, maxDist||800);
    const dx=dir.x||0, dy=dir.y||0, dz=dir.z||0;
    let x=Math.floor(origin.x/CELL), y=Math.floor(origin.y/CELL), z=Math.floor(origin.z/CELL);
    const stepX=dx>0?1:(dx<0?-1:0), stepY=dy>0?1:(dy<0?-1:0), stepZ=dz>0?1:(dz<0?-1:0);
    const tdx=dx? Math.abs(CELL/dx) : Infinity;
    const tdy=dy? Math.abs(CELL/dy) : Infinity;
    const tdz=dz? Math.abs(CELL/dz) : Infinity;
    let tmx=dx? (stepX>0? (x+1)*CELL-origin.x : origin.x-x*CELL)/Math.abs(dx) : Infinity;
    let tmy=dy? (stepY>0? (y+1)*CELL-origin.y : origin.y-y*CELL)/Math.abs(dy) : Infinity;
    let tmz=dz? (stepZ>0? (z+1)*CELL-origin.z : origin.z-z*CELL)/Math.abs(dz) : Infinity;
    let t=0, guard=0;
    while (t<=L && guard++<4096){
      const s=this.grid.get(x+','+y+','+z);
      if (s) for (const l of s) if (!seen.has(l)){ seen.add(l); out.push(l); }
      if (tmx<tmy && tmx<tmz){ x+=stepX; t=tmx; tmx+=tdx; }
      else if (tmy<tmz){ y+=stepY; t=tmy; tmy+=tdy; }
      else { z+=stepZ; t=tmz; tmz+=tdz; }
      if (!isFinite(t)) break;
    }
    return out;
  }
  /* movers change cells  re-register when the span drifted (stale cells
   * would leave ghost entries / miss contacts at the new position) */
  _refresh(look){
    const old=look.__cells;
    if (!old){ this._insert(look); return; }
    const now=[];
    forEachCell(look.aabb, c=>now.push(c));
    if (now.length===old.length && now.every((c,i)=>c===old[i])) return;
    this._uninsert(look);
    this._insert(look);
  }

  /* ---------- assembly building ---------- */

  /* the mined factory chain (FUN_005f50a0): classify one touching face
   * pair. fa/fb = partFaces() entries; a/b = the two looks (for the
   * rotation gate). Returns:
   *   2 = rigid edge (weld/snap/glue  cluster together)
   *   1 = non-rigid edge (hinge/motor/stepper  collision only)
   *   0 = no joint
   * Mined gates (Roblox.exe.c):
   *   - candidate pre-filter = AABB intersect (FUN_005b76c0/005b7720)
   *     touch OR overlap, NOT flush-only. The shipped TeamBeacon proves
   *     it: 4³ Center with all-Weld(2) faces + 2³ pips that INTERSET
   *     1 stud deep, all Smooth(0), no script welds  the pips ride only
   *     because the Weld faces bond overlapping neighbors.
   *   - FUN_005a7c20 = rotation-only equality: cross products of the two
   *     bodies' basis columns within tol (0.01 snap/weld, 0.05 glue).
   *     Rotated parts do not auto-join axis-aligned ones (canon).
   *   - FUN_005f7110 = the two face normals anti-parallel within 0.35 rad.
   *   - the positional face test FUN_005f7480 is ambiguous in flat
   *     pseudocode; shipped evidence (beacon 1-stud overlap) says Weld/
   *     Glue bonds overlap range  snap stays exact (see APPROX 20).
   * Order is load-bearing: hinge/motor first, then Weld face, exact
   * Studs↔Inlet snap, then Glue face (first hit wins). */
  _rotEqual(a, b, tol){
    const ra=(a.cf&&a.cf.rot)||[1,0,0,0,1,0,0,0,1];
    const rb=(b.cf&&b.cf.rot)||[1,0,0,0,1,0,0,0,1];
    const t=(tol==null)? 0.01 : tol;
    for (let i=0;i<9;i++) if (Math.abs(ra[i]-rb[i])>t) return false;
    return true;
  }
  /* FUN_005eb0a0's face-center gate (the "centers ≤ tB" check  the tB
   * literal was not recovered, so it is ported as an overlap-area test):
   * a bond needs the two face RECTANGLES to overlap substantially, not just
   * corner-kiss.  The HHH crane parks with its handle's rear 1 stud
   * overlapping a studs-top platform 10.5 studs away  centers far apart,
   * real engine does not weld that, and the crane must stay free to travel. */
  _faceOverlapOK(fa, fb, a, b, frac){
    const ax=(Math.abs(fa.ny)>=Math.abs(fa.nx)&&Math.abs(fa.ny)>=Math.abs(fa.nz))? 1
            :(Math.abs(fa.nx)>=Math.abs(fa.nz))? 0 : 2;
    const t1=(ax===0)?1:0, t2=(ax===2)?1:2;
    const ca=[fa.px,fa.py,fa.pz], cb=[fb.px,fb.py,fb.pz];
    const A=a.aabb, B=b.aabb;
    const ha=[(A.max.x-A.min.x)/2,(A.max.y-A.min.y)/2,(A.max.z-A.min.z)/2];
    const hb=[(B.max.x-B.min.x)/2,(B.max.y-B.min.y)/2,(B.max.z-B.min.z)/2];
    const ov=t=>{
      const lo=Math.max(ca[t]-ha[t], cb[t]-hb[t]);
      const hi=Math.min(ca[t]+ha[t], cb[t]+hb[t]);
      return Math.max(0, hi-lo);
    };
    const area=ov(t1)*ov(t2);
    const minArea=Math.min(2*ha[t1]*2*ha[t2], 2*hb[t1]*2*hb[t2]);
    /* frac: rigid bonds need a real face patch (25%); a hinge hangs by
     * an EDGE (the Crossroads drawbridge covers 23% of its cube) */
    return area+1e-6 >= (frac==null? 0.25 : frac)*minArea;
  }
  /* candidate prefilter for the joint flood.  Flush contact always
   * qualifies; pairs where either side carries a Weld/Glue face also
   * qualify within the 1.2-stud overlap range (HappyHome's ramp rails
   * sit 0.4 above the structure's hinge caps and weld down to them
   * the plain touching() gate rejected every gapped weld before the
   * range check in _joinKind could run, so the ramp free-fell). */
  _canTouch(a, b){
    if (touching(a.aabb, b.aabb, CONTACT)) return true;
    const w1=a.surf&&a.surf.some(s=>s===WELD||s===GLUE);
    const w2=b.surf&&b.surf.some(s=>s===WELD||s===GLUE);
    if (w1||w2) return touching(a.aabb, b.aabb, 1.2);
    return false;
  }
  _joinKind(a, b, fa, fb){
    /* A joint broken by an Explosion (FUN_005ad770) stays cut until the
     * two parts' AABBs separate; the engine only AutoJoins on a NEW
     * contact, so touching pieces that were blown apart must not silently
     * re-weld on the next ClumpStage. */
    if (this.noJoin.size && this._pairKeyIfKnown(a,b)) return 0;
    const dot=fa.nx*fb.nx+fa.ny*fb.ny+fa.nz*fb.nz;
    if (dot > -0.9) return 0;                       // must face each other
    const sA=fa.surf, sB=fb.surf;
    /* Hinge(6) pairs are ROTATING links (kind 3): the shipped evidence
     * (Crossroads' Climb Ramp: a plank hanging off a tower cube's single
     * Hinge face, dipping into a ramp under gravity) shows a hinge face
     * bonds to ANY touching face, and the joint turns around the pin =
     * the mating faces' normal through the contact patch.  Motor(7)/
     * SteppingMotor(8) pairs stay rigid holding edges (no spin). */
    const hA=sA===HINGE, hB=sB===HINGE;
    if (hA||hB){
      /* flush-only (the drawbridge kiss is sep 0.00; the 1.2 range let
       * hinge faces bond parts merely BRUSHING  Rally's pods welding
       * the track plates) */
      const dist=(fa.px-fb.px)*fa.nx+(fa.py-fb.py)*fa.ny+(fa.pz-fb.pz)*fa.nz;
      return (Math.abs(dist)<=0.06 && this._faceOverlapOK(fa,fb,a,b,0.02))? 3:0;
    }
    if (sA>=7 && sA<=8 && sB>=7 && sB<=8){
      const dist0=(fa.px-fb.px)*fa.nx+(fa.py-fb.py)*fa.ny+(fa.pz-fb.pz)*fa.nz;
      /* Motor(7)/SteppingMotor(8) are RotateV/RotateP joints: a rotating
       * link, not a rigid weld (kind 3).  The resolver reads the face's
       * SurfaceInput/ParamB to decide whether it self-drives. */
      return (Math.abs(dist0)<=1.2 && this._faceOverlapOK(fa,fb,a,b))? 3:0;
    }
    /* Rigid family alignment is on the FACE AXES, not the whole body
     * orientation: FUN_005eb0a0 gates "axes ≤ 0.35 rad" between the two
     * touching faces (plus plane distance, checked below). The old gate here
     * demanded full rotation-matrix equality at 0.01/0.05  a part rotated
     * 90° (a wall turned to run the other way) could never weld/snap to an
     * axis-aligned neighbor even with flush anti-parallel faces, which is
     * what made surface welds silently fail across most places. */
    if (dot > -Math.cos(0.35)) return 0;            // faces anti-parallel within 0.35 rad
    const dist=(fa.px-fb.px)*fa.nx+(fa.py-fb.py)*fa.ny+(fa.pz-fb.pz)*fa.nz;
    const sep=Math.abs(dist);
    if (sA===WELD || sB===WELD)
      return (sep<=1.2 && this._faceOverlapOK(fa,fb,a,b))? 2:0;   // overlap-weld range
    if ((sA===STUDS && sB===INLET) || (sA===INLET && sB===STUDS))
      return (sep<=0.05 && this._faceOverlapOK(fa,fb,a,b))? 2:0;  // snap = flush pair
    if (sA===GLUE || sB===GLUE)
      /* Decomp glue gate is the flush 0.05 band (the 1.2 overlap window is
       * only for Weld faces, which the shipped beacons need).  A loose Glue
       * patch was welding every JetPack model to the smooth floor through a
       * P4/P5 face whose planes were over a stud apart, turning the whole
       * world static. */
      return (sep<=CONTACT && this._faceOverlapOK(fa,fb,a,b))? 2:0;
    return 0;                                       // Smooth/Spawn/Bumps bond nothing
  }
  _reflood(){
    /* preserve momentum across the ClumpStage re-cluster: an Explosion
     * kicks the welded assembly, then the joint cut forces a new flood
     * without this the kick was discarded with the old Assembly objects. */
    const prev=new Map();
    for (const [l,a] of this.asmMap) prev.set(l,{v:a.vel, w:a.angVel});
    this._refloodPrev=prev;
    this.asms=[]; this.asmMap=new Map();
    this._dirty=false;
    const visited=new Set();
    const hingeLinks=[];                      // kind-3 pairs: {a,b,fa,fb}
    for (const seed of this.all){
      if (visited.has(seed)) continue;
      const members=[seed]; visited.add(seed);
      for (let i=0;i<members.length;i++){
        const A=this.__faces(members[i]);
        const neighbors=this._neighbors(members[i].aabb);
        const explicit=this.weldEdges.get(members[i]);
        /* explicit welds (makeJoints) are invariant edges */
        if (explicit){
          for (const w of explicit){
            if (!visited.has(w) && !w.destroyed){
              if (touching(members[i].aabb, w.aabb, CONTACT)){
                visited.add(w); members.push(w);
              }
            }
          }
        }
        for (const n of neighbors){
          if (n.destroyed||!n.aabb) continue;
          if (!this._canTouch(members[i], n)) continue;
          const B=this.__faces(n);
          let rigid=false;
          /* evaluate even VISITED neighbors: hinge links connect ACROSS
           * clusters (the plank seeds its own cluster before the tower's
           * flood reaches it  skipping visited neighbors is why the
           * Crossroads drawbridge never hinged); merging stays
           * unvisited-only */
          for (const fa of A){
            if (rigid) break;
            const sa=fa.surf, bondlessA=sa<1||sa>8;     // 0 Smooth, 5 Spawn, 9+ Bumps
            for (const fb of B){
              const sb=fb.surf, bondlessB=sb<1||sb>8;
              if (bondlessA&&bondlessB) continue;       // neither face can bond
              const kind=this._joinKind(members[i], n, fa, fb);
              if (kind===2){ rigid=true; break; }
              if (kind===3&&!visited.has(n)){ hingeLinks.push({a:members[i], b:n, fa, fb}); }
            }
          }
          if (rigid&&!visited.has(n)){ visited.add(n); members.push(n); }
        }
      }
      this._make(members);
    }
    /* hinge links: parent STATIC → the child assembly swings on the pin
     * (axis = mating normal, pivot = contact-patch center)  the
     * Crossroads drawbridge.  Parent DYNAMIC → rigid merge (wheels stay
     * on cars).  Both static → nothing. */
    /* explicit JointInstance objects (Weld/Glue/Motor/RotateP/RotateV)
     * are authored joints, not surface guesses: weld/glue union the two
     * parts regardless of contact, motor classes attach a driving pin. */
    this._applyExplicitJoints();
    /* resolve every link against the FROZEN cluster map  _mergeAsms
     * mutates assemblies mid-loop and cascaded link decisions across
     * changed clusters (the Rally track meltdown) */
    const snap=new Map(this.asmMap);
    const consumed=new Set();
    const merges=[];
    for (const L of hingeLinks){
      let ca=snap.get(L.b), pa=snap.get(L.a);
      if (!ca||!pa||ca===pa) continue;
      if (consumed.has(ca)||consumed.has(pa)) continue;
      /* only SMALL child assemblies swing/merge  a hinge face brushing a
       * giant cluster (Rally wheels on the track) must not tilt or weld
       * the map */
      if (ca.members.length>8) continue;
      if (!pa.static&&(pa.members.length+ca.members.length)>12) continue;   // no giant welds
      /* the swinger must be the LIGHT side (a plank on a tower, not the
       * tower on its plank)  dynamic↔dynamic merges (wheels on cars)
       * don't need this */
      const vol=m=>m.members.reduce((s,x)=>s+Math.max(0.25,(x.size.x||1)*(x.size.y||1)*(x.size.z||1)),0);
      if (pa.static&&vol(ca)>=vol(pa)) continue;
      /* a swing arm carries no Weld/Glue faces of its own  parts that
       * weld are fixed construction (Rally's Weld-edged track plates
       * swung otherwise); the drawbridge plank is all-smooth */
      if (ca.members.some(m=>m.surf.some(s=>s===WELD||s===GLUE))) continue;
      if (pa.static&&!ca.static&&!ca.hinge){
        consumed.add(ca);
        const n=L.fa, P=L.a.aabb, Q=L.b.aabb;
        const pivot={x:0,y:0,z:0};
        const axes=['x','y','z'], N=[n.nx,n.ny,n.nz];
        for (let k=0;k<3;k++){
          const ax=axes[k];
          if (Math.abs(N[k])>0.5)
            pivot[ax]=(L.fa[{'x':'px','y':'py','z':'pz'}[ax]]+L.fb[{'x':'px','y':'py','z':'pz'}[ax]])/2;
          else
            pivot[ax]=(Math.max(P.min[ax],Q.min[ax])+Math.min(P.max[ax],Q.max[ax]))/2;
        }
        const nl=Math.hypot(n.nx,n.ny,n.nz)||1;
        ca.hinge={ axis:{x:n.nx/nl, y:n.ny/nl, z:n.nz/nl}, pivot,
                   parentLook:L.a, parent:pa };
        /* Motor(7)/SteppingMotor(8) faces: SurfaceInput NoInput(0) leaves
         * the pin free (gravity hinge below); a Constant input drives it
         * at ParamB radians per physics frame (60 Hz), the documented
         * RotateV/RotateP constant behaviour. */
        const mf=(L.fa&&L.fa.surf>=7)? L.fa : ((L.fb&&L.fb.surf>=7)? L.fb : null);
        if (mf){
          const input=Number(mf.surfInput)||0;
          if (input===12){
            const rate=(Number(mf.paramB)||0)*60;
            if (rate) ca.hinge.motor={ mode:'continuous', rate, token:mf.surf };
          } else if (input){
            ca.hinge.motor={ mode:'controller', token:mf.surf,
              ctrl:{ input, paramA:Number(mf.paramA)||0,
                     paramB:Number(mf.paramB)||0, controller:mf.controller||0,
                     look:mf.look } };
          }
        }
        ca.baseCFs=ca.members.map(m=>({pos:{x:m.cf.pos.x,y:m.cf.pos.y,z:m.cf.pos.z},
                                       rot:m.cf.rot.slice()}));
        ca.hAngle=0; ca.hOmega=0; ca.hRest=0;
      } else if (!pa.static&&!ca.static){
        consumed.add(ca); consumed.add(pa);
        merges.push([pa, ca]);
      }
    }
    for (const [p, c] of merges) this._mergeAsms(p, c);
    this._refloodPrev=null;
    this._pairs=new Map();     // member/assembly refs changed
    this._pairList=[];
  }
  _mergeAsms(parent, child){
    if (parent===child) return;
    const members=parent.members.concat(child.members);
    this._drop(parent); this._drop(child);
    const merged=this._make(members);
    merged.asleep=merged.static;
  }
  /* ------------------------------------------------------------------
   * Explicit JointInstance objects.
   * Weld/Glue: a rigid edge between two authored parts, independent of
   * surface contact (the engine's JointInstance is the bond, not a guess).
   * Motor/RotateP/RotateV: a pin joint.  Static parent → the child assembly
   * rotates about the joint's local X axis (Motor6D/legacy convention);
   * dynamic parent → merged rigid, matching the surface-hinge policy.
   * ------------------------------------------------------------------ */
  _applyExplicitJoints(){
    const w=this.world;
    const recs=w&&w.jointRecs? Array.from(w.jointRecs.values()) : [];
    if (!recs.length) return;
    const rigid=[], motors=[];
    for (const rec of recs){
      if (!rec||rec.broken) continue;
      const la=rec.aLook, lb=rec.bLook;
      if (!la||!lb||la.destroyed||lb.destroyed) continue;
      const pa=this.asmMap.get(la), pb=this.asmMap.get(lb);
      if (!pa||!pb||pa===pb) continue;
      if (rec.kind==='weld'||rec.kind==='glue') rigid.push(rec);
      else motors.push(rec);
    }
    for (const rec of rigid){
      const pa=this.asmMap.get(rec.aLook), pb=this.asmMap.get(rec.bLook);
      if (pa&&pb&&pa!==pb) this._mergeAsms(pa,pb);
    }
    for (const rec of motors){
      const la=rec.aLook, lb=rec.bLook;
      let pa=this.asmMap.get(la), pb=this.asmMap.get(lb);
      if (!pa||!pb||pa===pb) continue;
      let child=null, parentAsm=null, parentLook=null;
      if (pa.static&&!pb.static){ child=pb; parentAsm=pa; parentLook=la; }
      else if (pb.static&&!pa.static){ child=pa; parentAsm=pb; parentLook=lb; }
      else if (!pa.static&&!pb.static){
        /* two free bodies on a motor: hold them together (the engine's
         * pin would let one turn; the port keeps the authored pose rigid
         * on dynamic pairs, same policy as surface motors). */
        this._mergeAsms(pa,pb);
        continue;
      } else continue;                       /* both static: no DOF */
      if (child.hinge) continue;
      const pin=jointPin(parentLook, rec, la===parentLook);
      const motor=this._jointMotor(rec);
      child.hinge={ axis:pin.axis, pivot:pin.pivot, parentLook,
                    parent:parentAsm, motor, inst:rec.inst };
      child.baseCFs=child.members.map(m=>({pos:{x:m.cf.pos.x,y:m.cf.pos.y,z:m.cf.pos.z},
                                          rot:m.cf.rot.slice()}));
      child.hAngle=0; child.hOmega=0; child.hRest=0;
    }
  }
  _jointMotor(rec){
    const inst=rec.inst;
    const kind=rec.kind;
    if (kind==='motor'){
      /* RBX::Motor is the script servo: DesiredAngle at MaxVelocity. */
      return { mode:'servo', inst };
    }
    /* RotateV = continuous (Motor surface); RotateP = stepping
     * (SteppingMotor surface).  Both read Part0's authored surface input:
     * NoInput(0) leaves the joint free, otherwise ParamB is radians per
     * physics frame (the docs' Constant input), i.e. ParamB*60 rad/s. */
    const tok=(kind==='rotateP')? 8 : 7;
    const p=rec.aLook&&rec.aLook.part&&rec.aLook.part.props;
    if (!p) return null;
    const controller=controllerOfInst(rec.aLook.part);
    const names=['Right','Top','Back','Left','Bottom','Front'];
    for (const nm of names){
      if ((Number(p[nm+'Surface'])|0)!==tok) continue;
      const input=Number(p[nm+'SurfaceInput'])||0;
      if (!input) return null;
      if (input===12){
        const rate=(Number(p[nm+'ParamB'])||0)*60;
        return rate? { mode:'continuous', rate } : null;
      }
      return { mode:'controller',
               ctrl:{ input, paramA:Number(p[nm+'ParamA'])||0,
                      paramB:Number(p[nm+'ParamB'])||0, controller,
                      look:rec.aLook } };
    }
    return null;
  }
  /* exploded view of one look's faces; cheap and cached between moves */
  __faces(look){
    return look.__faces && !look.__faces.dirty ? look.__faces.faces :
           (look.__faces={ dirty:false, faces:partFaces(look) }).faces;
  }
  _make(members){
    const a=new Assembly(members);
    a.charAttach=members.some(l=>l.__charWeld);
    /* A welded rider must not collide with the humanoid it is welded to;
     * the physics controller skips this flag. */
    for (const l of members) l.__charIgnore=a.charAttach;
    const prev=this._refloodPrev;
    if (prev){
      let vx=0,vy=0,vz=0,wx=0,wy=0,wz=0,n=0;
      for (const l of members){
        const p=prev.get(l);
        if (!p) continue;
        vx+=p.v.x; vy+=p.v.y; vz+=p.v.z;
        wx+=p.w.x; wy+=p.w.y; wz+=p.w.z; n++;
      }
      if (n){
        a.vel={x:vx/n, y:vy/n, z:vz/n};
        a.angVel={x:wx/n, y:wy/n, z:wz/n};
      }
    }
    this.asms.push(a);
    for (const l of members) this.asmMap.set(l,a);
    return a;
  }
  _drop(a){
    const i=this.asms.indexOf(a);
    if (i>=0) this.asms.splice(i,1);
    for (const l of a.members) if (this.asmMap.get(l)===a) this.asmMap.delete(l);
  }

  /* runtime attach: own assembly + re-cluster next frame (the AutoJoin
   * notifier runs on contact  an attached part bonds per its surface
   * types when its faces are flush; Smooth faces bond nothing) */
  attach(look){
    if (!look||look.destroyed||!look.aabb) return;
    if (this.asmMap.has(look)) return;
    this.all.add(look); this._insert(look);
    this._make([look]);
    /* ClumpStage re-clusters the whole place.  That is only needed when the
     * new part can actually bond with a neighbour: an isolated projectile
     * in flight stays its own assembly, and firing used to stall for
     * 150-250 ms in a large place re-flooding every joint. */
    let touches=false;
    for (const n of this._neighbors(look.aabb)){
      if (n===look||n.destroyed||!n.aabb) continue;
      if (this._canTouch(look,n)){ touches=true; break; }
    }
    if (touches) this._dirty=true;    // ClumpStage: re-cluster next step
  }
  /* weld `inst` into everything it touches (part:makeJoints())  the Lua
   * verb is surface-independent: "join with everything it's touching".
   * These welds are INVARIANT: unlike surface joints they survive the
   * ClumpStage re-cluster (the classic engine never re-broke them). */
  _weldPair(a, b){
    if (a===b) return;
    let sa=this.weldEdges.get(a); if (!sa){ sa=new Set(); this.weldEdges.set(a,sa); }
    sa.add(b);
    let sb=this.weldEdges.get(b); if (!sb){ sb=new Set(); this.weldEdges.set(b,sb); }
    sb.add(a);
  }
  _weldBreak(look){
    const others=this.weldEdges.get(look);
    if (others){ for (const o of others){ const s=this.weldEdges.get(o); if (s) s.delete(look); } }
    return this.weldEdges.delete(look);
  }
  /* ---- explosion joint removal (FUN_00572770 → FUN_005ad810 →
   * FUN_005ad770): every joint whose Part0/Part1 is the hit body is
   * removed, unconditionally  anchored bodies included.  The engine's
   * AutoJoin only fires on a NEW contact, so the broken pairs stay
   * suppressed in `noJoin` until their AABBs separate. ---- */
  _pairId(look){
    return look.__dynPairId || (look.__dynPairId=this.__pairSeq++);
  }
  _pairKey(a, b){
    const ia=this._pairId(a), ib=this._pairId(b);
    return ia<ib? ia+':'+ib : ib+':'+ia;
  }
  _pairKeyIfKnown(a, b){
    if (!a.__dynPairId || !b.__dynPairId) return null;
    const ia=a.__dynPairId, ib=b.__dynPairId;
    return this.noJoin.has(ia<ib? ia+':'+ib : ib+':'+ia);
  }
  _markNoJoin(a, b){
    const k=this._pairKey(a,b);
    if (this.noJoin.has(k)) return false;
    this.noJoin.set(k,{a,b});
    return true;
  }
  /* the decomp cuts the hit part's joints even when the assembly is
   * anchored/immobile (the impulse pass only skips body motion). */
  breakJoints(look){
    if (!look||look.destroyed||!look.aabb) return false;
    let changed=false;
    /* authored joints (Weld/Glue/Motor/Rotate*) are real objects: an
     * explosion removes them from the world, they never rejoin. */
    const jr=this.world&&this.world.jointRecs;
    if (jr){
      for (const [inst,rec] of Array.from(jr)){
        if (rec.aLook===look || rec.bLook===look){
          jr.delete(inst);
          inst.__jointBroken=true;
          changed=true;
        }
      }
    }
    const A=this.__faces(look);
    const explicit=this.weldEdges.get(look);
    for (const n of this._neighbors(look.aabb)){
      if (n===look||n.destroyed||!n.aabb) continue;
      let joint=!!(explicit&&explicit.has(n));
      /* This pair is already cut and has not separated.  _joinKind would
       * reject every one of its 36 face pairs; skip that whole scan unless
       * an explicit makeJoints weld still needs breaking. */
      if (!joint&&this._pairKeyIfKnown(look,n)) continue;
      if (!joint && this._canTouch(look,n)){
        const B=this.__faces(n);
        for (let i=0;i<A.length&&!joint;i++)
          for (let j=0;j<B.length;j++){
            const kind=this._joinKind(look,n,A[i],B[j]);
            if (kind===2||kind===3){ joint=true; break; }
          }
      }
      if (joint&&this._markNoJoin(look,n)) changed=true;
    }
    if (this._weldBreak(look)) changed=true;
    /* An already-broken static wall must not rebuild the whole joint graph
     * again on every rocket.  Only a NEW cut is ClumpStage work. */
    if (changed) this._dirty=true;
    return changed;
  }
  /* a broken pair re-qualifies for joining once the bodies no longer
   * overlap/touch (engine: join happens on the new contact) */
  _sweepNoJoin(){
    for (const [k,p] of this.noJoin){
      if (!p.a||!p.b||p.a.destroyed||p.b.destroyed||!p.a.aabb||!p.b.aabb){
        this.noJoin.delete(k); continue;
      }
      const A=p.a.aabb, B=p.b.aabb;
      const sep=Math.max(A.min.x-B.max.x, B.min.x-A.max.x,
                         A.min.y-B.max.y, B.min.y-A.max.y,
                         A.min.z-B.max.z, B.min.z-A.max.z);
      if (sep>CONTACT) this.noJoin.delete(k);
    }
  }
  /* A script CFrame/Position write on a rigid assembly moves the whole
   * welded body, not one member.  Classic 2007 evidence: the JetPack scripts
   * reposition P3 to the torso and then call P4/P5:makeJoints(); the model
   * must travel with P3 for those parts to reach the character at all. */
  moveAssembly(look, cf){
    const a=this.asmMap.get(look);
    if (!a||a.static||!look.cf||!cf) return false;
    const oldP=look.cf.pos, oldR=look.cf.rot;
    const newP=cf.pos||oldP, newR=cf.rot||oldR;
    /* q = newR * oldR^T (both row-major); t = newP - q*oldP */
    const R=matMul3(newR, matT3(oldR));
    const qp=matVec3(R, oldP);
    const tx=newP.x-qp.x, ty=newP.y-qp.y, tz=newP.z-qp.z;
    for (const m of a.members){
      if (!m.cf||m.destroyed) continue;
      const p=m.cf.pos, r=m.cf.rot;
      const np={x:R[0]*p.x+R[1]*p.y+R[2]*p.z+tx,
                y:R[3]*p.x+R[4]*p.y+R[5]*p.z+ty,
                z:R[6]*p.x+R[7]*p.y+R[8]*p.z+tz};
      const nr=matMul3(R,r);
      if (window.RBLXenv&&window.RBLXenv.placePart)
        window.RBLXenv.placePart(m.part,{pos:np,rot:nr});
      if (m.__faces) m.__faces.dirty=true;
      this._refresh(m);
    }
    a.pos=matVec3(R,a.pos);
    a.pos.x+=tx; a.pos.y+=ty; a.pos.z+=tz;
    a.asleep=false;
    this._dirty=true;            // rebuild around the new member poses
    return true;
  }
  makeJoints(inst, seen){
    const look=this.world&&this.world.partLook? this.world.partLook.get(inst) : null;
    if (!look||!look.aabb||(seen&&seen.has(look))) return seen;
    // flood from this look across contacting members of any assembly
    const members=[look], visited=new Set([look]);
    for (let i=0;i<members.length;i++){
      for (const n of this._neighbors(members[i].aabb)){
        if (visited.has(n)) continue;
        if (n.destroyed||n===look) continue;          // dead bricks weld nothing
        if (!touching(members[i].aabb, n.aabb, CONTACT)) continue;
        visited.add(n); members.push(n);
      }
    }
    if (seen) for (const l of visited) seen.add(l);
    /* makeJoints() against the character: the rig's Part instances are
     * virtual in the port, so test their live world boxes here.  Mark only
     * the parts actually in contact; _make propagates that to the assembly. */
    const charBoxes=this._characterPartBoxes();
    if (charBoxes){
      for (const l of visited){
        for (const box of charBoxes){
          if (touching(l.aabb, box, CONTACT)){ l.__charWeld=true; break; }
        }
      }
    }
    /* Drop only the affected assemblies, and hand their non-visited
     * members back to the graph.  The old loop dropped each visited
     * member's whole assembly and recreated only the visited set, so a
     * partial makeJoints (JetPack P4/P5 after P3 moves) silently orphaned
     * every sibling that was not in the flood. */
    const affected=new Set();
    for (const l of visited){
      const na=this.asmMap.get(l);
      if (na) affected.add(na);
    }
    const leftovers=[];
    for (const asm of affected){
      const rest=asm.members.filter(l=>!visited.has(l));
      this._drop(asm);
      if (rest.length) leftovers.push(rest);
    }
    const welded=Array.from(visited);
    /* Only local neighbours can touch: the old all-pairs scan was O(N²)
     * (a restored 465-part model ran 108k touch tests, and Model:MakeJoints
     * ran it once per part).  The grid already indexes exact AABBs. */
    for (const l of welded){
      for (const n of this._neighbors(l.aabb)){
        if (n===l||!visited.has(n)||n.destroyed||!n.aabb) continue;
        if (touching(l.aabb, n.aabb, CONTACT)) this._weldPair(l, n);
      }
    }
    const a=this._make(welded);
    a.asleep=a.static;                // fresh weld: static if rooted
    for (const rest of leftovers){
      this._make(rest);               // temporary split; full reflood next step
      this._dirty=true;
    }
    return seen||visited;
  }
  /* part destroyed / removed  break the joints through it (JointStage
   * scraps them on both sides) and let the next ClumpStage re-cluster */
  detach(look){
    if (!look) return;
    this._uninsert(look);
    this.all.delete(look);
    delete look.__faces;
    this._weldBreak(look);
    const a=this.asmMap.get(look);
    if (a) this._drop(a);
    this._dirty=true;
  }
  _uninsert(look){
    const cells=look.__cells;
    if (cells){
      for (const c of cells){
        const s=this.grid.get(c);
        if (!s) continue;
        const i=s.indexOf(look);
        if (i>=0) s.splice(i,1);
        if (s.length===0) this.grid.delete(c);
      }
      delete look.__cells;
      return;
    }
    forEachCell(look.aabb, c=>{
      const s=this.grid.get(c);
      if (!s) return;
      const i=s.indexOf(look);
      if (i>=0) s.splice(i,1);
      if (s.length===0) this.grid.delete(c);
    });
  }
  /* Anchored flip at runtime: the cluster's root changes (cluster root
   * comparator is anchored-first)  re-cluster next step */
  setAnchored(look, v){
    if (!look) return;
    const was=look.anchored;
    look.anchored=!!v;
    if (was!==look.anchored){
      const a=this.asmMap.get(look);
      if (a) this._drop(a);
      this._dirty=true;
    }
  }

  /* ---- Explosion impulse (FUN_006029c0) --------------------------
   * The decomp adds `direction * pressure * boundingRadius²` to the body
   * velocity. The exact inverse-mass term lives in the inlined integrator,
   * so use a mass-scaled form with a gameplay cap. `seen` de-duplicates
   * multiple hit parts belonging to the same welded assembly. */
  _assemblyMass(a){
    let m=0;
    for (const l of a.members){
      const s=l.size||{x:1,y:1,z:1};
      m+=Math.max(0.1, s.x*s.y*s.z*0.7);
    }
    return Math.max(0.5, m);
  }
  _blastAssembly(a, pos, partBox, pressure, seen){
    if (!a || a.static) return false;
    if (seen){
      if (seen.has(a)) return false;
      seen.add(a);
    }
    let br=partBox? 0.5*Math.hypot(partBox.sx,partBox.sy,partBox.sz) : 0;
    let cx=partBox? partBox.cx : 0, cy=partBox? partBox.cy : 0, cz=partBox? partBox.cz : 0;
    if (!partBox){
      const box={ min:{x:1e9,y:1e9,z:1e9}, max:{x:-1e9,y:-1e9,z:-1e9} };
      for (const l of a.members){
        const b=l.aabb;
        if (b.min.x<box.min.x) box.min.x=b.min.x;
        if (b.max.x>box.max.x) box.max.x=b.max.x;
        if (b.min.y<box.min.y) box.min.y=b.min.y;
        if (b.max.y>box.max.y) box.max.y=b.max.y;
        if (b.min.z<box.min.z) box.min.z=b.min.z;
        if (b.max.z>box.max.z) box.max.z=b.max.z;
      }
      cx=(box.min.x+box.max.x)/2; cy=(box.min.y+box.max.y)/2; cz=(box.min.z+box.max.z)/2;
      br=0.5*Math.hypot(box.max.x-box.min.x, box.max.y-box.min.y, box.max.z-box.min.z);
    }
    let dx=cx-pos.x, dy=cy-pos.y, dz=cz-pos.z;
    const d=Math.hypot(dx,dy,dz);
    if (d<1e-4){ dx=0; dy=1; dz=0; }
    const n=Math.hypot(dx,dy,dz)||1;
    const pr=Math.max(0, pressure==null? BLAST_PRESSURE : pressure);
    const dv=Math.min(BLAST_CAP, pr*br*br/(this._assemblyMass(a)*BLAST_DIV));
    if (!(dv>0)) return false;
    a.vel.x+=dx/n*dv;
    a.vel.y+=dy/n*dv;
    a.vel.z+=dz/n*dv;
    a.asleep=false;
    this.wakeAround(a);
    return true;
  }
  /* Apply one hit part's radial kick after its joints have been cut and
   * the graph has been rebuilt.  Kept separate from breakJoints so a whole
   * explosion can share ONE ClumpStage pass instead of rebuilding the world
   * once per brick. */
  _blastPartAfterCut(look, pos, radius, pressure, seen){
    if (!look||look.destroyed||!look.aabb) return false;
    const a=this.asmMap.get(look);
    if (!a || a.static) return false;
    const s=look.size||{x:1,y:1,z:1};
    const br=0.5*Math.hypot(s.x,s.y,s.z);
    if (!(br<radius*2)) return false;
    const cx=(look.aabb.min.x+look.aabb.max.x)/2;
    const cy=(look.aabb.min.y+look.aabb.max.y)/2;
    const cz=(look.aabb.min.z+look.aabb.max.z)/2;
    let dx=cx-pos.x, dy=cy-pos.y, dz=cz-pos.z;
    if (Math.hypot(dx,dy,dz)<1e-4){ dx=0; dy=1; dz=0; }
    const n=Math.hypot(dx,dy,dz)||1;
    const pr=Math.max(0, pressure==null? BLAST_PRESSURE : pressure);
    const partMass=Math.max(0.1, s.x*s.y*s.z*0.7);
    const dv=Math.min(BLAST_CAP, pr*br*br/(partMass*BLAST_DIV));
    if (!(dv>0)) return false;
    a.vel.x+=dx/n*dv;
    a.vel.y+=dy/n*dv;
    a.vel.z+=dz/n*dv;
    a.asleep=false;
    this.wakeAround(a);
    if (seen) seen.add(a);
    return true;
  }
  /* one part hit by the world blast query.  FUN_006029c0 runs per hit
   * part AFTER FUN_00572770 cut its joints, so each part gets its own
   * radial kick; the kick is deferred until _reflood has split the old
   * welded assembly into the post-break bodies (otherwise one direction
   * would be imposed on every piece). */
  blastPart(look, pos, radius, pressure, seen){
    if (!look||look.destroyed||!look.aabb) return false;
    /* FUN_00572770 runs per HIT PART before the body-motion branch  the
     * joints through an anchored brick are cut too.  Re-cluster at once:
     * the impulse below lands on the post-break body, exactly like the
     * engine's per-part pass (and the piece moves this same tick). */
    this.breakJoints(look);
    if (this._dirty) this._reflood();
    return this._blastPartAfterCut(look,pos,radius,pressure,seen);
  }
  /* Bulk form used by WorldBuilder.explodeAt.  Cutting N touching bricks
   * used to run N full-world _reflood() passes synchronously (a large wall
   * froze the browser for seconds).  All cuts are independent, so make them
   * first, rebuild the final graph once, then kick the post-split bodies. */
  blastParts(looks, pos, radius, pressure, seen){
    if (!looks||!looks.length) return false;
    for (const look of looks) this.breakJoints(look);
    if (this._dirty) this._reflood();
    let kicked=false;
    for (const look of looks)
      if (this._blastPartAfterCut(look,pos,radius,pressure,seen)) kicked=true;
    return kicked;
  }
  /* compatibility helper used by tests/tools: blast every dynamic assembly
   * whose bounding sphere is inside the query radius */
  kick(pos, radius, pressure){
    const seen=new Set();
    for (const a of this.asms){
      if (a.static) continue;
      let minx=1e9,miny=1e9,minz=1e9,maxx=-1e9,maxy=-1e9,maxz=-1e9;
      for (const l of a.members){
        const b=l.aabb;
        if (!b) continue;
        if (b.min.x<minx) minx=b.min.x; if (b.max.x>maxx) maxx=b.max.x;
        if (b.min.y<miny) miny=b.min.y; if (b.max.y>maxy) maxy=b.max.y;
        if (b.min.z<minz) minz=b.min.z; if (b.max.z>maxz) maxz=b.max.z;
      }
      if (minx>maxx) continue;
      const br=0.5*Math.hypot(maxx-minx,maxy-miny,maxz-minz);
      const cx=(minx+maxx)/2, cy=(miny+maxy)/2, cz=(minz+maxz)/2;
      if (Math.hypot(cx-pos.x,cy-pos.y,cz-pos.z)>radius+br) continue;
      this._blastAssembly(a, pos, {cx,cy,cz,sx:maxx-minx,sy:maxy-miny,sz:maxz-minz},
                          pressure, seen);
    }
  }

  setCharacter(c){
    this.char=c;
    this.carry=null;
    /* a new humanoid must not inherit the old body's welded models */
    for (const l of this.all){ delete l.__charWeld; delete l.__charIgnore; }
    for (const a of this.asms){ a.charAttach=false; a._charWeld=null; }
  }

  /* immobile = will never integrate: anchored itself, or welded (transit-
   * ivively) to an anchored member  the world.js static render batch merges
   * exactly these.  Free dynamic assemblies are never batched; if a batched
   * part's assembly ever comes alive, placePart() fires and the batch
   * rebuilds without it. */
  isImmobile(look){
    if (!look||look.destroyed) return false;
    if (look.anchored) return true;
    const a=this.asmMap.get(look);
    return !!(a&&a.static);
  }

  /* consumed once by physics.js each step: assemblies the character
   * stands on translate the character with them (elevator ride) */
  takeCarry(){
    const c=this.carry; this.carry=null; return c;
  }
  _charOn(a){
    const c=this.char;
    if (!c||!c.groundLook||!a.sets.has(c.groundLook)) return false;
    return true;
  }
  /* A part with a script-written Velocity is integrated by rbxenv's mover
   * path (gravity + terrain probe + Touched).  Running the free-body solver
   * on the same assembly applied gravity twice and overwrote the mover pose,
   * so projectiles such as the shipped Harpoon dropped instead of flying. */
  _isScriptMover(a){
    if (!a||!a.members) return false;
    for (const m of a.members) if (m&&m.scriptMover&&!m.destroyed) return true;
    return false;
  }
  /* World AABBs of the character's body parts.  The classic rig parts are
   * real Parts in Workspace, so makeJoints() can weld a touched model to
   * the torso even though the port renders the rig separately. */
  _characterPartBoxes(){
    const c=this.char;
    if (!c||!c.parts||!c.partWorldCF) return null;
    const out=[];
    for (const nm of Object.keys(c.parts)){
      const rec=c.parts[nm];
      if (!rec||!rec.size) continue;
      const cf=c.partWorldCF(nm);
      const R=cf.rot, s=rec.size;
      const ex=Math.abs(R[0])*s.x/2+Math.abs(R[1])*s.y/2+Math.abs(R[2])*s.z/2;
      const ey=Math.abs(R[3])*s.x/2+Math.abs(R[4])*s.y/2+Math.abs(R[5])*s.z/2;
      const ez=Math.abs(R[6])*s.x/2+Math.abs(R[7])*s.y/2+Math.abs(R[8])*s.z/2;
      out.push({ parts:nm, min:{x:cf.pos.x-ex,y:cf.pos.y-ey,z:cf.pos.z-ez},
                 max:{x:cf.pos.x+ex,y:cf.pos.y+ey,z:cf.pos.z+ez} });
    }
    return out;
  }

  /* ================================================================
   * per-step integration
   * ================================================================ */
  step(dt){
    if (!this._ready) return;
    /* dt<=0 is a re-cluster tick only (scripts can attach/detach joints
     * between frames); pending ClumpStage work still has to land. */
    if (!(dt>0)){
      if (this._dirty){
        this._reflood();
        this._pairs=new Map();
        this._pairList=[];
      }
      return;
    }
    dt=Math.min(dt,0.1);                  // keep a long frame bounded
    const P=this._prof;
    const t0=performance.now();
    this._sweepNoJoin();                  // separated blast cuts may rejoin
    P.noJoin=this.noJoin.size;
    if (this._dirty){
      this._reflood();                    // ClumpStage pass (joints changed)
      this._pairs=new Map();              // member/assembly refs changed
      this._pairList=[];
    }
    /* Hinged assemblies swing kinematically on their pin and mover-driven
     * assemblies keep the translation model their shipped scripts were
     * tuned against.  Everything else runs the client force solver. */
    for (const a of this.asms.slice()){
      if (a.static) continue;
      if (a.asleep && a.movers.length) a.asleep=false;  // script can command any tick
      if (a.asleep && a.thrusts.length) a.asleep=false;  // BodyThrust keeps pushing
      if (a.asleep) continue;
      if (this._isScriptMover(a)) continue;           // rbxenv mover owns it
      if (a.hinge){ this._stepHinged(a, dt); continue; }
      if (a.movers.length){
        a.restOn.clear();
        a.supportLooks.clear();
        this._stepDriven(a, dt);
      }
    }
    P.pre=performance.now()-t0;
    this._stepBodies(dt);
  }
  /* --- rotating hinge (kind 3, static parent) ----------------------
   * Gravity torque about the pin integrates a swing angle; members are
   * the BASE pose rotated by (pivot, axis, angle).  A static contact
   * freezes the swing (the Crossroads drawbridge rests when its far end
   * grounds).  No decomp torque constants were recoverable  the
   * angular model is the plain rigid-pendulum form (APPROX). */
  _stepHinged(a, dt){
    const h=a.hinge;
    if (h.parentLook.destroyed || this.asmMap.get(h.parentLook)!==h.parent){
      a.hinge=null;                             // anchor gone → free body
      a.restOn.clear();
      return;                                   // _stepBodies picks it up
    }
    if (h.motor){ this._stepMotor(a, dt); return; }
    if (a.hRest>45){ a.asleep=true; return; }
    const ax=h.axis, pv=h.pivot;
    let tau=0, I=0;
    for (let i=0;i<a.members.length;i++){
      const m=a.members[i], s=m.size;
      const mass=Math.max(0.25, s.x*s.y*s.z);
      const b=a.baseCFs[i];
      const r={x:b.pos.x-pv.x, y:b.pos.y-pv.y, z:b.pos.z-pv.z};
      /* (r × (0,−mg,0))·axis = m·g·(r.z·ax.y − r.x·ax.z) */
      tau += mass*GRAV*(r.z*ax.y - r.x*ax.z);
      const rp=r.x*ax.x+r.y*ax.y+r.z*ax.z;
      const rx=r.x-rp*ax.x, ry=r.y-rp*ax.y, rz=r.z-rp*ax.z;
      I += mass*(rx*rx+ry*ry+rz*rz);
    }
    if (I<1e-6) return;
    a.hOmega += (tau/I)*dt;
    a.hOmega *= 0.995;
    let angle=a.hAngle + a.hOmega*dt;
    if (Math.abs(angle)>3.1){ angle=Math.sign(angle)*3.1; a.hOmega=0; }
    if (this._applyHinge(a, angle, true)){
      a.hAngle=angle;
      a.hRest=0;
    } else {
      this._applyHinge(a, a.hAngle, false);     // keep the resting pose
      a.hOmega=0;
      a.hRest++;
    }
  }
  /* driven pin: RBX::Motor is a servo (DesiredAngle at MaxVelocity);
   * RotateV/RotateP surface pins are continuous at a fixed rate. */
  _stepMotor(a, dt){
    const h=a.hinge, mo=h.motor;
    let angle=a.hAngle;
    if (mo.mode==='servo'){
      const inst=mo.inst;
      if (!inst){ a.hinge=null; return; }
      const desired=Number(inst.props.DesiredAngle)||0;
      const maxV=Number(inst.props.MaxVelocity);
      if (maxV>0){
        let d=desired-a.hAngle;
        const step=maxV*dt;
        if (Math.abs(d)>step) d=Math.sign(d)*step;
        angle=a.hAngle+d;
      }
      inst.props.CurrentAngle=angle;
    } else if (mo.mode==='controller'){
      const rate=controllerInputRate(mo.ctrl);
      angle=a.hAngle + rate*dt;
      if (angle>Math.PI) angle-=Math.PI*2;
      else if (angle<-Math.PI) angle+=Math.PI*2;
      if (mo.inst) mo.inst.props.CurrentAngle=angle;
    } else {
      angle=a.hAngle + (Number(mo.rate)||0)*dt;
      /* keep the stored angle bounded; rotation is periodic */
      if (angle>Math.PI) angle-=Math.PI*2;
      else if (angle<-Math.PI) angle+=Math.PI*2;
      if (mo.inst) mo.inst.props.CurrentAngle=angle;
    }
    if (!isFinite(angle)) angle=a.hAngle;
    this._applyHinge(a, angle, false);
    a.hAngle=angle;
    a.hRest=0;
  }
  /* rotate every member from its base pose by (pivot,axis,angle);
   * probe=true returns false if the rotated body would embed in a
   * static neighbor (rest contact) */
  _applyHinge(a, angle, probe){
    const h=a.hinge, ax=h.axis, pv=h.pivot;
    const c=Math.cos(angle), s=Math.sin(angle), t=1-c;
    const R=[t*ax.x*ax.x+c,      t*ax.x*ax.y-s*ax.z, t*ax.x*ax.z+s*ax.y,
             t*ax.x*ax.y+s*ax.z, t*ax.y*ax.y+c,      t*ax.y*ax.z-s*ax.x,
             t*ax.x*ax.z-s*ax.y, t*ax.y*ax.z+s*ax.x, t*ax.z*ax.z+c];
    for (let i=0;i<a.members.length;i++){
      const m=a.members[i];
      if (m.destroyed) continue;
      const b=a.baseCFs[i];
      const ox=b.pos.x-pv.x, oy=b.pos.y-pv.y, oz=b.pos.z-pv.z;
      const np={ x:R[0]*ox+R[1]*oy+R[2]*oz+pv.x,
                 y:R[3]*ox+R[4]*oy+R[5]*oz+pv.y,
                 z:R[6]*ox+R[7]*oy+R[8]*oz+pv.z };
      const B=b.rot;
      const nr=[ R[0]*B[0]+R[1]*B[3]+R[2]*B[6], R[0]*B[1]+R[1]*B[4]+R[2]*B[7], R[0]*B[2]+R[1]*B[5]+R[2]*B[8],
                 R[3]*B[0]+R[4]*B[3]+R[5]*B[6], R[3]*B[1]+R[4]*B[4]+R[5]*B[7], R[3]*B[2]+R[4]*B[5]+R[5]*B[8],
                 R[6]*B[0]+R[7]*B[3]+R[8]*B[6], R[6]*B[1]+R[7]*B[4]+R[8]*B[7], R[6]*B[2]+R[7]*B[5]+R[8]*B[8] ];
      if (probe){
        const hx=m.size.x/2, hy=m.size.y/2, hz=m.size.z/2;
        const ex=Math.abs(nr[0])*hx+Math.abs(nr[1])*hy+Math.abs(nr[2])*hz;
        const ey=Math.abs(nr[3])*hx+Math.abs(nr[4])*hy+Math.abs(nr[5])*hz;
        const ez=Math.abs(nr[6])*hx+Math.abs(nr[7])*hy+Math.abs(nr[8])*hz;
        const bb={ min:{x:np.x-ex,y:np.y-ey,z:np.z-ez}, max:{x:np.x+ex,y:np.y+ey,z:np.z+ez} };
        for (const n of this._neighbors(bb)){
          if (n.destroyed||a.sets.has(n)||n.canCollide===false) continue;
          const pa=this.asmMap.get(n);
          if (!pa||pa===a||(!pa.static&&!pa.asleep)) continue;
          if (n===h.parentLook) continue;       // only the PIN OWNER kisses  its cluster's other members (the Floor!) still block
          const Bb=n.aabb;
          const ox2=Math.min(bb.max.x-Bb.min.x,Bb.max.x-bb.min.x);
          const oy2=Math.min(bb.max.y-Bb.min.y,Bb.max.y-bb.min.y);
          const oz2=Math.min(bb.max.z-Bb.min.z,Bb.max.z-bb.min.z);
          if (ox2>0.05&&oy2>0.05&&oz2>0.05) return false;
        }
      }
      if (window.RBLXenv&&window.RBLXenv.placePart)
        window.RBLXenv.placePart(m.part, { pos:np, rot:nr });
      this._refresh(m);
    }
    return true;
  }
  /* --- force-solver frame: all free rigid bodies -------------------
   * Candidate pairs are gathered once per frame from AABBs expanded by
   * the frame's travel (so a fast body cannot tunnel past the list),
   * then the client's 19-substeps-per-1/240s loop integrates forces and
   * torques at h = frame/(19*ticks).  Positions are committed to the
   * scene once per frame; contact geometry reads the in-memory member
   * poses, not the stale scene CFrames. */
  _stepBodies(dt){
    this._frameSeq++;
    const P=this._prof;
    P.build=0; P.wake=0; P.features=0; P.solve=0; P.integrate=0; P.finish=0; P.contactPairs=0;
    /* Gather the bodies this frame actually integrates BEFORE building
     * contact pairs.  A scene at rest (or with only sleepers/static
     * geometry) then costs one array scan instead of a broadphase pass
     * every 1/60 s.  Hinges and script movers were already stepped in
     * step(); they are not force-solved here. */
    const free=[];
    for (const a of this.asms)
      if (!a.static&&!a.asleep&&!a.hinge&&!a.movers.length&&!this._isScriptMover(a)) free.push(a);
    if (!free.length){
      this._pairs=new Map();
      this._pairList=[];
      return;
    }
    let pt=performance.now();
    this._buildPairs(dt);
    P.build=performance.now()-pt; pt=performance.now();
    if (this._wakePairs()){
      this._buildPairs(dt);                          // newly awake support pairs
      /* a woken sleeper joins this frame's solve, as before */
      free.length=0;
      for (const a of this.asms)
        if (!a.static&&!a.asleep&&!a.hinge&&!a.movers.length&&!this._isScriptMover(a)) free.push(a);
      if (!free.length){ this._pairs=new Map(); this._pairList=[]; return; }
    }
    P.wake=performance.now()-pt;
    for (const a of free){
      a.grounded=false;
      a.tipping=false;
      a.sideContact=false;
      a._supportPts.length=0;
      a._supportOn=new Set();
      a.restOn.clear();
      a.supportLooks.clear();
    }
    const rides=[];
    for (const a of free){
      if (!this._charOn(a)) continue;
      const look=this.char.groundLook;
      if (look&&look.cf)
        rides.push({ look, start:{x:look.cf.pos.x,y:look.cf.pos.y,z:look.cf.pos.z} });
    }
    const ticks=Math.max(1, Math.min(8, Math.round(dt*TICK_HZ)));
    const nSub=ticks*SUBSTEPS;
    const h=dt/nSub;
    P.free=free.length; P.pairs=this._pairList.length; P.ticks=ticks;
    const activeAsms=new Set();
    for (let t=0;t<ticks;t++){
      /* World-space member poses and the inverse inertia only change
       * slowly across the 19 force substeps; refresh them per kernel tick. */
      for (const a of free){
        this._updateMemberPoses(a);
        const R=quatToMat(a.quat);
        a._winv=matMul3(matMul3(R,a.iInvBody),matT3(R));
      }
      /* Collision detection once per 1/240 s kernel tick. */
      pt=performance.now();
      let contactPairs=0;
      for (const pair of this._pairList){
        const f=this._features(pair);
        /* Drop spring state whose feature was not refreshed during the
         * previous tick.  Keys are stable ordinals now, but edges still
         * appear/disappear and a pruned entry costs nothing; leaving
         * dead keys in the map leaks memory over a long session. */
        if (pair.state && pair.state.size){
          for (const [k,st] of pair.state)
            if (st.last!==this._contactStamp) pair.state.delete(k);
        }
        if (f.length){
          const H=pair.incB?pair.fa:pair.fb, I=pair.incB?pair.fb:pair.fa;
          pair.hostAsm=H; pair.incAsm=I;
          pair.hIdx=pair.incB?pair.ia:pair.ib;
          pair.iIdx=pair.incB?pair.ib:pair.ia;
          pair.geom=f; contactPairs++;
        } else pair.geom=null;
      }
      P.features+=performance.now()-pt; P.contactPairs=contactPairs;
      activeAsms.clear();
      for (const pair of this._pairList){
        if (!pair.geom) continue;
        activeAsms.add(pair.hostAsm); activeAsms.add(pair.incAsm);
      }
      for (let s=0;s<SUBSTEPS;s++){
        const stamp=++this._contactStamp;
        /* The manifold is refreshed per tick, but separations and force
         * arms must track the CURRENT rotation and translation within the
         * tick: a translation-only refresh smeared rotating contact
         * corners by up to a box thickness, and the spring read that as
         * fresh penetration (energy injection  bouncing plate stacks
         * never slept).  Each point stores its anchor in the owning
         * member's box frame and the normal in the contact-plane frame;
         * rebuilding it from the current quaternion is exact for this
         * corner/plane model and far cheaper than re-running SAT. */
        pt=performance.now();
        for (const a of activeAsms) a._Rsub=quatToMat(a.quat);
        for (const pair of this._pairList){
          const g=pair.geom; if (!g) continue;
          const H=pair.hostAsm, I=pair.incAsm;
          const Rh=H._Rsub, Ri=I._Rsub;
          const hLp=H._localPos[pair.hIdx], hLr=H._localRot[pair.hIdx];
          const iLp=I._localPos[pair.iIdx], iLr=I._localRot[pair.iIdx];
          const hLook=pair.incB?pair.ma:pair.mb, iLook=pair.incB?pair.mb:pair.ma;
          /* Static/sleeping partners do not move during any of the 76
           * substeps.  Their look CFrame is already the exact world pose;
           * rebuilding it from the assembly COM/body quaternion for every
           * contact was pure overhead (especially against the baseplate). */
          const hFixed=H.static||H.asleep, iFixed=I.static||I.asleep;
          const hcf=hFixed?hLook.cf:null, icf=iFixed?iLook.cf:null;
          let hpx,hpy,hpz,ipx,ipy,ipz;
          let hr0,hr1,hr2,hr3,hr4,hr5,hr6,hr7,hr8;
          let ir0,ir1,ir2,ir3,ir4,ir5,ir6,ir7,ir8;
          if (hcf){
            hpx=hcf.pos.x; hpy=hcf.pos.y; hpz=hcf.pos.z;
            hr0=hcf.rot[0]; hr1=hcf.rot[1]; hr2=hcf.rot[2];
            hr3=hcf.rot[3]; hr4=hcf.rot[4]; hr5=hcf.rot[5];
            hr6=hcf.rot[6]; hr7=hcf.rot[7]; hr8=hcf.rot[8];
          } else {
            hpx=H.pos.x+Rh[0]*hLp.x+Rh[1]*hLp.y+Rh[2]*hLp.z;
            hpy=H.pos.y+Rh[3]*hLp.x+Rh[4]*hLp.y+Rh[5]*hLp.z;
            hpz=H.pos.z+Rh[6]*hLp.x+Rh[7]*hLp.y+Rh[8]*hLp.z;
            hr0=Rh[0]*hLr[0]+Rh[1]*hLr[3]+Rh[2]*hLr[6];
            hr1=Rh[0]*hLr[1]+Rh[1]*hLr[4]+Rh[2]*hLr[7];
            hr2=Rh[0]*hLr[2]+Rh[1]*hLr[5]+Rh[2]*hLr[8];
            hr3=Rh[3]*hLr[0]+Rh[4]*hLr[3]+Rh[5]*hLr[6];
            hr4=Rh[3]*hLr[1]+Rh[4]*hLr[4]+Rh[5]*hLr[7];
            hr5=Rh[3]*hLr[2]+Rh[4]*hLr[5]+Rh[5]*hLr[8];
            hr6=Rh[6]*hLr[0]+Rh[7]*hLr[3]+Rh[8]*hLr[6];
            hr7=Rh[6]*hLr[1]+Rh[7]*hLr[4]+Rh[8]*hLr[7];
            hr8=Rh[6]*hLr[2]+Rh[7]*hLr[5]+Rh[8]*hLr[8];
          }
          if (icf){
            ipx=icf.pos.x; ipy=icf.pos.y; ipz=icf.pos.z;
            ir0=icf.rot[0]; ir1=icf.rot[1]; ir2=icf.rot[2];
            ir3=icf.rot[3]; ir4=icf.rot[4]; ir5=icf.rot[5];
            ir6=icf.rot[6]; ir7=icf.rot[7]; ir8=icf.rot[8];
          } else {
            ipx=I.pos.x+Ri[0]*iLp.x+Ri[1]*iLp.y+Ri[2]*iLp.z;
            ipy=I.pos.y+Ri[3]*iLp.x+Ri[4]*iLp.y+Ri[5]*iLp.z;
            ipz=I.pos.z+Ri[6]*iLp.x+Ri[7]*iLp.y+Ri[8]*iLp.z;
            ir0=Ri[0]*iLr[0]+Ri[1]*iLr[3]+Ri[2]*iLr[6];
            ir1=Ri[0]*iLr[1]+Ri[1]*iLr[4]+Ri[2]*iLr[7];
            ir2=Ri[0]*iLr[2]+Ri[1]*iLr[5]+Ri[2]*iLr[8];
            ir3=Ri[3]*iLr[0]+Ri[4]*iLr[3]+Ri[5]*iLr[6];
            ir4=Ri[3]*iLr[1]+Ri[4]*iLr[4]+Ri[5]*iLr[7];
            ir5=Ri[3]*iLr[2]+Ri[4]*iLr[5]+Ri[5]*iLr[8];
            ir6=Ri[6]*iLr[0]+Ri[7]*iLr[3]+Ri[8]*iLr[6];
            ir7=Ri[6]*iLr[1]+Ri[7]*iLr[4]+Ri[8]*iLr[7];
            ir8=Ri[6]*iLr[2]+Ri[7]*iLr[5]+Ri[8]*iLr[8];
          }
          for (const q of g){
            if (q.own){
              const cx=hpx+hr0*q.lx+hr1*q.ly+hr2*q.lz;
              const cy=hpy+hr3*q.lx+hr4*q.ly+hr5*q.lz;
              const cz=hpz+hr6*q.lx+hr7*q.ly+hr8*q.lz;
              const nx=ir0*q.nlx+ir1*q.nly+ir2*q.nlz;
              const ny=ir3*q.nlx+ir4*q.nly+ir5*q.nlz;
              const nz=ir6*q.nlx+ir7*q.nly+ir8*q.nlz;
              const plane=ipx*nx+ipy*ny+ipz*nz-q.iSup;
              q.nx=nx; q.ny=ny; q.nz=nz;
              q.sep=plane-(cx*nx+cy*ny+cz*nz);
              q.px=cx; q.py=cy; q.pz=cz;
            } else {
              const cx=ipx+ir0*q.lx+ir1*q.ly+ir2*q.lz;
              const cy=ipy+ir3*q.lx+ir4*q.ly+ir5*q.lz;
              const cz=ipz+ir6*q.lx+ir7*q.ly+ir8*q.lz;
              const nx=hr0*q.nlx+hr1*q.nly+hr2*q.nlz;
              const ny=hr3*q.nlx+hr4*q.nly+hr5*q.nlz;
              const nz=hr6*q.nlx+hr7*q.nly+hr8*q.nlz;
              const plane=hpx*nx+hpy*ny+hpz*nz+q.hSup;
              q.nx=nx; q.ny=ny; q.nz=nz;
              q.sep=cx*nx+cy*ny+cz*nz-plane;
              q.px=cx; q.py=cy; q.pz=cz;
            }
          }
        }
        P.features+=performance.now()-pt;
        for (const a of free){
          a.force.x=0; a.force.y=-GRAV*a.mass; a.force.z=0;
          a.torque.x=0; a.torque.y=0; a.torque.z=0;
          if (a.thrusts.length) this._applyThrusts(a, h);
        }
        pt=performance.now();
        for (const pair of this._pairList){
          if (!pair.geom) continue;
          this._solvePair(pair,stamp,h,pair.geom,s===SUBSTEPS-1);
        }
        P.solve+=performance.now()-pt;
        pt=performance.now();
        for (const a of free) this._integrateFree(a,h);
        P.integrate+=performance.now()-pt;
      }
    }
    pt=performance.now();
    for (const a of free){
      this._updateMemberPoses(a);
      this._finishFree(a);
    }
    this._sleepIslands(free);
    for (const a of free) this._commitFree(a);
    P.finish=performance.now()-pt;
    for (const r of rides){
      if (!r.look.cf) continue;
      this.carry={ x:r.look.cf.pos.x-r.start.x,
                   y:r.look.cf.pos.y-r.start.y,
                   z:r.look.cf.pos.z-r.start.z };
    }
  }
  /* An assembly just woke (sleep→false) or is about to move: the bodies
   * RESTING ON it must wake too, or they keep floating where their bed
   * was.  Only the supported direction propagates  the old pass woke
   * every sleeping assembly in the neighbouring spatial cells, so one
   * settling plate kept a whole decorative pile awake forever. */
  wakeAround(a){
    const todo=[a], seen=new Set([a]);
    while (todo.length){
      const cur=todo.pop();
      for (const m of cur.members){
        if (!m.aabb) continue;
        for (const n of this._neighbors(m.aabb)){
          const nb=this.asmMap.get(n);
          if (!nb||seen.has(nb)||!nb.asleep||nb.static) continue;
          if (!nb.restOn.has(cur)) continue;    // only the stack above
          if (!touching(m.aabb,n.aabb,0.15)) continue;
          seen.add(nb); nb.asleep=false;
          todo.push(nb);                        // propagate up the stack
        }
      }
    }
  }
  /* ---------- contact pair gathering ----------
   * One entry per member look pair.  The state map is the connector's
   * persistent memory (stored separation references and a tangential
   * displacement accumulator), keyed by the stable support feature so
   * it survives across substeps and frames. */
  _pairMargin(a, dt){
    if (a.static||a.asleep||a.hinge||a.movers.length||this._isScriptMover(a)) return 0.2;
    const v=Math.hypot(a.vel.x,a.vel.y,a.vel.z);
    const w=Math.hypot(a.angVel.x,a.angVel.y,a.angVel.z);
    return Math.min(4, 0.2+(v+w*a.radius)*dt*1.5);
  }
  _buildPairs(dt){
    const next=new Map();
    for (const a of this.asms){
      if (a.static||a.asleep||a.hinge||a.movers.length||this._isScriptMover(a)) continue;
      /* Sweep each body by ITS OWN travel.  One fast blast fragment used to
       * fatten every active body's query by the global maximum (4 studs),
       * creating hundreds of impossible pairs throughout the debris pile. */
      const margin=this._pairMargin(a,dt);
      for (const ma of a.members){
        const A=ma.aabb;
        if (!A||ma.destroyed||ma.canCollide===false) continue;
        const bb={ min:{x:A.min.x-margin,y:A.min.y-margin,z:A.min.z-margin},
                   max:{x:A.max.x+margin,y:A.max.y+margin,z:A.max.z+margin} };
        for (const mb of this._neighbors(bb)){
          if (mb===ma||mb.destroyed||!mb.aabb||mb.canCollide===false) continue;
          /* the spatial hash returns whole cells; keep only boxes that
           * actually overlap the swept AABB (RobloxHQ: 8k parts make the
           * cell lists huge, and nearly all of them are not contacts) */
          if (!touching(bb, mb.aabb, 0)) continue;
          const b=this.asmMap.get(mb);
          /* Hinged and mover-driven assemblies are handled by their own
           * kinematic/legacy paths; static and sleeping bodies are valid
           * contact partners for the force solver. */
          if (!b||b===a||b.hinge||b.movers.length||this._isScriptMover(b)) continue;
          const key=this._pairKey(ma,mb);
          if (next.has(key)) continue;
          let p=this._pairs.get(key);
          if (!p||p.fa!==a||p.fb!==b||p.ma!==ma||p.mb!==mb){
            const va=(ma.size?ma.size.x*ma.size.y*ma.size.z:1);
            const vb=(mb.size?mb.size.x*mb.size.y*mb.size.z:1);
            p={ key, fa:a, fb:b, ma, mb,
                ia:a.members.indexOf(ma), ib:b.members.indexOf(mb),
                incB:vb<=va,
                state:new Map(), touched:-1 };
          }
          if (p.ia<0||p.ib<0) continue;
          p.mu=Math.min(frictionOf(ma),frictionOf(mb));
          p.elastic=elasticFactor(Math.min(elasticityOf(ma),elasticityOf(mb)));
          next.set(key,p);
        }
      }
    }
    this._pairs=next;
    this._pairList=Array.from(next.values());
  }
  /* wake a sleeping body that a moving awake body can reach this frame:
   * the candidate pair already came from the mover's expanded AABB, so a
   * relative speed over the threshold means a real hit is imminent and
   * the body must be awake BEFORE penetration builds.  A resting stack
   * has near-zero relative speed and stays asleep support-on-support. */
  _wakePairs(){
    let woke=0;
    for (const pair of this._pairList){
      const fa=pair.fa, fb=pair.fb;
      if (fa.static||fb.static) continue;
      if (fa.asleep===fb.asleep) continue;
      const sleeper=fa.asleep?fa:fb;
      const mover=fa.asleep?fb:fa;
      if (sleeper.static||mover.static||mover.asleep) continue;
      /* The bed itself woke/moved: anything that slept on it can no
       * longer trust its pose, even at lowspeed. */
      const supportMoved=sleeper.restOn.has(mover);
      const rel=Math.hypot(mover.vel.x-sleeper.vel.x,
                           mover.vel.y-sleeper.vel.y,
                           mover.vel.z-sleeper.vel.z)
                + Math.hypot(mover.angVel.x,mover.angVel.y,mover.angVel.z)*mover.radius;
      let depth=0;
      if (!supportMoved && rel<=WAKE_REL){
        const feats=this._features(pair);
        for (const f of feats) if (-f.sep>depth) depth=-f.sep;
      }
      if (supportMoved||rel>WAKE_REL||depth>0.12){
        sleeper.asleep=false;
        sleeper._quiet=0;
        this.wakeAround(sleeper);
        woke++;
      }
    }
    return woke;
  }
  _memberPose(asm, idx, look){
    if (asm&&!asm.static&&!asm.hinge&&!asm.movers.length&&asm._wpos[idx])
      return { pos:asm._wpos[idx], rot:asm._wrot[idx] };
    const cf=look.cf||{ pos:{x:0,y:0,z:0}, rot:[1,0,0,0,1,0,0,0,1] };
    return { pos:cf.pos, rot:cf.rot };
  }
  _cornersOfPose(pos, rot, size){
    const hx=size.x/2, hy=size.y/2, hz=size.z/2;
    const out=new Array(8);
    for (let i=0;i<8;i++){
      const x=(i&1?hx:-hx), y=(i&2?hy:-hy), z=(i&4?hz:-hz);
      out[i]={ x:rot[0]*x+rot[1]*y+rot[2]*z+pos.x,
               y:rot[3]*x+rot[4]*y+rot[5]*z+pos.y,
               z:rot[6]*x+rot[7]*y+rot[8]*z+pos.z };
    }
    return out;
  }
  _toLocalPoint(p, pos, rot){
    const dx=p.x-pos.x, dy=p.y-pos.y, dz=p.z-pos.z;
    return { x:rot[0]*dx+rot[3]*dy+rot[6]*dz,
             y:rot[1]*dx+rot[4]*dy+rot[7]*dz,
             z:rot[2]*dx+rot[5]*dy+rot[8]*dz };
  }
  _toLocalDir(nx,ny,nz,rot){
    return { x:rot[0]*nx+rot[3]*ny+rot[6]*nz,
             y:rot[1]*nx+rot[4]*ny+rot[7]*nz,
             z:rot[2]*nx+rot[5]*ny+rot[8]*nz };
  }
  /* point in an oriented box: returns local coordinates when inside */
  _localInBox(p, pos, rot, half){
    const dx=p.x-pos.x, dy=p.y-pos.y, dz=p.z-pos.z;
    const lx=rot[0]*dx+rot[3]*dy+rot[6]*dz;
    const ly=rot[1]*dx+rot[4]*dy+rot[7]*dz;
    const lz=rot[2]*dx+rot[5]*dy+rot[8]*dz;
    if (Math.abs(lx)<=half[0]+1e-6 &&
        Math.abs(ly)<=half[1]+1e-6 &&
        Math.abs(lz)<=half[2]+1e-6)
      return { x:lx, y:ly, z:lz };
    return null;
  }
  /* OBB contact manifold.  The 15-axis separating-axis test finds the
   * minimum-overlap axis; that axis is the contact normal (host ->
   * incident).  Contact points are the incident corners inside the host
   * (or vice versa for crossing boxes); each carries its own separation
   * from the contact plane.  This is the geometry the client's contact
   * dispatch feeds into the spring: a flush aligned pair must resolve
   * across the real overlap axis, not a zero-width side plane. */
  _features(pair){
    const host=pair.incB? this._memberPose(pair.fa,pair.ia,pair.ma)
                        : this._memberPose(pair.fb,pair.ib,pair.mb);
    const inc =pair.incB? this._memberPose(pair.fb,pair.ib,pair.mb)
                        : this._memberPose(pair.fa,pair.ia,pair.ma);
    const hostLook=pair.incB? pair.ma : pair.mb;
    const incLook =pair.incB? pair.mb : pair.ma;
    const hs=hostLook.size||{x:1,y:1,z:1};
    const is=incLook.size||{x:1,y:1,z:1};
    const hh=[hs.x/2,hs.y/2,hs.z/2];
    const ih=[is.x/2,is.y/2,is.z/2];
    const HR=host.rot, IR=inc.rot;
    const Hax=[[HR[0],HR[3],HR[6]],[HR[1],HR[4],HR[7]],[HR[2],HR[5],HR[8]]];
    const Iax=[[IR[0],IR[3],IR[6]],[IR[1],IR[4],IR[7]],[IR[2],IR[5],IR[8]]];
    const dist={x:inc.pos.x-host.pos.x, y:inc.pos.y-host.pos.y, z:inc.pos.z-host.pos.z};
    let best=Infinity, nx=0, ny=0, nz=0;
    const test=(ax,ay,az)=>{
      const L=Math.hypot(ax,ay,az);
      if (L<1e-6) return true;              // parallel edge axes carry no info
      ax/=L; ay/=L; az/=L;
      let rh=0, ri=0;
      for (let k=0;k<3;k++){
        rh+=hh[k]*Math.abs(Hax[k][0]*ax+Hax[k][1]*ay+Hax[k][2]*az);
        ri+=ih[k]*Math.abs(Iax[k][0]*ax+Iax[k][1]*ay+Iax[k][2]*az);
      }
      const d=dist.x*ax+dist.y*ay+dist.z*az;
      const ov=rh+ri-Math.abs(d);
      if (ov<0) return false;               // separating axis
      if (ov<best){
        best=ov;
        const s=d<0?-1:1;
        nx=ax*s; ny=ay*s; nz=az*s;
      }
      return true;
    };
    for (const a of Hax) if (!test(a[0],a[1],a[2])) return [];
    for (const a of Iax) if (!test(a[0],a[1],a[2])) return [];
    for (let i=0;i<3;i++)
      for (let j=0;j<3;j++){
        const a=Hax[i], b=Iax[j];
        if (!test(a[1]*b[2]-a[2]*b[1],
                  a[2]*b[0]-a[0]*b[2],
                  a[0]*b[1]-a[1]*b[0])) return [];
      }
    if (!(best>0)) return [];               // touching flush, no overlap yet
    /* support distances of each box along the contact normal; the host's
     * +n face and the incident's -n face are the two candidate contact
     * planes.  Each point gets its own separation from that plane so a
     * tilted body feels a real restoring torque (the client's geometry
     * returns a per-point separation, not one pair-wide depth). */
    let hSup=0, iSup=0;
    for (let k=0;k<3;k++){
      hSup+=hh[k]*Math.abs(Hax[k][0]*nx+Hax[k][1]*ny+Hax[k][2]*nz);
      iSup+=ih[k]*Math.abs(Iax[k][0]*nx+Iax[k][1]*ny+Iax[k][2]*nz);
    }
    const hostPlane=host.pos.x*nx+host.pos.y*ny+host.pos.z*nz+hSup;
    const incPlane =inc.pos.x*nx+inc.pos.y*ny+inc.pos.z*nz-iSup;
    const out=[];
    /* Contact geometry has to survive the 19 substeps that follow this
     * detection pass: store each point in the owning member's box frame
     * and the normal in the contact-plane member's frame, so the solver
     * can refresh separations/arms from the CURRENT quaternions.  A
     * translation-only refresh let rotating thin plates smear their
     * cached corner depth by up to a full thickness per tick  the
     * spring then injected energy and stacks never settled. */
    const nlH=this._toLocalDir(nx,ny,nz,host.rot);
    const incCorners=this._cornersOfPose(inc.pos,inc.rot,is);
    for (let i=0;i<8;i++){
      const c=incCorners[i];
      if (!this._localInBox(c,host.pos,host.rot,hh)) continue;
      const depth=Math.min(best, hostPlane-(c.x*nx+c.y*ny+c.z*nz));
      if (!(depth>0)) continue;
      const lp=this._toLocalPoint(c,inc.pos,inc.rot);
      out.push({ key:'i'+i, nx, ny, nz, sep:-depth,
                 px:c.x, py:c.y, pz:c.z, face:0, own:0,
                 lx:lp.x, ly:lp.y, lz:lp.z,
                 nlx:nlH.x, nly:nlH.y, nlz:nlH.z, hSup, iSup });
    }
    if (out.length) return out;
    const nlI=this._toLocalDir(nx,ny,nz,inc.rot);
    const hostCorners=this._cornersOfPose(host.pos,host.rot,hs);
    for (let i=0;i<8;i++){
      const c=hostCorners[i];
      if (!this._localInBox(c,inc.pos,inc.rot,ih)) continue;
      const depth=Math.min(best, (c.x*nx+c.y*ny+c.z*nz)-incPlane);
      if (!(depth>0)) continue;
      const lp=this._toLocalPoint(c,host.pos,host.rot);
      out.push({ key:'h'+i, nx, ny, nz, sep:-depth,
                 px:c.x, py:c.y, pz:c.z, face:0, own:1,
                 lx:lp.x, ly:lp.y, lz:lp.z,
                 nlx:nlI.x, nly:nlI.y, nlz:nlI.z, hSup, iSup });
    }
    if (out.length) return out;
    /* crossing boxes: no corner inside the other (plus-shaped overlap).
     * Clip the incident edges against the host slab and use the inside
     * segments' endpoints; the SAT normal still carries the response. */
    const edges=[[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]];
    for (const [a0,a1] of edges){
      const p0=incCorners[a0], p1=incCorners[a1];
      const seg=this._clipSegmentBox(p0,p1,host.pos,host.rot,hh);
      /* The clip parameter t creeps with every rotation, so it must NOT
       * be part of the feature key: a fresh key every tick means a fresh
       * spring state (s1=sep, Fn=0) every tick and the contact force
       * never accumulates -- thin plate stacks then oscillated forever
       * and pair.state grew without bound.  Entry/exit order (t0<=t1)
       * is stable, so use the endpoint ordinal instead. */
      for (let ei=0;ei<seg.length;ei++){
        const q=seg[ei];
        const depth=Math.min(best, hostPlane-(q.x*nx+q.y*ny+q.z*nz));
        if (!(depth>0)) continue;
        const lp=this._toLocalPoint(q,inc.pos,inc.rot);
        out.push({ key:'e'+a0+'_'+a1+'_'+ei, nx, ny, nz, sep:-depth,
                   px:q.x, py:q.y, pz:q.z, face:0, own:0,
                   lx:lp.x, ly:lp.y, lz:lp.z,
                   nlx:nlH.x, nly:nlH.y, nlz:nlH.z, hSup, iSup });
      }
    }
    return out;
  }
  /* Liang-Barsky segment/box clip in host-local space; returns endpoints
   * of the inside portion (entry first, exit second). */
  _clipSegmentBox(p0,p1,pos,rot,half){
    const toLocal=(p)=>{
      const dx=p.x-pos.x, dy=p.y-pos.y, dz=p.z-pos.z;
      return { x:rot[0]*dx+rot[3]*dy+rot[6]*dz,
               y:rot[1]*dx+rot[4]*dy+rot[7]*dz,
               z:rot[2]*dx+rot[5]*dy+rot[8]*dz };
    };
    const a=toLocal(p0), b=toLocal(p1);
    let t0=0, t1=1;
    const dx=b.x-a.x, dy=b.y-a.y, dz=b.z-a.z;
    const P=[-dx,dx,-dy,dy,-dz,dz];
    const Q=[a.x+half[0],half[0]-a.x,a.y+half[1],half[1]-a.y,a.z+half[2],half[2]-a.z];
    for (let i=0;i<6;i++){
      if (Math.abs(P[i])<1e-9){ if (Q[i]<0) return []; continue; }
      const r=Q[i]/P[i];
      if (P[i]<0){ if (r>t1) return []; if (r>t0) t0=r; }
      else        { if (r<t0) return []; if (r<t1) t1=r; }
    }
    const out=[];
    for (const t of [t0,t1]){
      const l={x:a.x+dx*t, y:a.y+dy*t, z:a.z+dz*t};
      out.push({ t:t.toFixed(4),
                 x:rot[0]*l.x+rot[1]*l.y+rot[2]*l.z+pos.x,
                 y:rot[3]*l.x+rot[4]*l.y+rot[5]*l.z+pos.y,
                 z:rot[6]*l.x+rot[7]*l.y+rot[8]*l.z+pos.z });
    }
    return out;
  }
  _velocityAt(a, rx,ry,rz){
    return { x:a.vel.x + a.angVel.y*rz - a.angVel.z*ry,
             y:a.vel.y + a.angVel.z*rx - a.angVel.x*rz,
             z:a.vel.z + a.angVel.x*ry - a.angVel.y*rx };
  }
  _applyForce(a, px,py,pz, fx,fy,fz){
    if (!a||a.static||a.asleep) return;
    a.force.x+=fx; a.force.y+=fy; a.force.z+=fz;
    const rx=px-a.pos.x, ry=py-a.pos.y, rz=pz-a.pos.z;
    a.torque.x+=ry*fz-rz*fy;
    a.torque.y+=rz*fx-rx*fz;
    a.torque.z+=rx*fy-ry*fx;
  }
  _recordSupport(body, other, nx,ny,nz, f, supporterLook){
    if (!body||body.static||body.asleep) return;
    if (ny<=0.5){
      /* A lateral/underside normal still holds the body: thin plates
       * wedged into a wall recess have their COM outside the hull of
       * the up-facing points but are in static equilibrium, so this
       * must clear the tipping gate below. */
      if (-ny<=0.5) body.sideContact=true;
      return;
    }
    body.grounded=true;
    body.restOn.add(other);
    body.supportLooks.add(supporterLook);
    body._supportOn.add(other);
    body._supportPts.push({x:f.px,z:f.pz});
  }
  _solvePair(pair, stamp, h, feats, recordSupport){
    const A=pair.fa, B=pair.fb;
    if ((A.static||A.asleep)&&(B.static||B.asleep)) return;
    if (this.contactHook && pair.touched!==this._frameSeq){
      pair.touched=this._frameSeq;
      this.contactHook(pair.ma,pair.mb);
    }
    const hostAsm=pair.incB? A : B;
    const incAsm =pair.incB? B : A;
    const hostLook=pair.incB? pair.ma : pair.mb;
    const incLook =pair.incB? pair.mb : pair.ma;
    const hostDyn=!hostAsm.static&&!hostAsm.asleep;
    const incDyn =!incAsm.static&&!incAsm.asleep;
    if (!hostDyn&&!incDyn) return;
    const k=CONTACT_STIFFNESS*Math.max(0.05,Math.min(hostAsm.mass,incAsm.mass));
    const kSep=k*(pair.elastic||0.57);
    const fd=CONTACT_DAMP*k;
    const mu=pair.mu||CONTACT_FRICTION;
    for (const f of feats){
      let st=pair.state.get(f.key);
      if (!st){
        st={s1:0,s2:0,acc:{x:0,y:0,z:0},last:-2,normal:0};
        pair.state.set(f.key,st);
      }
      if (st.last!==stamp-1){
        st.s1=0; st.s2=0; st.normal=0;
        st.acc.x=0; st.acc.y=0; st.acc.z=0;
      }
      st.last=stamp;
      if (!(f.sep<0)){
        st.s1=0; st.s2=0; st.normal=0;
        st.acc.x=0; st.acc.y=0; st.acc.z=0;
        continue;
      }
      const nxx=f.nx, nyy=f.ny, nzz=f.nz;
      const rHx=f.px-hostAsm.pos.x, rHy=f.py-hostAsm.pos.y, rHz=f.pz-hostAsm.pos.z;
      const rIx=f.px-incAsm.pos.x,  rIy=f.py-incAsm.pos.y,  rIz=f.pz-incAsm.pos.z;
      const vH=hostDyn? this._velocityAt(hostAsm,rHx,rHy,rHz)
                      : {x:0,y:0,z:0};
      const vI=incDyn? this._velocityAt(incAsm,rIx,rIy,rIz)
                     : {x:0,y:0,z:0};
      const vx=vI.x-vH.x, vy=vI.y-vH.y, vz=vI.z-vH.z;
      const vn=vx*nxx+vy*nyy+vz*nzz;
      /* ContactConnector::update 0x611e00: two stored separation
       * references; +0x38 decays and drives the force, +0x3c gates it
       * when the current separation is shallower than the previous one.
       * +0x3c initialises to the separation only when +0x38 is still
       * unset; otherwise it starts at 0 (decomp 0x611e00). */
      const old1=st.s1, old2=st.s2;
      let ns2;
      if (old2!==0) ns2=(old2+SEP_OFFSET)*SEP_DECAY-SEP_OFFSET;
      else {
        ns2=f.sep;
        if (old1!==0) ns2=0;
      }
      let ns1;
      if (old1!==0) ns1=(old1+SEP_OFFSET)*SEP_DECAY-SEP_OFFSET;
      else ns1=f.sep;
      st.s1=ns1; st.s2=ns2;
      const kk=vn>=0? kSep : k;
      let Fn=(ns1-f.sep)*kk;
      if (ns2<f.sep) Fn=0;
      if (!(Fn>0)) Fn=0;
      /* tangential accumulator (client +0x44..0x4c): accumulates the
       * relative tangential displacement, then the force is -0.2*k*acc,
       * clamped to mu*N.  The clamp uses the normal force stored by the
       * PREVIOUS substep (+0x40 is read before it is rewritten). */
      st.acc.x+=vx*h; st.acc.y+=vy*h; st.acc.z+=vz*h;
      const maxAcc=mu*(st.normal||0)/(fd>0?fd:1);
      let al=Math.hypot(st.acc.x,st.acc.y,st.acc.z);
      if (al>maxAcc){
        const sc=maxAcc/(al||1);
        st.acc.x*=sc; st.acc.y*=sc; st.acc.z*=sc;
        al=maxAcc;
      }
      const an=st.acc.x*nxx+st.acc.y*nyy+st.acc.z*nzz;
      st.acc.x-=an*nxx; st.acc.y-=an*nyy; st.acc.z-=an*nzz;
      const fx=nxx*Fn-fd*st.acc.x;
      const fy=nyy*Fn-fd*st.acc.y;
      const fz=nzz*Fn-fd*st.acc.z;
      st.normal=Fn;
      if (recordSupport&&Fn>1e-9){
        /* Sleep/carry/support hulls are per-FRAME data.  Recording the same
         * contact in all 19 substeps only grew duplicate point arrays and
         * Sets; sample once per kernel tick while forces still run at the
         * client's full substep rate. */
        this._recordSupport(hostAsm,incAsm,-nxx,-nyy,-nzz,f,incLook);
        this._recordSupport(incAsm,hostAsm,nxx,nyy,nzz,f,hostLook);
      }
      this._applyForce(hostAsm,f.px,f.py,f.pz,-fx,-fy,-fz);
      this._applyForce(incAsm, f.px,f.py,f.pz, fx, fy, fz);
    }
  }
  _updateMemberPoses(a){
    const R=quatToMat(a.quat);
    for (let i=0;i<a.members.length;i++){
      const lp=a._localPos[i], lr=a._localRot[i];
      const wp=a._wpos[i], wr=a._wrot[i];
      wp.x=a.pos.x+R[0]*lp.x+R[1]*lp.y+R[2]*lp.z;
      wp.y=a.pos.y+R[3]*lp.x+R[4]*lp.y+R[5]*lp.z;
      wp.z=a.pos.z+R[6]*lp.x+R[7]*lp.y+R[8]*lp.z;
      wr[0]=R[0]*lr[0]+R[1]*lr[3]+R[2]*lr[6];
      wr[1]=R[0]*lr[1]+R[1]*lr[4]+R[2]*lr[7];
      wr[2]=R[0]*lr[2]+R[1]*lr[5]+R[2]*lr[8];
      wr[3]=R[3]*lr[0]+R[4]*lr[3]+R[5]*lr[6];
      wr[4]=R[3]*lr[1]+R[4]*lr[4]+R[5]*lr[7];
      wr[5]=R[3]*lr[2]+R[4]*lr[5]+R[5]*lr[8];
      wr[6]=R[6]*lr[0]+R[7]*lr[3]+R[8]*lr[6];
      wr[7]=R[6]*lr[1]+R[7]*lr[4]+R[8]*lr[7];
      wr[8]=R[6]*lr[2]+R[7]*lr[5]+R[8]*lr[8];
    }
  }
  _integrateFree(a,h){
    if (!a||a.static||a.asleep) return;
    const invM=1/a.mass;
    a.vel.x+=a.force.x*invM*h;
    a.vel.y+=a.force.y*invM*h;
    a.vel.z+=a.force.z*invM*h;
    const Winv=a._winv||matMul3(matMul3(quatToMat(a.quat),a.iInvBody),matT3(quatToMat(a.quat)));
    a.angVel.x*=ANG_DAMP; a.angVel.y*=ANG_DAMP; a.angVel.z*=ANG_DAMP;
    const dw=matVec3(Winv,a.torque);
    a.angVel.x+=dw.x*h; a.angVel.y+=dw.y*h; a.angVel.z+=dw.z*h;
    a.pos.x+=a.vel.x*h;
    a.pos.y+=a.vel.y*h;
    a.pos.z+=a.vel.z*h;
    quatIntegrate(a.quat,a.angVel,h);
  }
  _finishFree(a){
    const speed=Math.hypot(a.vel.x,a.vel.y,a.vel.z);
    const ang=Math.hypot(a.angVel.x,a.angVel.y,a.angVel.z);
    if (a.grounded && a._supportPts.length){
      const hull=this._hull2(a._supportPts);
      if (hull.length && !this._pointInHull(a.pos.x,a.pos.z,hull)) a.tipping=true;
    } else if (a.grounded){
      a.tipping=true;
    }
    /* A body pinned between neighbours (castle plate in a wall slot)
     * is held by side normals; the COM can sit outside the vertical
     * support hull and still be at rest.  Only an overhang with no
     * lateral support is a live tipping state. */
    if (a.tipping && a.sideContact) a.tipping=false;
    if (speed<SETTLE && ang<ANG_SLEEP && a.grounded) a._quiet++;
    else a._quiet=0;
    /* displacement probe: catches perpetual contact-spring jitter that
     * never drops below the instantaneous velocity/angular thresholds */
    if (!a._stillP){
      a._stillP={x:a.pos.x,y:a.pos.y,z:a.pos.z};
      a._stillQ={x:a.quat.x,y:a.quat.y,z:a.quat.z,w:a.quat.w};
      a._still=0;
    } else {
      const p=a._stillP, q=a.quat, o=a._stillQ;
      const d=Math.hypot(a.pos.x-p.x, a.pos.y-p.y, a.pos.z-p.z);
      const dq=Math.abs(q.x-o.x)+Math.abs(q.y-o.y)+Math.abs(q.z-o.z)+Math.abs(q.w-o.w);
      if (d>STILL_POS || dq>STILL_ROT){
        p.x=a.pos.x; p.y=a.pos.y; p.z=a.pos.z;
        o.x=q.x; o.y=q.y; o.z=q.z; o.w=q.w;
        a._still=0;
      } else a._still++;
    }
  }
  /* Wake/sleep in contact islands.  A body that sleeps on its own while
   * a neighbour it touches is still awake gets woken again on the next
   * frame by that neighbour's tiny residual motion; the pair then keeps
   * trading sleep/wake forever (thin plates on a castle roof oscillated
   * with a 6-frame period for minutes).  An island may sleep only when
   * every member has been quiet for QUIET_FRAMES; its beds must be
   * static/asleep or part of the same sleeping island. */
  _sleepIslands(free){
    if (!free||!free.length) return;
    const active=new Set();
    for (const a of free) if (!a.asleep) active.add(a);
    if (!active.size) return;
    const adj=new Map();
    for (const pair of this._pairList){
      if (!pair.geom) continue;
      const A=pair.fa, B=pair.fb;
      if (!active.has(A)||!active.has(B)) continue;
      let l=adj.get(A); if (!l){ l=[]; adj.set(A,l); } l.push(B);
      l=adj.get(B); if (!l){ l=[]; adj.set(B,l); } l.push(A);
    }
    const seen=new Set();
    for (const root of active){
      if (seen.has(root)) continue;
      const comp=[], stack=[root];
      seen.add(root);
      while (stack.length){
        const a=stack.pop(); comp.push(a);
        const ns=adj.get(a);
        if (!ns) continue;
        for (const b of ns) if (!seen.has(b)){ seen.add(b); stack.push(b); }
      }
      let ok=true;
      for (const a of comp){
        if (a.tipping||!a.grounded){ ok=false; break; }
        /* asleep by the instantaneous thresholds, or by the displacement
         * probe (contact-spring jitter keeps ω alive forever on a block
         * that is not actually moving) */
        if (a._quiet<QUIET_FRAMES && a._still<STILL_FRAMES){ ok=false; break; }
        for (const b of a._supportOn){
          if (b&&!b.static&&!b.asleep&&!active.has(b)){ ok=false; break; }
        }
        if (!ok) break;
      }
      if (!ok) continue;
      for (const a of comp){
        a.asleep=true;
        a._quiet=0;
        a._still=0;
        a._stillP=null;
        a._stillQ=null;
        a.vel.x=0; a.vel.y=0; a.vel.z=0;
        a.angVel.x=0; a.angVel.y=0; a.angVel.z=0;
        a.force.x=0; a.force.y=0; a.force.z=0;
        a.torque.x=0; a.torque.y=0; a.torque.z=0;
      }
    }
  }
  _commitFree(a){
    for (let i=0;i<a.members.length;i++){
      const m=a.members[i];
      if (!m||m.destroyed) continue;
      const p=a._wpos[i], r=a._wrot[i];
      if (window.RBLXenv&&window.RBLXenv.placePart)
        window.RBLXenv.placePart(m.part,{ pos:{x:p.x,y:p.y,z:p.z}, rot:r.slice() });
      if (m.__faces) m.__faces.dirty=true;
      this._refresh(m);
    }
  }
  /* monotone-chain convex hull of xz points (CCW).  Support points repeat
   * once per substep with tiny numerical drift, so quantise before the
   * chain: 19 near-identical copies of a 2-point sliver otherwise form a
   * degenerate polygon that fails the point-in-polygon test. */
  _hull2(points){
    if (!points||points.length<2) return (points||[]).slice();
    const uniq=[], seen=new Set();
    for (const q of points){
      const k=Math.round(q.x*1000)+','+Math.round(q.z*1000);
      if (seen.has(k)) continue;
      seen.add(k); uniq.push(q);
    }
    if (uniq.length<2) return uniq;
    const p=uniq.sort((a,b)=>a.x-b.x||a.z-b.z);
    const cross=(o,a,b)=>(a.x-o.x)*(b.z-o.z)-(a.z-o.z)*(b.x-o.x);
    const lower=[];
    for (const q of p){
      while (lower.length>=2 && cross(lower[lower.length-2],lower[lower.length-1],q)<=1e-9) lower.pop();
      lower.push(q);
    }
    const upper=[];
    for (let i=p.length-1;i>=0;i--){
      const q=p[i];
      while (upper.length>=2 && cross(upper[upper.length-2],upper[upper.length-1],q)<=1e-9) upper.pop();
      upper.push(q);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }
  _pointInHull(px,pz,hull){
    if (!hull||!hull.length) return false;
    if (hull.length===1) return Math.hypot(px-hull[0].x,pz-hull[0].z)<=TIP_EPS;
    if (hull.length===2){
      const A=hull[0], B=hull[1];
      const vx=B.x-A.x, vz=B.z-A.z, L=vx*vx+vz*vz||1;
      const t=Math.max(0,Math.min(1,((px-A.x)*vx+(pz-A.z)*vz)/L));
      return Math.hypot(px-(A.x+vx*t), pz-(A.z+vz*t))<=TIP_EPS;
    }
    /* a support patch can legitimately collapse to a line (a plate
     * resting on two corners).  The polygon then has ~zero area and the
     * edge half-planes are numerically meaningless; fall back to the
     * segment distance. */
    let area=0;
    for (let i=0;i<hull.length;i++){
      const A=hull[i], B=hull[(i+1)%hull.length];
      area+=A.x*B.z-B.x*A.z;
    }
    if (Math.abs(area)<1e-4){
      let A=hull[0], B=hull[0], best=-1;
      for (const q of hull){
        const d=(q.x-A.x)*(q.x-A.x)+(q.z-A.z)*(q.z-A.z);
        if (d>best){ best=d; B=q; }
      }
      const vx=B.x-A.x, vz=B.z-A.z, L=vx*vx+vz*vz||1;
      const t=Math.max(0,Math.min(1,((px-A.x)*vx+(pz-A.z)*vz)/L));
      return Math.hypot(px-(A.x+vx*t), pz-(A.z+vz*t))<=TIP_EPS;
    }
    for (let i=0;i<hull.length;i++){
      const A=hull[i], B=hull[(i+1)%hull.length];
      if ((B.x-A.x)*(pz-A.z)-(B.z-A.z)*(px-A.x)<-1e-6) return false;
    }
    return true;
  }
  /* Character-welded model: keep the exact torso-local pose captured on the
   * first step after makeJoints.  The assembly is kinematic relative to the
   * body; its BodyVelocity still integrates (so the script's fuel/maxForce
   * law runs) and supplies the humanoid velocity.  Without this the welded
   * JetPack kept falling under gravity after attaching and slid off the
   * back before the jumper ever pressed space. */
  _stepCharWeld(a, dt){
    const c=this.char;
    const torso=c.partWorldCF('Torso')||
      { pos:{x:c.group.position.x,y:c.group.position.y,z:c.group.position.z},
        rot:[1,0,0, 0,1,0, 0,0,1] };
    const R=torso.rot, RT=matT3(R);
    if (!a._charWeld){
      a._charWeld=a.members.map(m=>{
        const d={x:m.cf.pos.x-torso.pos.x, y:m.cf.pos.y-torso.pos.y, z:m.cf.pos.z-torso.pos.z};
        return { lp:matVec3(RT,d), lr:matMul3(RT,m.cf.rot) };
      });
      const dc={x:a.pos.x-torso.pos.x, y:a.pos.y-torso.pos.y, z:a.pos.z-torso.pos.z};
      a._charWeldCom=matVec3(RT,dc);
    }
    for (let i=0;i<a.members.length;i++){
      const m=a.members[i], l=a._charWeld[i];
      if (!m||m.destroyed||!l) continue;
      m.__charIgnore=true;
      const wp=matVec3(R,l.lp);
      const pos={x:torso.pos.x+wp.x, y:torso.pos.y+wp.y, z:torso.pos.z+wp.z};
      const rot=matMul3(R,l.lr);
      if (window.RBLXenv&&window.RBLXenv.placePart)
        window.RBLXenv.placePart(m.part,{pos,rot});
      if (m.__faces) m.__faces.dirty=true;
      this._refresh(m);
    }
    const cp=matVec3(R,a._charWeldCom);
    a.pos={x:torso.pos.x+cp.x, y:torso.pos.y+cp.y, z:torso.pos.z+cp.z};
    a.asleep=false;
    if (c.velocity){
      if (Math.abs(a.vel.x)>1e-3) c.velocity.x=a.vel.x;
      if (Math.abs(a.vel.z)>1e-3) c.velocity.z=a.vel.z;
      c.velocity.y=a.vel.y+GRAV*dt;
    }
  }
  /* BodyThrust: Force and Location are relative to the bearing assembly
   * (the 2007 docs), so rotate both by the parent part's current CFrame.
   * Applied in the free force solver so the offset actually produces
   * torque; the assembler already keeps thrust-only bodies un-driven. */
  _applyThrusts(a, h){
    for (const mv of a.thrusts){
      const p=mv.inst&&mv.inst.props; if (!p) continue;
      const F=vecOf(p.Force)||vecOf(p.force);
      if (!F) continue;
      const L=vecOf(p.Location)||vecOf(p.location)||[0,0,0];
      const cf=mv.look&&mv.look.cf; if (!cf) continue;
      const R=cf.rot;
      const fx=R[0]*F[0]+R[1]*F[1]+R[2]*F[2];
      const fy=R[3]*F[0]+R[4]*F[1]+R[5]*F[2];
      const fz=R[6]*F[0]+R[7]*F[1]+R[8]*F[2];
      a.force.x+=fx; a.force.y+=fy; a.force.z+=fz;
      const lx=cf.pos.x + R[0]*L[0]+R[1]*L[1]+R[2]*L[2];
      const ly=cf.pos.y + R[3]*L[0]+R[4]*L[1]+R[5]*L[2];
      const lz=cf.pos.z + R[6]*L[0]+R[7]*L[1]+R[8]*L[2];
      const rx=lx-a.pos.x, ry=ly-a.pos.y, rz=lz-a.pos.z;
      a.torque.x+=ry*fz-rz*fy;
      a.torque.y+=rz*fx-rx*fz;
      a.torque.z+=rx*fy-ry*fx;
    }
  }
  /* --- mover-driven assemblies (BodyForce/BodyVelocity/BodyPosition) ---
   * These keep the translation model their shipped scripts were tuned
   * against (beacons, Rally cars, the crane).  The classic body force
   * solver is for free rigid bodies; mover scripts write velocities and
   * force budgets directly, so this path stays a translation + AABB
   * contact resolver (APPROX, documented in web/PORT.md). */
  _stepDriven(a, dt){
    const w=this.world;
    const v=a.vel;
    if (a.charAttach&&this.char&&this.char.velocity){
      /* Welded to the humanoid: the body, not the assembly, supplies the
       * base velocity and gravity.  Letting the held model free-fall for a
       * few frames accumulated -190 studs/s, then the first jump was
       * immediately cancelled when the assembly velocity overwrote it. */
      v.x=this.char.velocity.x;
      v.y=this.char.velocity.y;
      v.z=this.char.velocity.z;
    } else {
      /* --- gravity --- */
      v.y-=GRAV*dt;
    }
    /* --- BodyForce: constant force in newtons, no clamp  the Rally
     * cars' GoButton writes engine.BodyForce.force=(-100000,0,0); it
     * applies grounded or airborne alike (classic RBX::BodyForce) --- */
    for (const mv of a.movers){
      if (mv.kind!=='BodyForce') continue;
      const f=vecOf(mv.inst.props.force);
      if (!f) continue;
      v.x+=f[0]/a.mass*dt;
      v.y+=f[1]/a.mass*dt;
      v.z+=f[2]/a.mass*dt;
    }
    /* BodyThrust on a mover-driven assembly: the driven path is
     * translation-only, so apply its force locally without the torque. */
    for (const mv of a.thrusts){
      const p=mv.inst.props;
      const F=vecOf(p.Force)||vecOf(p.force);
      if (!F) continue;
      const cf=mv.look&&mv.look.cf;
      const R=cf? cf.rot : [1,0,0,0,1,0,0,0,1];
      v.x+=(R[0]*F[0]+R[1]*F[1]+R[2]*F[2])/a.mass*dt;
      v.y+=(R[3]*F[0]+R[4]*F[1]+R[5]*F[2])/a.mass*dt;
      v.z+=(R[6]*F[0]+R[7]*F[1]+R[8]*F[2])/a.mass*dt;
    }
    /* --- BodyVelocity: velocity constraint with force budget --- */
    for (const mv of a.movers){
      const p=mv.inst.props;
      if (mv.kind==='BodyVelocity'){
        const tgt=vecOf(p.velocity)||[0,0,0];
        const cap=vecOf(p.maxForce)||[0,0,0];
        for (let i=0;i<3;i++){
          if (!(cap[i]>0)) continue;                     // no force this axis
          const ax=['x','y','z'][i];
          if (i===1 && a.grounded && tgt[1]<0){
            v.y=Math.min(v.y,0);                          // support wins; rest
            continue;
          }
          const need=a.mass*Math.abs(tgt[i]-v[ax])/dt;
          if (need<=cap[i]) v[ax]=tgt[i];
          else v[ax]+=Math.sign(tgt[i]-v[ax])*(cap[i]/a.mass)*dt;
        }
      } else { /* BodyPosition: PD with per-axis force clamp */
        const tgt=vecOf(p.position);
        if (tgt){
          const P=+p.P||0, D=+p.D||0;
          const cap=vecOf(p.maxForce)||[0,0,0];
          /* effect anchor is the MOVER's own parent part  never assume the
           * flood seed order put it at members[0] */
          const mfl=mv.look||a.members[0];
          const cf=mfl.cf||(w.partLook.get(mfl.part)||{}).cf;
          const cpos=cf&&cf.pos;
          for (let i=0;i<3;i++){
            if (!(cap[i]>0)) continue;
            const ax=['x','y','z'][i];
            let F=P*(tgt[i]-(cpos&&cpos[ax]||0))-D*v[ax];
            F=Math.max(-cap[i],Math.min(cap[i],F));
            v[ax]+=F/a.mass*dt;
          }
        }
      }
    }
    if (a.charAttach&&this.char&&this.char.partWorldCF){
      this._stepCharWeld(a, dt);
      return;
    }
    /* --- carry: character stands on a member → record the ride ---
     * Capture the ridden part's position for THIS step only.  Keeping a
     * `lastPos` across steps made a character that jumped off a moving
     * assembly (or landed on one after it had travelled while asleep)
     * receive the whole accumulated delta as one carry  a random
     * teleport on re-contact. */
    const riding=this._charOn(a);
    const rideLook=riding? this.char.groundLook : null;
    const rideStart=(rideLook&&rideLook.cf)
      ? { x:rideLook.cf.pos.x, y:rideLook.cf.pos.y, z:rideLook.cf.pos.z }
      : null;
    const dy=dt*v.y, dx=dt*v.x, dz=dt*v.z;
    if (a.pos){ a.pos.x+=dx; a.pos.y+=dy; a.pos.z+=dz; }
    /* --- integrate every member (mesh + CFrame + aabb + colliders) --- */
    for (const look of a.members){
      const cf=look.cf||{pos:{x:0,y:0,z:0},rot:[1,0,0,0,1,0,0,0,1]};
      const np={ x:cf.pos.x+dx, y:cf.pos.y+dy, z:cf.pos.z+dz };
      if (window.RBLXenv&&window.RBLXenv.placePart)
        window.RBLXenv.placePart(look.part, { pos:np, rot:cf.rot });
    }
    /* --- collision resolve vs everything that is not us --- */
    a.grounded=false;
    a.contactWalls.length=0;
    let resolved=false;
    for (const look of a.members){
      if (resolved) break;
      if (look.canCollide===false) continue;
      for (const n of this._neighbors(look.aabb)){
        if (n.destroyed||a.sets.has(n)||n.canCollide===false) continue;
        const A=look.aabb, B=n.aabb;
        const ox=Math.min(A.max.x-B.min.x, B.max.x-A.min.x);
        const oy=Math.min(A.max.y-B.min.y, B.max.y-A.min.y);
        const oz=Math.min(A.max.z-B.min.z, B.max.z-A.min.z);
        /* flush EDGE contacts count (HappyHome's slide kisses the platform
         * caps' edges exactly  zero-width x/z overlap  and the old
         * <=0 gate gave it nothing to rest on, so the whole ramp fell
         * through the map; the CONTACT slop already allows this on y) */
        if (ox<=-CONTACT||oz<=-CONTACT) continue;
        /* part-vs-part contact: the engine's Touched signal fires on ANY
         * touching part (the HHH crane parks by touching the Stop pad);
         * rbxenv installs the hook  edge-latched on its side */
        if (this.contactHook) this.contactHook(look, n);
        if (oy<=0){
          /* flush REST contact (face-to-face, no penetration). The classic
           * rule is about the SUPPORT, not the touch: resting on a static
           * or already-sleeping assembly holds; resting on an AWAKE
           * dynamic one means both are falling  the island falls as one
           * (no approach along y), or every mutually-grounded cluster
           * with no anchor below would freeze mid-air. */
          if (oy > -CONTACT){
            const acy=(A.min.y+A.max.y)/2, bcy=(B.min.y+B.max.y)/2;
            if (acy>bcy){
              const nb=this.asmMap.get(n);
              if (!nb || nb.static || nb.asleep){
                a.grounded=true;
                if (v.y<0) v.y=0;
                if (nb) a.restOn.add(nb);
                a.supportLooks.add(n);
                /* tangential slow-down is not modelled on the mover path:
                 * mover assemblies stay outside the free-body force solver */
              } else if (v.y < nb.vel.y){
                v.y = nb.vel.y;           // fall with the support
              }
            } else if (v.y>0){
              const nb=this.asmMap.get(n);         // brushing the underside
              const cap=(nb&&!nb.static&&!nb.asleep)? nb.vel.y : 0;
              if (v.y>cap) v.y=cap;
            }
          }
          continue;
        }
        if (ox<=0||oz<=0){
          /* edge/corner contact  zero-width x/z footprint.  Resolving
           * along the kiss axis is a ZERO-length push that used to
           * consume the tick's one resolution slot and starve the real
           * rest contact (HappyHome's slide fell through the platform
           * exactly so).  With vertical penetration and the body on top,
           * this is resting on a lip/corner  resolve as REST. */
          if (oy>0){
            const acy=(A.min.y+A.max.y)/2, bcy=(B.min.y+B.max.y)/2;
            if (acy>bcy){
              const nb=this.asmMap.get(n);
              if (!nb || nb.static || nb.asleep){
                if (v.y<0) v.y=0;
                a.grounded=true;
                if (nb) a.restOn.add(nb);
                a.supportLooks.add(n);
                /* tangential slow-down is not modelled on the mover path:
                 * mover assemblies stay outside the free-body force solver */
              } else if (v.y < nb.vel.y){
                v.y = nb.vel.y;           // ride the lip's owner
              }
            } else if (v.y>0){
              const nb=this.asmMap.get(n);         // head grazing under a lip
              const cap=(nb&&!nb.static&&!nb.asleep)? nb.vel.y : 0;
              if (v.y>cap) v.y=cap;
            }
          }
          continue;
        }
        const acx=(A.min.x+A.max.x)/2, bcx=(B.min.x+B.max.x)/2;
        const acy=(A.min.y+A.max.y)/2, bcy=(B.min.y+B.max.y)/2;
        const acz=(A.min.z+A.max.z)/2, bcz=(B.min.z+B.max.z)/2;
        // smallest axis wins; direction = which side we came from
        let best=oy, axis='y', sign=acy>bcy?1:-1;
        if (ox<best){ best=ox; axis='x'; sign=acx>bcx?1:-1; }
        if (oz<best){ best=oz; axis='z'; sign=acz>bcz?1:-1; }
        const push=best*sign;
        if (axis==='y'){
          if (sign>0){
            this._shift(a, 0, push, 0);
            const nb=this.asmMap.get(n);
            if (!nb || nb.static || nb.asleep){
              if (v.y<0) v.y=0;
              a.grounded=true;
              if (nb) a.restOn.add(nb);
              a.supportLooks.add(n);
              /* tangential slow-down is not modelled on the mover path:
               * mover assemblies stay outside the free-body force solver */
            } else if (v.y < nb.vel.y){
              v.y = nb.vel.y;               // fall with the support
            }
          } else {
            this._shift(a, 0, -push, 0);
            const nbU=this.asmMap.get(n);        // pushing up into it
            const cap=(nbU&&!nbU.static&&!nbU.asleep)? nbU.vel.y : 0;
            if (v.y>cap) v.y=cap;
          }
        } else {
          /* horizontal contact on the MOVER path: the classic translation
           * response resolves BOTH bodies.  Against anchored/sleeping-static
           * geometry the mover is pushed back and stopped; against a FREE
           * assembly the contact separates by mass share and both take the
           * momentum-shared axis velocity, waking it if asleep.  Angular
           * response (impact below the COM) comes from the force solver on
           * the next free-body step. */
          const nb=this.asmMap.get(n);
          const vBefore=v[axis];
          const otherV=(nb&&!nb.static)? (nb.vel[axis]||0) : 0;
          const rel=vBefore-otherV;
          const closing=rel*sign<0;          // moving toward the other body
          if (nb&&nb!==a&&!nb.static){
            const mB=nb.mass||0, M=a.mass+mB;
            if (closing&&M>0){
              const share=(a.mass*vBefore+mB*nb.vel[axis])/M;
              v[axis]=share; nb.vel[axis]=share;
            }
            if (closing){
              /* separate by mass share: heavy side barely moves */
              this._shift(a, axis==='x'? push*(mB/M):0, 0, axis==='z'? push*(mB/M):0);
              this._shift(nb, axis==='x'? -push*(a.mass/M):0, 0, axis==='z'? -push*(a.mass/M):0);
            } else {
              this._shift(a, axis==='x'? push:0, 0, axis==='z'? push:0);
            }
            if (nb.asleep){ nb.asleep=false; this.wakeAround(nb); }
          } else {
            /* mover-driven bodies keep the translation model their
             * shipped scripts were tuned against: stop the axis at the
             * wall (beacons/cars/crane). */
            this._shift(a, axis==='x'? push:0, 0, axis==='z'? push:0);
            v[axis]=0;
          }
          resolved=true;
          break;
        }
      }
    }
    /* --- ride the motion we applied --- */
    if (riding && rideLook&&rideLook.cf&&rideStart){
      /* net movement of the support this step (integration + collision
       * resolution); never a delta accumulated while off the assembly */
      this.carry={
        x:rideLook.cf.pos.x-rideStart.x,
        y:rideLook.cf.pos.y-rideStart.y,
        z:rideLook.cf.pos.z-rideStart.z
      };
    }
    /* keep the hash current for moved members (others find them at the
     * new cells; asleep assemblies never move, so the skip is safe) */
    for (const look of a.members) this._refresh(look);
    /* face caches are position-stale after any move  flagged lazily so
     * the next ClumpStage pass re-derives flush pairs */
    for (const look of a.members)
      if (look.__faces) look.__faces.dirty=true;
    /* Mover-driven assemblies never sleep: a script can command a new
     * BodyVelocity/BodyPosition at any time and there is no property
     * setter hook to wake a sleeping body (classic movers are active). */
  }
  _shift(a, dx, dy, dz){
    if (!dx&&!dy&&!dz) return;
    if (a.pos){ a.pos.x+=dx; a.pos.y+=dy; a.pos.z+=dz; }
    for (const look of a.members){
      const cf=look.cf;
      if (window.RBLXenv&&window.RBLXenv.placePart)
        window.RBLXenv.placePart(look.part, { pos:{x:cf.pos.x+dx,y:cf.pos.y+dy,z:cf.pos.z+dz}, rot:cf.rot });
      if (look.__faces) look.__faces.dirty=true;
      this._refresh(look);
    }
  }
}

window.RBLXdyn=new Dynamics();
})();
