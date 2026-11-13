/* Head face-decal mesh checks.  Run with: node test/headmesh.js
 * The real headmesh module needs only THREE.BufferGeometry/BufferAttribute
 * for build/buildFace; the renderer is not involved. */
"use strict";

const fs=require('fs');
const vm=require('vm');
const assert=require('assert');
const path=require('path');

class Attr {
  constructor(array, itemSize){
    this.array=array;
    this.itemSize=itemSize;
    this.count=array.length/itemSize;
  }
}
class Geo {
  constructor(){ this.attributes={}; this.index=null; }
  setAttribute(name, attr){ this.attributes[name]=attr; }
  setIndex(attr){ this.index=attr; }
  computeBoundingSphere(){}
}

global.window={ THREE:{ BufferGeometry:Geo, BufferAttribute:Attr } };
global.THREE=window.THREE;
vm.runInThisContext(fs.readFileSync(path.join(__dirname,'../web/js/headmesh.js'),'utf8'));
const H=window.RBLXheadMesh;

const head=H.build({x:2,y:1,z:1},{x:1.25,y:1.25,z:1.25});
assert.strictEqual(head.geo.attributes.position.count, 600);
assert.strictEqual(head.geo.index.count, 2916);

const face=H.buildFace({x:2,y:1,z:1},{x:1.25,y:1.25,z:1.25});
assert.ok(face, 'head face patch missing');
assert.ok(face.geo.attributes.uv, 'face patch has no UVs');
assert.ok(face.geo.index.count > 0, 'face patch has no triangles');
assert.strictEqual(face.geo.attributes.uv.count, face.geo.attributes.position.count);

const idx=face.geo.index.array, uv=face.geo.attributes.uv.array;
let minU=1, maxU=0, minV=1, maxV=0, seen=0;
for (let i=0;i<idx.length;i++){
  const v=idx[i];
  const u=uv[v*2], t=uv[v*2+1];
  minU=Math.min(minU,u); maxU=Math.max(maxU,u);
  minV=Math.min(minV,t); maxV=Math.max(maxV,t);
  seen++;
}
assert.ok(seen >= 480, 'front patch is too small');
assert.ok(minU >= -1e-6 && maxU <= 1+1e-6, 'u outside 0..1');
assert.ok(minV >= -1e-6 && maxV <= 1+1e-6, 'v outside 0..1');
assert.ok(maxU-minU > 0.9 && maxV-minV > 0.9, 'UVs do not span the face');
assert.strictEqual(face.dim.x, 1.25);

/* Front-facing (-Z) orientation: +X is screen-left (u=0), top is v=1. */
let leftU=null,rightU=null,topV=null,bottomV=null;
const pos=face.geo.attributes.position.array;
for (let i=0;i<idx.length;i++){
  const v=idx[i], x=pos[v*3], y=pos[v*3+1];
  if (leftU===null || x>leftU.x){ leftU={x,u:uv[v*2]}; }
  if (rightU===null || x<rightU.x){ rightU={x,u:uv[v*2]}; }
  if (topV===null || y>topV.y){ topV={y,v:uv[v*2+1]}; }
  if (bottomV===null || y<bottomV.y){ bottomV={y,v:uv[v*2+1]}; }
}
assert.ok(Math.abs(leftU.u) < 1e-6, '+X should map to u=0');
assert.ok(Math.abs(rightU.u-1) < 1e-6, '-X should map to u=1');
assert.ok(Math.abs(topV.v-1) < 1e-6, 'top should map to v=1');
assert.ok(Math.abs(bottomV.v) < 1e-6, 'bottom should map to v=0');

console.log('ALL HEADMESH TESTS PASSED');
