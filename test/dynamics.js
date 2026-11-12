/* Model:MakeJoints() character-weld guard.
 *
 * The shipped Crossroads beacons (every 30 s), HHH crane regen, and the
 * regen scripts all call MakeJoints().  A flood crosses AABB contact onto
 * the anchored map; the character used to be welded to the floor through
 * its feet, and _make() then marked the whole static assembly
 * __charIgnore, which every collision probe skips.  Run with:
 *   node test/dynamics.js
 */
"use strict";

const fs=require('fs');
const vm=require('vm');
const assert=require('assert');
const path=require('path');

global.window={};
global.performance={ now:()=>0 };
vm.runInThisContext(fs.readFileSync(path.join(__dirname,'../web/js/dynamics.js'),'utf8'));
const D=window.RBLXdyn;

function mkLook(name, pos, size, anchored){
  const h={x:size.x/2, y:size.y/2, z:size.z/2};
  return {
    part:{cls:'Part', props:{Name:name}, children:[]},
    size,
    cf:{pos, rot:[1,0,0, 0,1,0, 0,0,1]},
    aabb:{min:{x:pos.x-h.x, y:pos.y-h.y, z:pos.z-h.z},
          max:{x:pos.x+h.x, y:pos.y+h.y, z:pos.z+h.z}},
    anchored:!!anchored, canCollide:true, destroyed:false,
    surf:[0,0,0,0,0,0], entry:{rgb:[128,128,128], id:194}, obj:{}
  };
}
function mkWorld(looks){
  return { partLook:new Map(looks.map(l=>[l.part,l])),
           colliders:looks.filter(l=>l.canCollide) };
}
function mkChar(px, pz){
  px=px||0; pz=pz||0;
  const partY={Torso:3, Head:4.5, 'Left Arm':3, 'Right Arm':3,
               'Left Leg':1, 'Right Leg':1};
  const partX={'Left Arm':-1.5, 'Right Arm':1.5, 'Left Leg':-0.5, 'Right Leg':0.5};
  return {
    parts:{
      'Torso':{size:{x:2,y:2,z:1}},
      'Head':{size:{x:2,y:1,z:1}},
      'Left Arm':{size:{x:1,y:2,z:1}},
      'Right Arm':{size:{x:1,y:2,z:1}},
      'Left Leg':{size:{x:1,y:2,z:1}},
      'Right Leg':{size:{x:1,y:2,z:1}}
    },
    group:{position:{x:px, y:3, z:pz}},
    groundLook:null,
    partWorldCF(nm){
      return { pos:{x:px+(partX[nm]||0), y:partY[nm], z:pz},
               rot:[1,0,0, 0,1,0, 0,0,1] };
    }
  };
}

/* 1) The reported bug: an unanchored model touches the anchored floor and
 * the character stands on that same floor far from the model.  The floor
 * must stay collidable and the assembly must not be character-carried. */
{
  const floor=mkLook('Baseplate',{x:0,y:-5,z:0},{x:200,y:10,z:200},true);
  const model=mkLook('Restored',{x:8,y:1,z:0},{x:2,y:2,z:2},false);
  D.init(mkWorld([floor,model]));
  D.setCharacter(mkChar(0,0));

  const boxes=D._characterPartBoxes();
  assert.ok(boxes.some(b=>b.parts==='Torso'), 'torso box missing');
  assert.ok(!boxes.some(b=>b.parts==='Left Leg'||b.parts==='Right Leg'),
    'leg boxes must not weld a character to the ground');

  floor.__charWeld=true;                    /* stale flag from an older call */
  D.makeJoints(model.part);
  assert.notStrictEqual(floor.__charWeld, true, 'floor kept a character weld');
  assert.notStrictEqual(floor.__charIgnore, true, 'floor became __charIgnore');
  assert.notStrictEqual(model.__charIgnore, true, 'model became __charIgnore');
  const asm=D.asmMap.get(floor);
  assert.ok(asm && asm.static, 'floor assembly should stay static');
  assert.strictEqual(asm.charAttach, false, 'static assembly was character-attached');
}

/* 2) A JetPack-style model that actually overlaps the torso still welds. */
{
  const pack=mkLook('JetPack',{x:0,y:4,z:1},{x:2,y:2,z:1},false);
  D.init(mkWorld([pack]));
  D.setCharacter(mkChar(0,0));
  D.makeJoints(pack.part);
  const asm=D.asmMap.get(pack);
  assert.ok(asm && !asm.static, 'pack should stay a free assembly');
  assert.strictEqual(asm.charAttach, true, 'torso-overlapping pack did not weld');
  assert.strictEqual(pack.__charIgnore, true, 'welded pack must be ignored by its carrier');
}

/* 3) Standing on a loose crate is not a weld (legs-only contact). */
{
  const crate=mkLook('Crate',{x:0,y:-1,z:0},{x:4,y:2,z:4},false);
  D.init(mkWorld([crate]));
  D.setCharacter(mkChar(0,0));
  D.makeJoints(crate.part);
  assert.notStrictEqual(crate.__charWeld, true, 'feet welded the crate to the character');
  assert.notStrictEqual(crate.__charIgnore, true, 'crate was ignored by the character');
}

/* 4) The static guard alone clears a flagged anchored part on reflood. */
{
  const floor=mkLook('Floor',{x:0,y:-5,z:0},{x:50,y:10,z:50},true);
  D.init(mkWorld([floor]));
  D.setCharacter(mkChar(0,0));
  floor.__charWeld=true;
  D._reflood();
  const asm=D.asmMap.get(floor);
  assert.ok(asm && asm.static);
  assert.strictEqual(asm.charAttach, false, 'static charAttach survived reflood');
  assert.strictEqual(floor.__charIgnore, false, 'static floor stayed ignored');
  assert.ok(floor.__charWeld===undefined, 'static floor kept its weld flag');
}

console.log('ALL DYNAMICS TESTS PASSED');
