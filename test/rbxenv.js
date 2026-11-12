/* Focused bridge tests for web/js/rbxenv.js.
 * Run with: node test/rbxenv.js
 * No DOM or renderer: only the DataModel-facing paths are exercised. */
"use strict";

const fs=require('fs');
const vm=require('vm');
const assert=require('assert');
const path=require('path');

global.window={};
global.performance={ now:()=>0 };
vm.runInThisContext(fs.readFileSync(path.join(__dirname,'../web/js/luaport.js'),'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(__dirname,'../web/js/rbxenv.js'),'utf8'));
const L=window.RBLXlua, E=window.RBLXenv;

function run(env,src){
  let out=null;
  L.run(L.parse(src), r=>{ out=r; });
  L.sched.tick(0);
  assert(Array.isArray(out), 'chunk return values must be an array');
  return out;
}

/* walkAll includes the root and does not follow the fake Humanoid's
 * cross-parent limb aliases twice */
const model=E.mkInst('Model','M'), hum=E.mkInst('Humanoid','H'), part=E.mkInst('Part','P');
hum.parent=model; model.children.push(hum);
part.parent=model; model.children.push(part);
hum.children.push(part);                         /* alias, parent stays model */
assert.deepStrictEqual(E.walkAll(model).map(x=>x.props.Name), ['M','H','P']);

/* recursive FindFirstChild reaches a descendant */
E.forPlace({instances:[]}, null, null, null);
const findEnv=L.makeEnv({obj:E.wrap(model)});
assert.deepStrictEqual(run(findEnv,'return obj:FindFirstChild("P", true).Name'), ['P']);

/* Signal:wait blocks until the next firing */
const waitInst=E.mkInst('Part','WaitPart');
const waitW=E.wrap(waitInst);
const waitEnv=L.makeEnv({obj:waitW});
let waitResult=null;
L.run(L.parse('return obj.Touched:wait()'), r=>{ waitResult=r; });
L.sched.tick(0);
assert.strictEqual(waitResult,null,'wait must not return before a firing');
E.fireEvent(waitInst,'Touched',[waitW]);
L.sched.tick(0); L.sched.tick(0);
assert.ok(waitResult&&waitResult.length===1&&waitResult[0]===waitW,'wait returned '+JSON.stringify(waitResult));

/* ChildAdded wakes a waitForChild-style waiter when a child is parented */
const parent=E.mkInst('Model','Parent');
const childInst=E.mkInst('Part','Child');
const parentW=E.wrap(parent), childW=E.wrap(childInst);
const childEnv=L.makeEnv({obj:parentW});
let added=null;
L.run(L.parse('return obj.ChildAdded:wait()'), r=>{ added=r; });
L.sched.tick(0);
E.reparent(childInst,parent);
L.sched.tick(0); L.sched.tick(0);
assert.ok(added&&added.length===1&&added[0]===childW,'ChildAdded waiter did not return the child');

/* Players.PlayerAdded and the local player's class */
const gameEnv=L.makeEnv({game:E.wrap(E.state.gameInst)});
assert.deepStrictEqual(run(gameEnv,'return game.Players.LocalPlayer.ClassName'), ['Player']);
const addEnv=L.makeEnv({game:E.wrap(E.state.gameInst)});
addEnv.G.set('count',0);
L.run(L.parse('game.Players.PlayerAdded:connect(function(p) count=count+1 end)'), ()=>{});
L.sched.tick(0);
E.firePlayerAdded();
L.sched.tick(0); L.sched.tick(0);
assert.strictEqual(addEnv.G.get('count'),1,'PlayerAdded handler did not fire');

/* Lighting.TimeOfDay and GetMinutesAfterMidnight stay in sync */
const lightEnv=L.makeEnv({lighting:E.wrap(E.state.lightingInst)});
assert.deepStrictEqual(run(lightEnv,'lighting.TimeOfDay="18:30:00" return lighting:GetMinutesAfterMidnight()'), [1110]);
const lightEnv2=L.makeEnv({lighting:E.wrap(E.state.lightingInst)});
assert.deepStrictEqual(run(lightEnv2,'lighting:SetMinutesAfterMidnight(60) return lighting.TimeOfDay'), ['01:00:00']);

/* SoundId string round-trip */
const soundEnv=L.makeEnv({snd:E.instanceNew('Sound')});
assert.deepStrictEqual(run(soundEnv,'snd.SoundId="rbxasset://sounds/clickfast.wav" return snd.SoundId'), ['rbxasset://sounds/clickfast.wav']);

/* ObjectValue reads its instance as a wrapped value */
const ovEnv=L.makeEnv({ov:E.instanceNew('ObjectValue'), part:E.instanceNew('Part')});
assert.deepStrictEqual(run(ovEnv,'ov.Value=part return ov.Value==part'), [true]);

/* spawnFromXml keeps a multi-part model's relative offsets */
E.state.world=null;
const root={cls:'Part',props:{Name:'A',CFrame:{pos:{x:1,y:0,z:0},rot:[1,0,0,0,1,0,0,0,1]}},children:[],parent:null};
const child={cls:'Part',props:{Name:'B',CFrame:{pos:{x:3,y:0,z:0},rot:[1,0,0,0,1,0,0,0,1]}},children:[],parent:root};
root.children.push(child);
window.RBLXxml={parseRbx:()=>({instances:[root,child]})};
const made=E.spawnFromXml('x',{cf:{pos:{x:10,y:0,z:0},rot:[1,0,0,0,1,0,0,0,1]}});
assert.ok(made&&made.length===1);
assert.strictEqual(root.props.CFrame.pos.x,10);
assert.strictEqual(child.props.CFrame.pos.x,12);

/* Replication ids are deterministic over parse order; runtime ids follow. */
const pa=E.mkInst('Part','A'), pb=E.mkInst('Part','B');
E.forPlace({instances:[pa,pb]}, null, null, null);
assert.strictEqual(pa.netId,1);
assert.strictEqual(pb.netId,2);
assert.strictEqual(E.state.netMap.get(1),pa);
assert.strictEqual(E.state.netMap.get(2),pb);
assert.strictEqual(E.state.netNextId,3);

/* packNetPart/netDrain serialize a visible Workspace part and clear the
 * dirty queues.  No scripts or URLs are part of the payload. */
const dyn=E.mkInst('Part','Dyn');
dyn.parent=E.state.workspaceInst;
E.state.workspaceInst.children.push(dyn);
dyn.props.size={x:2,y:3,z:4};
dyn.props.CFrame={pos:{x:1,y:2,z:3},rot:[1,0,0,0,1,0,0,0,1]};
dyn.props.BrickColor=23;
dyn.props.Anchored=false;
dyn.props.CanCollide=true;
dyn.props.shape=1;
const dynLook={
  part:dyn, destroyed:false, size:{x:2,y:3,z:4},
  cf:{pos:{x:1,y:2,z:3},rot:[1,0,0,0,1,0,0,0,1]},
  entry:{rgb:[0,0,255],id:23}, aabb:{min:{x:0,y:0,z:0},max:{x:2,y:3,z:4}},
  obj:{material:{}}, anchored:false, canCollide:true, velocity:{x:0,y:0,z:0}
};
E.state.world={ partLook:new Map([[dyn,dynLook]]), colliders:[dynLook] };
E.state.netNew.add(dyn);
const drained=E.netDrain();
assert.strictEqual(drained.p.length,1);
assert.strictEqual(drained.p[0].i,3);
assert.strictEqual(drained.p[0].n,1);
assert.deepStrictEqual(drained.p[0].s,[2,3,4]);
assert.strictEqual(drained.p[0].b,23);
assert.strictEqual(E.state.netNew.size,0);

/* applyNetPart updates the look/props (CFrame, colour, transparency,
 * anchored, collision) without running any script. */
E.applyNetPart(dyn,{
  f:[9,8,7,1,0,0,0,1,0,0,0,1], b:21, t:0.5, a:1, k:0
});
assert.deepStrictEqual(dynLook.cf.pos,{x:9,y:8,z:7});
assert.strictEqual(dyn.props.Transparency,0.5);
assert.strictEqual(dyn.props.Anchored,true);
assert.strictEqual(dyn.props.CanCollide,false);
assert.strictEqual(dyn.props.BrickColor,21);
assert.ok(!E.state.world.colliders.includes(dynLook));

/* A moved dynamic part (rocket, beacon, grabbed brick) enters the dirty
 * queue and drains as an update, not a new instance. */
E.placePart(dyn,{pos:{x:12,y:8,z:7},rot:[1,0,0,0,1,0,0,0,1]});
assert.ok(E.state.netDirty.has(dyn));
const moved=E.netDrain();
assert.strictEqual(moved.p.length,1);
assert.strictEqual(moved.p[0].n,0);
assert.deepStrictEqual(moved.p[0].f.slice(0,3),[12,8,7]);

/* A remote player gets a fake DataModel tree whose Humanoid/Character
 * reads map to the host-simulated Character. */
const netChar={
  health:100, maxHealth:100, alive:true, walkSpeed:16, jumpVelocity:50,
  velocity:{x:0,y:0,z:0,set(x,y,z){this.x=x;this.y=y;this.z=z;}},
  group:{position:{x:0,y:3,z:0},rotation:{y:0}},
  partWorldCF:()=>({pos:{x:0,y:3,z:0},rot:[1,0,0,0,1,0,0,0,1]}),
  movePartTo(){}, setPartColor(){}, setPartTransparency(){},
  takeDamage(d){ this.health=Math.max(0,this.health-d); }
};
const rec=E.addNetPlayer('net1','Remote',netChar);
assert.ok(rec, 'addNetPlayer failed');
const remoteEnv=L.makeEnv({p:E.wrap(rec.player)});
assert.deepStrictEqual(
  run(remoteEnv,'return p.Character:FindFirstChild("Humanoid").Health'),
  [100]
);
assert.deepStrictEqual(
  run(remoteEnv,'return p.Character:FindFirstChild("Humanoid").Parent.Name'),
  ['Remote']
);
netChar.health=40;
assert.deepStrictEqual(
  run(remoteEnv,'return p.Character:FindFirstChild("Humanoid").Health'),
  [40]
);
const torsoEnv=L.makeEnv({t:E.wrap(rec.torso), v:E.V3(0,200,0)});
run(torsoEnv,'t.Velocity=v');
assert.strictEqual(netChar.velocity.y,200);
E.addNetPlayer('net1','Remote2',netChar);
assert.strictEqual(rec.player.props.Name,'Remote2');
assert.strictEqual(rec.model.props.Name,'Remote2');
E.removeNetPlayer('net1');
assert.ok(!E.state.playersInst.children.includes(rec.player));
assert.ok(!E.state.workspaceInst.children.includes(rec.model));

/* A remote character overlapping a Touched listener fires it with the
 * remote fake torso, and only on the enter edge. */
E.forPlace({instances:[]}, null, null, null);
const pad=E.mkInst('Part','Pad');
pad.parent=E.state.workspaceInst;
E.state.workspaceInst.children.push(pad);
const padLook={
  part:pad, destroyed:false, size:{x:4,y:1,z:4},
  cf:{pos:{x:0,y:0,z:0},rot:[1,0,0,0,1,0,0,0,1]},
  entry:{rgb:[128,128,128],id:194}, aabb:{min:{x:-2,y:0,z:-2},max:{x:2,y:1,z:2}},
  obj:{material:{}}, anchored:true, canCollide:true, velocity:{x:0,y:0,z:0}
};
E.state.world={
  partLook:new Map([[pad,padLook]]), colliders:[padLook],
  raycastBoxes:()=>null, scene:null
};
E.state.watchSet.add(pad);
const padEnv=L.makeEnv({pad:E.wrap(pad)});
padEnv.G.set('hits',0);
padEnv.G.set('hitName','');
L.run(L.parse('pad.Touched:connect(function(hit) hits=hits+1; hitName=hit.Parent.Name end)'),()=>{});
L.sched.tick(0);
const touchChar={
  health:100, maxHealth:100, alive:true, walkSpeed:16, jumpVelocity:50,
  velocity:{x:0,y:0,z:0},
  group:{position:{x:0,y:3,z:0},rotation:{y:0}},
  partWorldCF:()=>({pos:{x:0,y:3,z:0},rot:[1,0,0,0,1,0,0,0,1]}),
  movePartTo(){}, setPartColor(){}, setPartTransparency(){},
  takeDamage(){}
};
E.addNetPlayer('touch1','TouchPlayer',touchChar);
E.fireStepped(1/60);
L.sched.tick(0);
assert.strictEqual(padEnv.G.get('hits'),1);
assert.strictEqual(padEnv.G.get('hitName'),'TouchPlayer');
E.fireStepped(1/60);
L.sched.tick(0);
assert.strictEqual(padEnv.G.get('hits'),1);
touchChar.group.position.y=10;              /* leave the pad */
E.fireStepped(1/60); L.sched.tick(0);
touchChar.group.position.y=3;               /* re-enter */
E.fireStepped(1/60); L.sched.tick(0);
assert.strictEqual(padEnv.G.get('hits'),2);

console.log('ALL RBXENV TESTS PASSED');
