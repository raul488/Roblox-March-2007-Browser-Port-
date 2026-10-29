/* ============================================================
 * mesh.js  G3D/Roblox legacy .mesh text format parser ("version 1.00")
 * Format confirmed on-disk from content/fonts/*.mesh:
 *   line0: "version 1.00"      line1: <face count>
 *   body: for each face, 3 vertices; each vertex = 3 vectors:
 *         [position][normal][uv]; one vector = "[x,y,z]"
 * Face k therefore uses vertices (3k, 3k+1, 3k+2)  non-indexed.
 * Used by SpecialMesh MeshType=5 (FileMesh) references too, and
 * for tool meshes (sword, rocketlauncher, slingshot, trowel,
 * timebomb, tree, hammer, clonewand, paintball gun).
 * ============================================================ */
(function(){
"use strict";

function parseMesh(text){
  /* head.mesh packs the face count into the version suffix
   * ("version 1.00.244"); the tool meshes put it on its own line
   * ("version 1.00\n2816"). Both forms are accepted. */
  const m = /^version\s+(\d+)\.(\d\d)(?:\.(\d+))?\s*\n/.exec(text);
  if (!m) throw new Error('mesh: missing version header');
  const major=+m[1], minor=+m[2];
  if (major !== 1){ throw new Error('mesh: Version ' + major + '.' + minor + ' model files not supported'); }
  let body = text.slice(m.index + m[0].length);
  let faceCount = (m[3]!=null)? +m[3] : null;
  const lineM=/^\s*(\d+)\s*\n/.exec(body);
  if (lineM){                       // count line form (tool meshes)
    faceCount=+lineM[1];
    body=body.slice(lineM[0].length);
  }
  const nums = [];
  const re = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let t;
  while ((t = re.exec(body))) nums.push(parseFloat(t[0]));
  /* each face = 3 vertices = 27 floats ([pos][normal][uv] × 3) */
  if (faceCount==null) faceCount=Math.floor(nums.length/27);
  if (nums.length < faceCount * 27) { throw new Error('mesh: truncated ('+nums.length+'/'+(faceCount*27)+')'); }
  const pos = new Float32Array(Math.min(nums.length/27, faceCount) * 9);
  const nor = new Float32Array(pos.length);
  const uv  = new Float32Array(pos.length);
  const count = pos.length/9;
  for (let f=0; f<count; f++){
    for (let v=0; v<3; v++){
      const s = f*27 + v*9, d = f*9 + v*3;
      pos[d+0]=nums[s+0]; pos[d+1]=nums[s+1]; pos[d+2]=nums[s+2];
      nor[d+0]=nums[s+3]; nor[d+1]=nums[s+4]; nor[d+2]=nums[s+5];
      uv [d+0]=nums[s+6]; uv [d+1]=nums[s+7]; uv [d+2]=nums[s+8];
    }
  }
  return { version: major + '.' + minor, faceCount, positions: pos, normals: nor, uvs: uv,
           /* meshes are authored in engine units; Roblox uses studs scale 1/64 per engine docs
               the 2007 avatar meshes are however self-consistent with a common magic scale
              that the renderer steps in with the part bbox; world.js normalizes against Part.size. */
           scaleFor(partSize){ return meshScale(partSize, this); } };
}

/* camera mesh spans come from this engine's own mesher: choose axis scale so bounding box spans match part size */
function bounds(mesh){
  let mn=[+Infinity,+Infinity,+Infinity], mx=[-Infinity,-Infinity,-Infinity];
  for (let i=0;i<mesh.positions.length;i+=3){
    for (let a=0;a<3;a++){ const v=mesh.positions[i+a]; if (v<mn[a]) mn[a]=v; if (v>mx[a]) mx[a]=v; }
  }
  return { min:mn, max:mx, span:[mx[0]-mn[0]||1e-6, mx[1]-mn[1]||1e-6, mx[2]-mn[2]||1e-6] };
}

/* the old text format repeats vertices per face (no index buffer)
 * weld same-position vertices so smooth normals survive. Returns a
 * plain data record (world.js builds the THREE geometry + normals,
 * since scaling is applied there). */
function weld(mesh){
  const P=mesh.positions, N=mesh.normals, U=mesh.uvs;
  const key=i=>Math.round(P[i]*1e4)+'|'+Math.round(P[i+1]*1e4)+'|'+Math.round(P[i+2]*1e4);
  const uniq=[], idx=[], map=new Map(), nor=[], uv=[];
  for (let f=0; f<P.length; f+=9){
    for (let v=0; v<3; v++){
      const s=f+v*3, k=key(s);
      let id=map.get(k);
      if (id==null){
        id=uniq.length/3;
        map.set(k,id);
        uniq.push(P[s],P[s+1],P[s+2]);
        nor.push(N[s],N[s+1],N[s+2]);
        uv .push(U[s],U[s+1]);
      }
      idx.push(id);
    }
  }
  return { positions:new Float32Array(uniq), normals:new Float32Array(nor),
           uvs:new Float32Array(uv), indices:new Uint32Array(idx) };
}

window.RBLXmesh = { parseMesh, bounds, weld };
})();
