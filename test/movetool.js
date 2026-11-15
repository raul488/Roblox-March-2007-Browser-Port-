/* PartDragTool (GameTool/Grab) regressions: stud-phase surface snap and the
 * R/T rotate keys.  Run with: node test/movetool.js */
"use strict";

const fs=require('fs');
const vm=require('vm');
const assert=require('assert');
const path=require('path');

global.window={};
global.performance={ now:()=>0 };

function mkLook(name, size, pos){
  const h={x:size.x/2, y:size.y/2, z:size.z/2};
  return {
    part:{cls:'Part', props:{Name:name, size, Locked:false}, children:[]},
    size, destroyed:false, anchored:true, canCollide:true,
    cf:{pos:{x:pos.x, y:pos.y, z:pos.z}, rot:[1,0,0, 0,1,0, 0,0,1]},
    aabb:{min:{x:pos.x-h.x,y:pos.y-h.y,z:pos.z-h.z},
          max:{x:pos.x+h.x,y:pos.y+h.y,z:pos.z+h.z}},
    obj:{}, entry:{rgb:[128,128,128], id:194}, surf:[0,0,0,0,0,0]
  };
}

let src, targ, hitPoint;
window.RBLXenv={
  keyDown(){}, keyUp(){},
  updateMouse(){}, getMouse(){ return {x:0,y:0,leftDown:false,leftPressed:false}; },
  mouseDown(){}, mouseUp(){}, mouseHasHandlers(){ return false; },
  fireEvent(){}, invokeCallback(){},
  placePart(inst, cf){
    const look=inst===src.part? src : inst===targ.part? targ : null;
    if (look) look.cf={pos:{x:cf.pos.x,y:cf.pos.y,z:cf.pos.z}, rot:cf.rot.slice()};
  },
  viewLook(inst){ return inst===src.part? src : inst===targ.part? targ : null; },
  state:{}
};
vm.runInThisContext(fs.readFileSync(path.join(__dirname,'../web/js/tools.js'),'utf8'));
const TM=window.RBLXtools.ToolManager;

function runDrag(binType, sourceSize, targetSize, hit){
  src=mkLook('Brick', sourceSize, {x:0,y:6,z:0});
  targ=mkLook('Base', targetSize, {x:0,y:5,z:0});
  hitPoint=hit;
  const world={
    colliders:[src,targ],
    pickPartRaw(){ return { look:src, hit:{x:0,y:6,z:0} }; },
    partFaceAt(look){
      if (look===targ) return { axis:1, sign:1, half:targetSize.y/2,
        center:{x:0,y:5+targetSize.y/2,z:0}, normal:{x:0,y:1,z:0} };
      return { axis:1, sign:1, half:sourceSize.y/2,
        center:{x:0,y:6+sourceSize.y/2,z:0}, normal:{x:0,y:1,z:0} };
    },
    rayHit(){ return { look:targ, hit:{x:hit.x, y:hit.y, z:hit.z} }; },
    rayFromCamera(){ return { origin:{x:0,y:20,z:0}, dir:{x:0,y:-1,z:0} }; }
  };
  const tm=new TM({}, world, {});
  tm.activeInst={cls:'HopperBin', props:{Name:binType===1?'GameTool':'Grab'}, children:[]};
  tm.activeKind='HopperBin'; tm.binType=binType; tm.hasScript=false; tm.coolDown=0;
  const mouse={x:100,y:100,leftPressed:true,leftDown:true};
  tm.update(1/60, mouse, null);
  mouse.x=120; mouse.leftPressed=false;
  tm.update(1/60, mouse, null);
  return tm;
}

/* A 1x1 brick on a 4x2 face (even extents): its single Inlet hole must land
 * on a stud, i.e. at half-integer offsets from the face centre.  The old
 * integer lattice put it between studs. */
{
  const tm=runDrag(1, {x:1,y:1,z:1}, {x:4,y:1,z:2}, {x:0.2,y:5.5,z:0.3});
  assert.ok(tm.grabbed, 'GameTool did not grab');
  const p=src.cf.pos;
  assert.ok(Math.abs(p.x-0.5)<1e-6, 'x was not on a stud: '+p.x);
  assert.ok(Math.abs(p.z-0.5)<1e-6, 'z was not on a stud: '+p.z);
  assert.ok(Math.abs(p.y-6)<1e-3, 'brick must rest flush on the surface: '+p.y);
}

/* A 2x2 brick (even footprint) centres between four studs: integer offsets. */
{
  const tm=runDrag(2, {x:2,y:1,z:2}, {x:4,y:1,z:2}, {x:0.2,y:5.5,z:0.3});
  assert.ok(tm.grabbed, 'Grab did not grab');
  const p=src.cf.pos;
  assert.ok(Math.abs(p.x-Math.round(p.x))<1e-6, '2x2 brick centre must be between studs: '+p.x);
  assert.ok(Math.abs(p.z-Math.round(p.z))<1e-6, '2x2 brick centre must be between studs: '+p.z);
}

/* T/R rotate any grabbed drag tool, not only BinType 1. */
{
  const tm=runDrag(2, {x:4,y:1,z:2}, {x:4,y:1,z:2}, {x:0,y:5.5,z:0});
  const before=src.cf.rot.slice();
  tm.keyDown('t');
  assert.ok(src.cf.rot.some((v,i)=>Math.abs(v-before[i])>1e-6),
    'T did not tilt the Grab-held part');
  const tilted=src.cf.rot.slice();
  tm.keyDown('r');
  assert.ok(src.cf.rot.some((v,i)=>Math.abs(v-tilted[i])>1e-6),
    'R did not rotate the Grab-held part');
}

/* T/R keep working on the last picked part after the mouse is released. */
{
  const tm=runDrag(1, {x:4,y:1,z:2}, {x:4,y:1,z:2}, {x:0,y:5.5,z:0});
  tm.update(1/60, {x:120,y:100,leftDown:false,leftPressed:false}, null);
  assert.ok(!tm.grabbed, 'drag should be released');
  const before=src.cf.rot.slice();
  tm.keyDown('t');
  assert.ok(src.cf.rot.some((v,i)=>Math.abs(v-before[i])>1e-6),
    'T must rotate the selected part after release');
}

/* A key held across a window blur must not stay latched. */
{
  const tm=runDrag(1, {x:4,y:1,z:2}, {x:4,y:1,z:2}, {x:0,y:5.5,z:0});
  tm.keyDown('t');                 // rotates, then stays in _heldKeys
  const afterFirst=src.cf.rot.slice();
  tm.keyDown('t');                 // auto-repeat is ignored
  assert.deepStrictEqual(src.cf.rot, afterFirst, 'auto-repeat rotated twice');
  tm.releaseKeys();                // window blur
  tm.keyDown('t');
  assert.ok(src.cf.rot.some((v,i)=>Math.abs(v-afterFirst[i])>1e-6),
    'releaseKeys did not clear the latched key');
}

console.log('ALL MOVETOOL TESTS PASSED');
