/* ============================================================
 * world.js  Workspace builder/renderer port.
 * Mined constants, single source of truth:
 *  - BrickColor palette: window.BrickColorFromId (mined from exe table)
 *  - SurfaceType tokens: 0 Smooth, 1 Glue, 2 Weld, 3 Studs, 4 Inlet,
 *    5 Spawn, 6 Hinge, 7 Motor, 8 SteppingMotor (Roblox.exe.c:490994);
 *    the strip atlas has 4 tiles (studs / inlet / weld / glue)
 *  - Part shape tokens: 0 Ball, 1 Block, 2 Cylinder  the VIEW classes are
 *    SphereMesh and CylinderAlongXMesh (FUNCTION_MAP): the cylinder axis is
 *    the part's LOCAL X and every primitive is fit to the full extent
 *  - MeshType tokens: 0 Head, 1 Torso, 2 Wedge, 3 Sphere, 4 Cylinder,
 *    5 FileMesh (decomp EnumDesc)
 *  - Face (NormalId): 0 Right(+x), 1 Top(+y), 2 Back(+z), 3 Left(-x),
 *    4 Bottom(-y), 5 Front(-z : the LookVector face)
 *  - Lighting: TopAmbientV9 / BottomAmbientV9 / ClearColor (V9 packed)
 *  - Sky: 6 embedded faces or content/sky/null_plainsky512_*.jpg
 *  - rocket/part gravity 196.2 studs/s² (classic Workspace gravity)
 * ============================================================ */
(function(){
"use strict";

/* ---------------- surface tiles from the client's real surface atlas ----------
 * decomp: FUN_004cd040 loads `textures\surfaces.png` as a TextureProxy
 * (Roblox.exe.c:204405) and `textures\SurfacesStrip.png` as a separate
 * MegaTextureProxy.  The part-face atlas is Surfaces.png, 64x512 = eight
 * 64x64 tiles: 0/1 studs, 2/3 inlet, 4/5 weld, 6/7 glue.  The two variants
 * differ only by a pixel or two (mip/orientation variants); the first of
 * each pair is used here.
 *
 * A 64x64 tile covers a 2x2-stud patch, so face UV repeat is size/2, not
 * size.  The tile's mid-grey (128) is neutral; the engine's surface pass
 * uses it as a detail map over the brick colour, so the atlas is normalized
 * to white here (otherwise every studded face renders at half brightness).
 * The shipped tile already carries the plain edge ring; the decomp's
 * 0.25-stud border compression (FUN_004d3bd0 / FUN_004e06f0) is preserved
 * by that ring at the tile edges. */
const surfaceLayout={ started:false, img:null, loaded:false, tileCanvases:[], textures:[] };
function ensureSurfaceLoad(){
  if (surfaceLayout.started) return;
  const url=(window.IMAGE_DATA&&window.IMAGE_DATA['content/textures/Surfaces.png']);
  if (!url) return;
  surfaceLayout.started=true;
  const img=new Image();
  surfaceLayout.img=img;
  img.onload=()=>{
    surfaceLayout.loaded=true;
    for (const d of surfaceLayout.tileCanvases) paintSurfaceTile(d.canvas,d.row);
    for (const t of surfaceLayout.textures) t.needsUpdate=true;
  };
  img.src=url;
}
function paintSurfaceTile(canvas,row){
  const g=canvas.getContext('2d');
  g.clearRect(0,0,64,64);
  g.drawImage(surfaceLayout.img,0,row*64,64,64,0,0,64,64);
  /* 128 = neutral; scale the detail map so the face background stays the
   * brick colour.  Data-URL images are same-origin, so this is safe in the
   * embedded build; a dev checkout without IMAGE_DATA uses the fallbacks. */
  let id;
  try { id=g.getImageData(0,0,64,64); } catch(e){ return; }
  const d=id.data;
  for (let i=0;i<d.length;i+=4){
    const v=Math.min(255,Math.round(d[i]*255/128));
    d[i]=d[i+1]=d[i+2]=v;
    d[i+3]=255;
  }
  g.putImageData(id,0,0);
}
function surfaceTileTexture(tileRow, fallbackDraw){
  ensureSurfaceLoad();
  if (!surfaceLayout.started) return fallbackDraw();   // un-embedded dev checkout
  const canvas=document.createElement('canvas'); canvas.width=canvas.height=64;
  surfaceLayout.tileCanvases.push({ canvas, row:tileRow });
  if (surfaceLayout.loaded) paintSurfaceTile(canvas,tileRow);
  const t=new THREE.CanvasTexture(canvas);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;
  surfaceLayout.textures.push(t);
  return t;
}
/* clone that keeps receiving atlas pixels (clones share the canvas but
 * still need their own needsUpdate bump after the atlas decodes) */
function cloneTile(t){
  const c=t.clone(); c.needsUpdate=true;
  surfaceLayout.textures.push(c);
  return c;
}
/* Procedural 2x2 fallbacks, used only when Surfaces.png is not embedded.
 * White is neutral so the brick colour still shows through. */
function fallbackSurfaceTile(kind){
  const c=document.createElement('canvas'); c.width=c.height=64;
  const g=c.getContext('2d');
  g.fillStyle='#ffffff'; g.fillRect(0,0,64,64);
  const stud=(x,y,recess)=>{
    const grd=g.createRadialGradient(x-5,y-6,2,x,y,13);
    if (recess){
      grd.addColorStop(0,'#6a6a6a'); grd.addColorStop(0.7,'#9a9a9a'); grd.addColorStop(1,'#d0d0d0');
    } else {
      grd.addColorStop(0,'#ffffff'); grd.addColorStop(0.6,'#d8d8d8');
      grd.addColorStop(0.9,'#a8a8a8'); grd.addColorStop(1,'#8a8a8a');
    }
    g.beginPath(); g.arc(x,y,13,0,Math.PI*2); g.fillStyle=grd; g.fill();
    g.lineWidth=2; g.strokeStyle=recess?'rgba(0,0,0,0.35)':'rgba(0,0,0,0.25)';
    g.beginPath(); g.arc(x,y,12,0,Math.PI*2); g.stroke();
  };
  if (kind==='studs' || kind==='inlet'){
    for (const y of [16,48]) for (const x of [16,48]) stud(x,y,kind==='inlet');
  } else if (kind==='weld'){
    g.strokeStyle='#5a5a5a'; g.lineWidth=10; g.lineCap='round';
    g.beginPath(); g.moveTo(16,16); g.lineTo(48,48);
    g.moveTo(48,16); g.lineTo(16,48); g.stroke();
  } else {
    g.fillStyle='#6a6a6a'; g.beginPath(); g.arc(32,32,16,0,Math.PI*2); g.fill();
    g.fillStyle='#8a8a8a'; g.beginPath(); g.arc(28,28,9,0,Math.PI*2); g.fill();
  }
  const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;
  return t;
}
const STUD_TEX  = surfaceTileTexture(0, ()=>fallbackSurfaceTile('studs'));
const INLET_TEX = surfaceTileTexture(2, ()=>fallbackSurfaceTile('inlet'));
const WELD_TEX  = surfaceTileTexture(4, ()=>fallbackSurfaceTile('weld'));
const GLUE_TEX  = surfaceTileTexture(6, ()=>fallbackSurfaceTile('glue'));
/* batched surface faces use the base tile plus per-vertex UV scaling, so
 * every size/colour can share one texture instead of one material array. */
function surfaceBaseTexture(map){
  if (!map) return null;
  if (map===STUD_TEX || (map.image && STUD_TEX.image && map.image===STUD_TEX.image)) return STUD_TEX;
  if (map===INLET_TEX || (map.image && INLET_TEX.image && map.image===INLET_TEX.image)) return INLET_TEX;
  return null;
}
const SURFACE_TILE=[STUD_TEX, INLET_TEX, WELD_TEX, GLUE_TEX];

/* SurfaceType tokens (decomp 490994). Face order here is NormalId:
 * 0 Right(+x), 1 Top(+y), 2 Back(+z), 3 Left(-x), 4 Bottom(-y), 5 Front(-z).
 * The PartInstance ctor sets Top=Studs(3) and Bottom=Inlet(4); every other
 * face starts Smooth(0) (Roblox.exe.c:356583). Param defaults are the
 * Surface object's {-0.5, 0.5} (Roblox.exe.c:416708). */
const SURFACE_FACE={Right:0, Top:1, Back:2, Left:3, Bottom:4, Front:5};
const SURFACE_FACE_KEYS=['Right','Top','Back','Left','Bottom','Front'];
const SURFACE_DEFAULT=[0,3,0,0,4,0];
const SURFACE_NAMES={0:'Smooth',1:'Glue',2:'Weld',3:'Studs',4:'Inlet',
                     5:'Spawn',6:'Hinge',7:'Motor',8:'SteppingMotor',9:'Bumps'};
const SURFACE_BY_NAME={};
for (const k in SURFACE_NAMES) SURFACE_BY_NAME[SURFACE_NAMES[k]]=+k;
/* Explosion damage falloff (classic gameplay): point-blank = 100 at the
 * blast centre, linearly down to 0 at BlastRadius.  The decomp's blast
 * pass only applies the pressure impulse (there is no Health write in
 * FUN_00604150/FUN_006029c0), so this is the era's damage model layered
 * on top  see PORT.md §12. */
const BLAST_DAMAGE=100;
function surfToken(v, d){
  if (typeof v==='number' && isFinite(v)){ const t=v|0; return (t>=0&&t<=9)?t:(d||0); }
  if (typeof v==='string'){
    const s=v.trim();
    if (/^\d+$/.test(s)){ const t=parseInt(s,10); return (t>=0&&t<=9)?t:(d||0); }
    if (SURFACE_BY_NAME[s]!=null) return SURFACE_BY_NAME[s];
  }
  return (d==null)?0:d;
}

/* image resolves through embedded client files first (image data URLs
 * file:// canvases may not read cross-origin file images in some browsers) */
function imageContent(url){
  if (window.IMAGE_DATA && window.IMAGE_DATA[url]) return window.IMAGE_DATA[url];
  /* data: URLs pass through; raw base64 (Lua-set TextureId or an old
   * exporter) is wrapped with its sniffed mime type */
  if (window.RBLXxml&&window.RBLXxml.contentUrlFromString)
    url=window.RBLXxml.contentUrlFromString(url,'Texture');
  return url;
}

function mkTex(url, opts){
  /* rbxasset://textures/X → content/textures/X, then embedded-image lookup */
  if (typeof url==='string' && /^rbxasset:\/\//i.test(url)){
    url='content/'+url.slice('rbxasset://'.length);
  }
  const t=new THREE.TextureLoader().load(imageContent(url), undefined, undefined, ()=>{/* silent */});
  t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;
  t.magFilter=THREE.LinearFilter;
  t.minFilter=THREE.LinearMipMapLinearFilter;
  if (opts && opts.mirror){
    /* decal planes on -Z faces rotate y=PI, which mirrors u; a negative
     * repeat flips it back so text reads un-mirrored from the front */
    t.wrapS=THREE.RepeatWrapping;
    t.repeat.x=-1;
  }
  return t;
}

/* ---------------- built-in mesh geometries ---------------- */
/* Fallback only: used if js/headmesh.js is missing. The real built-in head
 * is the exact decomp mesh in headmesh.js. */
function headGeometry(size, scl){
  scl = scl || {x:1,y:1,z:1};
  const rx=size.x*0.5*scl.x, ry=size.y*0.5*scl.y, rz=size.z*0.5*scl.z;
  const g=new THREE.SphereGeometry(1, 20, 14);
  const p=g.attributes.position.array;
  for (let i=0;i<p.length;i+=3){
    const x=p[i], y=p[i+1], z=p[i+2];
    // fallback silhouette only (the real head is the decomp rounded cube)
    p[i]  = Math.sign(x)*Math.pow(Math.abs(x),0.94)*rx;
    p[i+1]= y*ry*1.0;
    p[i+2]= Math.sign(z)*Math.pow(Math.abs(z),0.94)*rz;
  }
  g.computeVertexNormals();
  return g;
}
function wedgeGeometry(size, scl){
  const sx=(size.x||4)*0.5*(scl&&scl.x||1), sy=(size.y||1.2)*0.5*(scl&&scl.y||1), sz=(size.z||2)*0.5*(scl&&scl.z||1);
  const g=new THREE.BufferGeometry();
  // wedge tris (CCW outward): slope top face from bottom front edge to top back edge
  const v=[
    // bottom
    [-sx,-sy,-sz],[ sx,-sy,-sz],[ sx,-sy, sz],
    [-sx,-sy,-sz],[ sx,-sy, sz],[-sx,-sy, sz],
    // back wall (+z)
    [-sx,-sy, sz],[ sx,-sy, sz],[ sx, sy, sz],
    [-sx,-sy, sz],[ sx, sy, sz],[-sx, sy, sz],
    // slope (bottom front edge up to top back edge)
    [ sx,-sy,-sz],[-sx,-sy,-sz],[-sx, sy, sz],
    [ sx,-sy,-sz],[-sx, sy, sz],[ sx, sy, sz],
    // left tri side
    [-sx,-sy,-sz],[-sx,-sy, sz],[-sx, sy, sz],
    // right tri side
    [ sx,-sy,-sz],[ sx, sy, sz],[ sx,-sy, sz],
  ];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}
function sphereGeometry(r){ return new THREE.SphereGeometry(r, 24, 16); }
/* RBX::View::SphereMesh variations are keyed by the full extent vector
 * the classic ball/sphere-shape part is an ellipsoid fit to size, not a
 * max-dimension sphere scaled down. */
function ellipsoidGeometry(rx, ry, rz){
  const g=new THREE.SphereGeometry(1, 24, 16);
  if (Math.abs(rx)>1e-6 && Math.abs(ry)>1e-6 && Math.abs(rz)>1e-6) g.scale(rx, ry, rz);
  return g;
}
/* RBX::View::CylinderAlongXMesh  the class name is explicit: the classic
 * cylinder's axis is the part's LOCAL X (length = size.x), with the round
 * cross-section from size.y / size.z (elliptical when they differ; the mesh
 * factory keys on the full extent). THREE's cylinder axis is +Y, so the
 * along-X orientation is baked into the geometry once. */
function cylinderAlongXGeometry(ry, rz, len){
  const maxR=Math.max(Math.abs(ry), Math.abs(rz))||1;
  const g=new THREE.CylinderGeometry(maxR, maxR, Math.max(len,1e-4), 24, 1, false);
  g.rotateZ(Math.PI/2);                       // +Y axis → +X
  if (Math.abs(ry-rz)>1e-6) g.scale(1, ry/maxR, rz/maxR);
  return g;
}

/* ---------------- real client geometry from the shipped .mesh files ----------------
 * The gear tool meshes are actual 2007 engine assets; the old text format
 * carries no size  the renderer scale-fits them uniformly by the part's
 * height × SpecialMesh.Scale. The classic head is NOT one of these files;
 * it is the generated HeadMesh in js/headmesh.js. head.mesh is retained
 * only as a parser regression fixture. */
const meshFileCache=new Map();
/* build a Part's FileMesh geometry from the old text format.  cacheKey
 * identifies the source (a shipped file name or an embedded Content hash). */
function meshGeoFromText(txt, fitHeight, cacheKey){
  if (!txt) return null;
  let rec=meshFileCache.get(cacheKey);
  if (!rec){
    try {
      const parsed=window.RBLXmesh.parseMesh(txt);
      const w=window.RBLXmesh.weld(parsed);
      rec={ w, bounds:window.RBLXmesh.bounds(parsed) };
      meshFileCache.set(cacheKey, rec);
    } catch (_){ return null; }
  }
  const span=rec.bounds.span;
  const s=Math.abs(span[1])>1e-9? fitHeight/span[1] : 1;
  const mn=rec.bounds.min;
  const g=new THREE.BufferGeometry();
  const P=new Float32Array(rec.w.positions.length);
  for (let i=0;i<P.length;i+=3){
    P[i]  =(rec.w.positions[i]  -mn[0])*s;   // center the bbox at the origin
    P[i+1]=(rec.w.positions[i+1]-mn[1])*s;
    P[i+2]=(rec.w.positions[i+2]-mn[2])*s;
  }
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  const N=new Float32Array(rec.w.normals.length);
  for (let i=0;i<N.length;i++) N[i]=rec.w.normals[i]*s;   // re-unit in computeVertexNormals
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(rec.w.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(rec.w.indices, 1));
  g.computeVertexNormals();
  return g;
}
function fileMeshGeo(fileName, fitHeight){
  const txt=(window.CORE_ASSETS&&window.CORE_ASSETS['fonts/'+fileName])||null;
  if (!txt) return null;                      // un-embedded checkout: no file
  return meshGeoFromText(txt, fitHeight, 'file:'+fileName);
}
/* Tool models for the default HopperBins  each BinType had its real
 * hand model in fonts/<name>.mesh with its own texture (all shipped in
 * content/textures). BinType↔model pairs straight from the shipped set.
 * The meshes are authored in one shared unit: every hand tool is about
 * 8 units long.  1 unit = 1/3 stud keeps them at classic tool size (a
 * hammer is 2.4 studs, the launcher 3.5, the slingshot 2.6) without any
 * per-tool fitting.  They are rendered in the engine's held-tool frame:
 * RightArm.CFrame * CFrame.new(0,-1,0) * CFrame.Angles(-pi/2,0,0) *
 * Tool.Grip^-1, with the default identity Grip for a HopperBin (bins
 * carry no grip data). */
const TOOL_MESH_STUDS_PER_UNIT=1/3;
/* CFrame.Angles(-pi/2, 0, 0) row-major  the rotation half of the engine
 * RightGrip C0 (decomp FUN_005d1450; its translation is (0,-1,0)). */
const TOOL_HAND_ROT=[1,0,0, 0,0,1, 0,-1,0];
const TOOL_MODEL={
  1:['trowel.mesh','textures/TrowelTexture.png'],            // GameTool
  3:['clonewand.mesh','textures/CloneWandTexture.png'],      // Clone
  4:['hammer.mesh','textures/hammertex128.png'],             // Hammer
  5:['slingshot.mesh','textures/SlingshotTexture.png'],      // Slingshot
  6:['rocketlauncher.mesh','textures/rocketlaunchertex.png'] // Rocket
};
const toolMatCache=new Map(), toolGeoCache=new Map();
/* gear geometry: authored origin (the handle-part origin), uniform scale.
 * No bbox fit/centering  that was what turned the clonewand into a
 * 9-stud rod and the launcher into a 6-stud sideways beam. */
function toolMeshGeo(fileName){
  const txt=(window.CORE_ASSETS&&window.CORE_ASSETS['fonts/'+fileName])||null;
  if (!txt) return null;
  let rec=meshFileCache.get(fileName);
  if (!rec){
    try {
      const parsed=window.RBLXmesh.parseMesh(txt);
      rec={ w:window.RBLXmesh.weld(parsed), bounds:window.RBLXmesh.bounds(parsed) };
      meshFileCache.set(fileName, rec);
    } catch (_){ return null; }
  }
  const g=new THREE.BufferGeometry();
  const s=TOOL_MESH_STUDS_PER_UNIT;
  const P=new Float32Array(rec.w.positions.length);
  for (let i=0;i<P.length;i++) P[i]=rec.w.positions[i]*s;
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(rec.w.normals), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(rec.w.uvs), 2));
  g.setIndex(new THREE.BufferAttribute(rec.w.indices, 1));
  g.computeVertexNormals();
  return g;
}
function buildToolModel(binType){
  const spec=TOOL_MODEL[binType];
  if (!spec) return null;
  let mat=toolMatCache.get(binType);
  if (!mat){
    const tex=mkTex('content/'+spec[1]);
    mat=new THREE.MeshLambertMaterial({ map:tex, transparent:true });
    toolMatCache.set(binType, mat);
  }
  let geo=toolGeoCache.get(binType);
  if (!geo){
    geo=toolMeshGeo(spec[0]);
    if (!geo) return null;
    toolGeoCache.set(binType, geo);
  }
  return { geo, mat };
}

/* ---------------- WorldBuilder ---------------- */
/* Rotate one authored sky face into the GL cube orientation.  rot is a
 * quarter-turn count CCW: 0 none, 1 CCW, 2 180, 3 CW.  The authored faces
 * are bottom-up relative to GL's cube convention, so the rotated face is
 * flipped vertically before upload; without that the clouds land below the
 * horizon and the whole sky reads upside down. */
function skyFaceCanvas(img, rot){
  const w=img.naturalWidth||img.width, h=img.naturalHeight||img.height;
  if (!w||!h) return img;
  const odd=!!(rot&1);
  const c=document.createElement('canvas');
  c.width=odd?h:w; c.height=odd?w:h;
  const g=c.getContext('2d');
  g.translate(c.width/2,c.height/2);
  g.scale(1,-1);                    /* G3D face rows run bottom-up */
  g.rotate(-rot*Math.PI/2);
  g.drawImage(img,-w/2,-h/2,w,h);
  return c;
}

/* Soft radial mask for the lens-flare billboard.  The shipped
 * lensflare.jpg is a solid white circle with a hard rim; used directly it
 * paints a visible ring over the sky.  This grayscale mask (white centre
 * to black rim) fades the rim out under additive blending. */
function radialFadeTexture(inner, outer){
  const c=document.createElement('canvas'); c.width=c.height=128;
  const g=c.getContext('2d');
  const grd=g.createRadialGradient(64,64,0,64,64,64);
  grd.addColorStop(0,'#ffffff');
  grd.addColorStop(inner==null?0.30:inner,'#ffffff');
  grd.addColorStop(outer==null?0.50:outer,'#000000');
  grd.addColorStop(1,'#000000');
  g.fillStyle=grd; g.fillRect(0,0,128,128);
  const t=new THREE.CanvasTexture(c);
  t.needsUpdate=true;
  return t;
}

/* ControllerType enum (decomp FUN_0058fc90): 0 None, 1 KeyboardRight,
 * 2 KeyboardLeft, 3 Joypad1, 4 Joypad2, 5 Chase, 6 Flee, 7 Player.
 * FUN_005b8060 maps those to the client's colour constants:
 *   KeyboardLeft red, KeyboardRight blue, Player violet, Chase black,
 *   Flee yellow, None/Joypads grey (0.7,0.7,0.7). */
const CONTROLLER_TYPE={None:0,KeyboardRight:1,KeyboardLeft:2,Joypad1:3,
  Joypad2:4,Chase:5,Flee:6,Player:7};
const CONTROLLER_COLOR={
  0:[0.7,0.7,0.7], 1:[0,0,1], 2:[1,0,0], 3:[0.7,0.7,0.7],
  4:[0.7,0.7,0.7], 5:[0,0,0], 6:[1,1,0], 7:[0.7,0,1]
};
function controllerValue(v){
  if (typeof v==='number' && isFinite(v)) return v|0;
  if (typeof v==='string'){
    if (CONTROLLER_TYPE[v]!=null) return CONTROLLER_TYPE[v];
    const n=Number(v);
    if (isFinite(n)) return n|0;
  }
  return null;
}
const FLAG_POLE=3.0, FLAG_W=2.0, FLAG_H=1.5;

class WorldBuilder {
  constructor(scene){
    this.scene = scene;
    this.partLook  = new Map();   // inst -> look record {obj, size, shape, cf, coll}
    this.colliders = [];          // look records with canCollide
    this.spawnPoints = [];        // look records of SpawnLocation
    this.hoppers = [];            // insts
    this.tools = [];              // Tool insts
    this.inventory = [];          // HopperBin/Tool in .rbxl traversal order
    this.allInsts = [];
    this.byName = new Map();      // lowercase Name -> [insts]
    this.destroyed = new Set();   // insts removed
    this.icons = new Map();       // inst -> icon url (Tool.TextureId)
    this.materialCache = new Map();
    this.geometryCache = new Map();
    this.skyMesh = null;
    this.character = null;        // registered by main for humanoid queries
    this.explodeSoundHook = null;
    this.grabbed = null;          // {look, offset}
    /* merged static render batches: anchored plain blocks collapse into one
     * vertex-colored mesh; identical material-array parts (same size+color+
     * surfaces ⇒ same UV repeat) collapse per array.  Members keep their
     * individual (hidden) meshes so mutations can pull them back out. */
    this._staticBatch=null;       // [Mesh,...]
    this._batchDirty=true;
    /* climbable geometry (Humanoid Climbing): TrussParts and brick ladders.
     * Crossroads' ladders are Models named "Ladder" built from ordinary
     * bricks, so the parts are grouped by that model and their boxes unioned
     * into ONE climb volume  rung gaps never break the climb. */
    this._climbLooks=[];          // look records flagged climbable
    this.climbVolumes=[];         // [{min,max,parts,group}]
    this._climbDirty=false;
    /* explicit JointInstance records (Weld/Glue/Motor/RotateP/RotateV).
     * rbxenv fills this map as joints are loaded/parented; dynamics reads it
     * at each re-cluster. */
    this.jointRecs=new Map();
    this.flags=[];                // {group, cloth} controller flags
    this._flagMats=new Map();     // controller type -> basic material
    this._parsed=null;            // kept for the post-dynamics flag refresh
  }
  /* batch eligibility  blocks only, in IMMOBILE assemblies (anchored
   * themselves or welded to an anchored member  see dynamics.isImmobile);
   * decals/meshes/transparency stay solo */
  _batchable(look){
    if (!look||look.destroyed||!look.obj) return false;
    if (look.controllerFlag) return false;   // flag is a live child
    if (look.shape!==1) return false;
    /* Cullable=false means the client must keep submitting this part even
     * when its bounds leave the frustum.  A merged batch has one frustum
     * test for many parts, so keep such parts solo. */
    if (look.part&&look.part.props.Cullable===false) return false;
    /* the merged batch has one Lambert/vertex-colour material, so a
     * reflective part must keep its own Phong material */
    if (look.part&&(look.part.props.Reflectance||0)>0.001) return false;
    if (look.scriptMover) return false;
    const rv=look.rotVelocity;
    if (rv&&(rv.x||rv.y||rv.z)) return false;
    if (window.RBLXdyn&&window.RBLXdyn._ready){
      if (!window.RBLXdyn.isImmobile(look)) return false;
    } else if (!look.anchored) return false;   /* pre-dynamics: anchored only */
    if (look.part&&look.part.children.some(c=>c.cls==='SpecialMesh'||c.cls==='Decal'||c.cls==='Texture')) return false;
    /* hinge/motor faces carry child peg meshes  the merge only copies the
     * box itself, so these stay solo like decal/mesh parts */
    if (look.surf && look.surf.some(t=>t>=6 && t<=8)) return false;
    const tr=look.part&&look.part.props.Transparency||0;
    if (tr>0.001) return false;
    return true;
  }
  markStaticDirty(){
    this._batchDirty=true;
  }
  frameUpdate(){
    if (this._batchDirty) this._rebuildStaticBatch();
    if (this.flags.length){
      const t=performance.now()*0.003;
      for (const f of this.flags){
        const ph=f.cloth.userData.phase||0;
        f.cloth.rotation.y=Math.sin(t+ph)*0.22;
        f.cloth.rotation.z=Math.sin(t*0.7+ph)*0.06;
      }
    }
  }
  _rebuildStaticBatch(){
    this._batchDirty=false;
    if (this._staticBatch){
      for (const m of this._staticBatch){ this.scene.remove(m); m.geometry.dispose(); }
    }
    this._staticBatch=null;
    const out=[];
    /* One vertex-coloured mesh for every untextured face.  Surface-art
     * faces (Studs/Inlet) share the base atlas tile; their per-size repeat
     * is baked into the vertex UVs and their brick colour becomes the
     * material colour, so sizes/colours merge into one mesh per tile
     * instead of one material array per distinct part size. */
    const plain={pos:[],nor:[],col:[],idx:[],vo:0};
    const texBuckets=new Map();    // baseTexture|colour -> {pos,nor,uv,idx,vo,mat}
    this._batchTexMats=this._batchTexMats||new Map();
    for (const look of this.partLook.values()){
      const wasBatched=!!look.__batched;
      if (!this._batchable(look)){
        look.__batched=false;
        if (wasBatched&&look.obj){
          if (look.destroyed){
            look.obj.visible=false;             /* never resurrect a dead part */
          } else {
            look.obj.matrixAutoUpdate=true;     /* live again  transform updates */
            /* batched members are removed from the scene, not just hidden;
             * put them back when they become live again */
            if (look.obj.parent!==this.scene) this.scene.add(look.obj);
            if (!(look.part&&look.part.props.Transparency>0.999)) look.obj.visible=true;
          }
        }
        continue;
      }
      /* parts carry pure rotations (orthonormal rows): transform inline
       * p' = R·p + P, n' = R·n  no per-vertex Matrix/Vector3 calls */
      const R=look.cf.rot, P=look.cf.pos;
      const g=this._geoBlock(look.size);
      const pv=g.attributes.position.array, nv=g.attributes.normal.array, ix=g.index.array;
      const uv=g.attributes.uv&&g.attributes.uv.array;
      const mat=look.obj.material;
      const nvtx=pv.length/3;
      const tfPos=new Array(nvtx*3), tfNor=new Array(nvtx*3);
      for (let i=0;i<pv.length;i+=3){
        const x=pv[i], y=pv[i+1], z=pv[i+2];
        tfPos[i]=R[0]*x+R[1]*y+R[2]*z+P.x;
        tfPos[i+1]=R[3]*x+R[4]*y+R[5]*z+P.y;
        tfPos[i+2]=R[6]*x+R[7]*y+R[8]*z+P.z;
        const nx=nv[i], ny=nv[i+1], nz=nv[i+2];
        tfNor[i]=R[0]*nx+R[1]*ny+R[2]*nz;
        tfNor[i+1]=R[3]*nx+R[4]*ny+R[5]*nz;
        tfNor[i+2]=R[6]*nx+R[7]*ny+R[8]*nz;
      }
      const addPlainGroup=(grp,m)=>{
        const col=m&&m.color? [m.color.r,m.color.g,m.color.b]
          : [look.entry.rgb[0]/255,look.entry.rgb[1]/255,look.entry.rgb[2]/255];
        const map=new Map();
        const base=plain.vo;
        for (let k=grp.start;k<grp.start+grp.count;k++){
          const oi=ix[k];
          let ni=map.get(oi);
          if (ni==null){
            ni=plain.vo++;
            map.set(oi,ni);
            plain.pos.push(tfPos[oi*3],tfPos[oi*3+1],tfPos[oi*3+2]);
            plain.nor.push(tfNor[oi*3],tfNor[oi*3+1],tfNor[oi*3+2]);
            plain.col.push(col[0],col[1],col[2]);
          }
          plain.idx.push(ni);
        }
        return base;
      };
      if (!Array.isArray(mat)){
        addPlainGroup({start:0,count:ix.length},mat);
      } else {
        for (const grp of g.groups){
          const m=mat[grp.materialIndex]||mat[0];
          if (!m){ continue; }
          const baseTex=surfaceBaseTexture(m.map);
          if (!baseTex){ addPlainGroup(grp,m); continue; }
          const key=baseTex.uuid+'|'+(m.color?m.color.getHex():0xffffff);
          let B=texBuckets.get(key);
          if (!B){
            let bm=this._batchTexMats.get(key);
            if (!bm){
              bm=new THREE.MeshLambertMaterial({
                map:baseTex, color:m.color?m.color.clone():new THREE.Color(1,1,1),
                side:THREE.DoubleSide
              });
              this._batchTexMats.set(key,bm);
            }
            B={pos:[],nor:[],uv:[],idx:[],vo:0,mat:bm};
            texBuckets.set(key,B);
          }
          const rep=m.map.repeat||{x:1,y:1}, off=m.map.offset||{x:0,y:0};
          const map=new Map();
          for (let k=grp.start;k<grp.start+grp.count;k++){
            const oi=ix[k];
            let ni=map.get(oi);
            if (ni==null){
              ni=B.vo++;
              map.set(oi,ni);
              B.pos.push(tfPos[oi*3],tfPos[oi*3+1],tfPos[oi*3+2]);
              B.nor.push(tfNor[oi*3],tfNor[oi*3+1],tfNor[oi*3+2]);
              const u=uv? uv[oi*2]:0, v=uv? uv[oi*2+1]:0;
              B.uv.push(u*rep.x+off.x, v*rep.y+off.y);
            }
            B.idx.push(ni);
          }
        }
      }
      look.__batched=true;
      look.obj.visible=false;
      look.obj.matrixAutoUpdate=false;          /* frozen into the batch */
      /* Remove frozen members from the scene graph: updateMatrixWorld
       * would otherwise walk thousands of hidden part meshes every frame. */
      if (look.obj.parent===this.scene) this.scene.remove(look.obj);
    }
    if (plain.vo){
      const geo=new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(plain.pos),3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(plain.nor),3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(plain.col),3));
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(plain.idx),1));
      geo.computeBoundingSphere();
      const mesh=new THREE.Mesh(geo, new THREE.MeshLambertMaterial({vertexColors:true, side:THREE.DoubleSide}));
      mesh.frustumCulled=true;
      this.scene.add(mesh);
      out.push(mesh);
    }
    for (const B of texBuckets.values()){
      if (!B.vo) continue;
      const geo=new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(B.pos),3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(B.nor),3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(B.uv),2));
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(B.idx),1));
      geo.computeBoundingSphere();
      const mesh=new THREE.Mesh(geo, B.mat);
      this.scene.add(mesh);
      out.push(mesh);
    }
    this._staticBatch=out;
  }

  /* ---------- lighting / sky ---------- */
  /* Classic celestial loop (G3D::Sky + Lighting): the sun arcs from the
   * east horizon (+X) through the zenith to the west, the moon rides the
   * antipode. Full 24h loop (angle 0 = 06:00 sunrise, π/2 = 12:00 zenith,
   * π = 18:00 sunset, 3π/2 = midnight nadir). Directional light aims from
   * the actual body  sun by day, faint moon by night. */
  setCelestialTime(hrs){
    if (!this.lighting) return;
    this.lighting.hrs=hrs;
    const a=(hrs-6)/24*Math.PI*2;                 // full day loop
    const sunAlt=Math.sin(a);                     // -1 nadir .. 1 zenith
    const up=sunAlt>0;                            // sun above horizon
    if (this._dir){
      // light comes from the body that is up: sun in day, moon at night.
      // Brightness is the G3D display gamma, not a light multiplier.
      const y=up? Math.max(0.35,sunAlt) : Math.max(0.35,-sunAlt);
      const x=up? Math.cos(a) : -Math.cos(a);
      this._dir.position.set(x*2.2, y*2.2, 0.12);
      this._dir.intensity= (up? 0.30 : 0.10);
    }
    if (!this.celestial) return;
    const show=this.lighting.celestial!==false;   /* CelestialBodiesShown */
    const R=this.CELEST_R;
    const sx=Math.cos(a)*R, sy=sunAlt*R;
    const fade=v=>Math.max(0,Math.min(1,(v+0.08)/0.20));
    const sunO=fade(sunAlt), moonO=fade(-sunAlt);
    for (const q of this.celestial.children){
      const u=q.userData;
      q.visible=show && u.op!==0 && (u.moon? moonO>0 : sunO>0);
      if (u.moon){ q.position.set(-sx,-sy,0); q.material.opacity=moonO*u.op; }
      else { q.position.set(sx,sy,0); q.material.opacity=sunO*u.op; }
    }
    this.celestial.visible=show;
  }
  applyLighting(L){
    const p=L&&L.props;
    /* decomp (Roblox.exe.c): RBX::Lighting registers Color3 props
     * (TopAmbientV9/BottomAmbientV9/SpotLightV9/ClearColor, packed
     * AARRGGBB) + the TimeOfDay string + Brightness float
     * ("Brightness set."); G3D uploads per-light
     * ambient(0x1200)/diffuse(0x1201)/specular(0x1202)/position(0x1203)
     * and enables GL_LIGHT_MODEL_TWO_SIDE (0x0B52, FUN_00473690)  the
     * GL fixed-function model the G3D layer consumes as a hemisphere
     * ambient + one directional "sun" + two-sided brick materials.
     * Brightness is the display gamma (setBrightness stores
     * 1.0/brightness); it is not a light-intensity multiplier. */
    const v9=x=>{ const u=x>>>0; return new THREE.Color(((u>>>16)&255)/255,((u>>>8)&255)/255,(u&255)/255); };
    const clear=(p&&p.ClearColor!=null)? v9(p.ClearColor.raw!=null?p.ClearColor.raw:p.ClearColor) : null;
    if (clear) this.scene.background=clear;
    else this.scene.background=new THREE.Color(0x6a94b4);
    const T=(p&&p.TopAmbientV9!=null)? v9(p.TopAmbientV9.raw!=null?p.TopAmbientV9.raw:p.TopAmbientV9) : {r:1,g:1,b:1};
    const B=(p&&p.BottomAmbientV9!=null)? v9(p.BottomAmbientV9.raw!=null?p.BottomAmbientV9.raw:p.BottomAmbientV9)
                                  : {r:0.25,g:0.3,b:0.35};
    const spot=(p&&p.SpotLightV9!=null)? v9(p.SpotLightV9.raw!=null?p.SpotLightV9.raw:p.SpotLightV9) : null;
    const bright=Math.max(0, (p&&Number(p.Brightness))||1);
    const raw={
      clear:(p&&p.ClearColor!=null)?(p.ClearColor.raw!=null?p.ClearColor.raw:p.ClearColor):null,
      top:(p&&p.TopAmbientV9!=null)?(p.TopAmbientV9.raw!=null?p.TopAmbientV9.raw:p.TopAmbientV9):null,
      bottom:(p&&p.BottomAmbientV9!=null)?(p.BottomAmbientV9.raw!=null?p.BottomAmbientV9.raw:p.BottomAmbientV9):null,
      spot:(p&&p.SpotLightV9!=null)?(p.SpotLightV9.raw!=null?p.SpotLightV9.raw:p.SpotLightV9):null,
    };
    this.lighting={ clear, top:T, bottom:B, spot, raw,
                    brightness:bright,
                    tod:(p && p.TimeOfDay)||'14:00:00',
                    celestial:(p && p.CelestialBodiesShown)!==false };
    /* TimeOfDay drives the sun sweep (classic sky loop: 06:00 sunrise →
     * 12:00 zenith → 18:00 sunset); parse "HH:MM[:SS]" */
    const hms=String(this.lighting.tod).split(':').map(v=>parseFloat(v)||0);
    const hrs=(hms[0]||0)+(hms[1]||0)/60+(hms[2]||0)/3600;
    const a=(hrs-6)/12*Math.PI;                  // sun's arc angle
    const up= hrs>=6 && hrs<18;
    const dim= up? 1 : 0.45;                     // night: pull ambient down
    if (this._hemi) this.scene.remove(this._hemi);
    this._hemi=new THREE.HemisphereLight(new THREE.Color(T.r,T.g,T.b).multiplyScalar(dim===1?1:0.55),
                                         new THREE.Color(B.r,B.g,B.b), 1.12);
    this.scene.add(this._hemi);
    this.scene.userData=this.scene.userData||{};
    this.scene.userData.lightingBrightness=Math.max(0.01, bright);
    /* the sun light = GL_LIGHT0: diffuse from SpotLightV9 (the era's
     * "spot light" IS the sun); G3D leaves the GL light specular at the
     * fixed-function default white, so material specular 0.2 gives every
     * part its plastic sheen. */
    if (this._dir) this.scene.remove(this._dir);
    const spotCol=spot? new THREE.Color(spot.r,spot.g,spot.b) : new THREE.Color(0xffffff);
    this._dir=new THREE.DirectionalLight(spotCol, (up? 0.30 : 0.10));
    if (up){
      // sun arcs east → west; z offset keeps faces shaded like the client
      this._dir.position.set(Math.cos(a)*1.0, Math.max(0.25,Math.sin(a))*1.8, -0.42);
    } else {
      this._dir.position.set(-0.55, 1.8, -0.42);
    }
    this.scene.add(this._dir);
    this.setCelestialTime(hrs);   // update dir light from the real body pos
    /* two-sided lighting (GL_LIGHT_MODEL_TWO_SIDE, FUN_00473690): brick
     * faces light from either side  DoubleSide on the shared materials */
    this._twoSidedBricks();
  }
  _twoSidedBricks(){
    for (const m of this.materialCache.values()){
      const mats=m&&(m.mats||m);
      for (const mm of (Array.isArray(mats)? mats : [mats])){
        if (mm&&mm.isMaterial&&mm.side!==THREE.DoubleSide){ mm.side=THREE.DoubleSide; mm.needsUpdate=true; }
      }
    }
  }
  /* live Lighting property writes (rbxenv) re-apply the whole model */
  applyLightingProps(props){
    const cur=this.lighting||{};
    this.applyLighting({ props:Object.assign({
      ClearColor: cur.raw&&cur.raw.clear, TopAmbientV9: cur.raw&&cur.raw.top,
      BottomAmbientV9: cur.raw&&cur.raw.bottom, SpotLightV9: cur.raw&&cur.raw.spot,
      TimeOfDay: cur.tod, CelestialBodiesShown: cur.celestial, Brightness: cur.brightness,
    }, props) });
  }

  /* ---------- ControllerFlags (decomp FUN_005350f0/FUN_00534fd0) ----------
   * A flag is drawn on the model's PrimaryPart when ControllerFlagShown is
   * true and the controller is not Player(7).  FUN_00534fd0 passes size 3.0
   * to FUN_0061ca50; the colour comes from FUN_005b8060.  We build the
   * pole+triangular pennant from local geometry and keep it as a part child
   * so it follows the primary part. */
  _buildControllerFlags(parsed){
    /* Rebuild pass: drop any flag created by an earlier evaluation (the
     * load-time pass runs before dynamics knows which assemblies are
     * welded to anchored scenery). */
    for (const f of this.flags){
      if (f.group&&f.group.parent) f.group.parent.remove(f.group);
    }
    this.flags=[];
    for (const look of this.partLook.values()){
      look.controllerFlag=false;
      look.flagGroup=null;
    }
    const flagged=new Set();
    const firstPart=(inst)=>{
      const walk=(n)=>{
        for (const c of n.children||[]){
          if (c.cls==='Part'||c.cls==='SpawnLocation'||c.cls==='TrussPart') return c;
          const r=walk(c); if (r) return r;
        }
        return null;
      };
      return walk(inst);
    };
    const hasModelAncestor=(inst)=>{
      let p=inst&&inst.parent;
      while (p){ if (p.cls==='Model') return true; p=p.parent; }
      return false;
    };
    for (const inst of parsed.instances||[]){
      if (inst.cls!=='Model') continue;
      const ctrl=controllerValue(inst.props.Controller);
      if (ctrl==null||ctrl===0||ctrl===7) continue;
      if (inst.props.ControllerFlagShown===false) continue;
      const pp=inst.props.PrimaryPart;
      const part=(pp&&this.partLook.has(pp))?pp:firstPart(inst);
      if (!part) continue;
      if (this._addControllerFlag(part,ctrl)) flagged.add(part);
    }
    for (const inst of parsed.instances||[]){
      if (!(inst.cls==='Part'||inst.cls==='SpawnLocation'||inst.cls==='TrussPart')) continue;
      if (flagged.has(inst)||hasModelAncestor(inst)) continue;
      const ctrl=controllerValue(inst.props.Controller);
      if (ctrl==null||ctrl===0||ctrl===7) continue;
      if (inst.props.ControllerFlagShown===false) continue;
      this._addControllerFlag(inst,ctrl);
    }
  }
  _addControllerFlag(partInst, ctrl){
    const look=this.partLook.get(partInst);
    if (!look||look.destroyed||look.controllerFlag||!look.obj) return false;
    /* A flag marks a part that can actually be driven.  Static scenery
     * (anchored, or welded/glued into an anchored assembly) is not a
     * controller target: RobloxHQ's castle/trees and Crossroads' ramps
     * carry Controller=2 in their files but must not grow flags.  This
     * matches the engine's root/movable assembly behaviour. */
    if (!this.flagEligible(look)) return false;
    let mat=this._flagMats.get(ctrl);
    if (!mat){
      const rgb=CONTROLLER_COLOR[ctrl]||CONTROLLER_COLOR[0];
      mat=new THREE.MeshBasicMaterial({ color:new THREE.Color(rgb[0],rgb[1],rgb[2]),
                                        side:THREE.DoubleSide });
      this._flagMats.set(ctrl,mat);
    }
    look.controllerFlag=true;
    const g=new THREE.Group();
    g.name='ControllerFlag';
    g.position.y=(look.size&&look.size.y?look.size.y:2)/2;
    const pole=new THREE.Mesh(new THREE.BoxGeometry(0.12,FLAG_POLE,0.12),mat);
    pole.position.y=FLAG_POLE/2;
    g.add(pole);
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute([
      0,FLAG_POLE,0, FLAG_W,FLAG_POLE,0, 0,FLAG_POLE-FLAG_H,0
    ],3));
    const cloth=new THREE.Mesh(geo,mat);
    cloth.userData.phase=Math.random()*Math.PI*2;
    g.add(cloth);
    look.obj.add(g);
    look.flagGroup=g;
    this.flags.push({ group:g, cloth });
    this.markStaticDirty();
    return true;
  }
  /* live Controller/ControllerFlagShown writes */
  flagEligible(look){
    if (!look||look.destroyed||!look.obj) return false;
    if (look.anchored) return false;
    /* before dynamics has built the joint graph only Anchored is known;
     * main.js re-runs _buildControllerFlags after RBLXdyn.init */
    if (window.RBLXdyn&&window.RBLXdyn._ready&&window.RBLXdyn.isImmobile(look))
      return false;
    return true;
  }
  /* Re-evaluate every flag after dynamics built the weld/glue graph (or
   * after a script changed Anchored).  Parts welded to anchored scenery
   * lose their flag; movable controller assemblies keep it. */
  refreshControllerFlags(){
    if (!this._parsed) return;
    this._buildControllerFlags(this._parsed);
    this.markStaticDirty();
  }
  primaryPartOf(modelInst){
    if (!modelInst) return null;
    const pp=modelInst.props&&modelInst.props.PrimaryPart;
    if (pp&&this.partLook.has(pp)) return pp;
    const walk=(n)=>{
      for (const c of n.children||[]){
        if (c.cls==='Part'||c.cls==='SpawnLocation'||c.cls==='TrussPart') return c;
        const r=walk(c); if (r) return r;
      }
      return null;
    };
    return walk(modelInst);
  }
  _removeControllerFlag(partInst){
    const look=this.partLook.get(partInst);
    if (!look||!look.flagGroup) return;
    const old=look.flagGroup;
    if (old.parent) old.parent.remove(old);
    look.flagGroup=null;
    look.controllerFlag=false;
    this.flags=this.flags.filter(f=>f.group!==old);
    this.markStaticDirty();
  }
  refreshModelControllerFlag(modelInst){
    const part=this.primaryPartOf(modelInst);
    if (!part) return;
    if (modelInst.props&&modelInst.props.ControllerFlagShown===false){
      this._removeControllerFlag(part); return;
    }
    const ctrl=controllerValue(modelInst.props&&modelInst.props.Controller);
    this._removeControllerFlag(part);
    if (ctrl==null||ctrl===0||ctrl===7) return;
    this._addControllerFlag(part,ctrl);
  }
  refreshControllerFlag(partInst){
    const look=this.partLook.get(partInst);
    if (!look) return;
    this._removeControllerFlag(partInst);
    let ctrl=controllerValue(partInst.props&&partInst.props.Controller);
    let parent=partInst&&partInst.parent;
    while ((ctrl==null||ctrl===0)&&parent){
      if (parent.cls==='Model') ctrl=controllerValue(parent.props.Controller);
      parent=parent.parent;
    }
    if (ctrl==null||ctrl===0||ctrl===7) return;
    if (partInst.props&&partInst.props.ControllerFlagShown===false) return;
    this._addControllerFlag(partInst,ctrl);
  }

  applySky(skyInst){
    // face order for CubeTexture: [+x, -x, +y, -y, +z, -z]
    // Roblox naming: Rt=+x, Lf=-x, Up=+y, Dn=-y, Ft=+z, Bk=-z.
    // URLs resolve through the embedded data URLs first  file://
    // fetch/image uploads are CORS-tainted for WebGL; data URLs are not.
    const files=['rt','lf','up','dn','ft','bk'];
    const propNames=['SkyboxRt','SkyboxLf','SkyboxUp','SkyboxDn','SkyboxFt','SkyboxBk'];
    const urls=[];
    for (let i=0;i<6;i++){
      let src=null;
      if (skyInst){
        const p=skyInst.props[propNames[i]];
        if (p && (p.binary||p.url)) src=p.url||p.binary;
      }
      if (!src) src='content/sky/null_plainsky512_'+files[i]+'.jpg';
      urls.push(imageContent(src));
    }
    /* G3D's cube-face convention is not three's.  Rotating each authored
     * face to the GL cube orientation removes the visible face outlines
     * (verified by edge-color continuity across all adjacent faces, both
     * on the shipped plainsky and on Crossroads' embedded sky).  The
     * mapping is [Rt,Lf,Up,Dn,Ft,Bk] -> quarter turns CCW. */
    const faceRot=[2,2,1,3,2,2];
    const cube=new THREE.CubeTexture([]);
    this.skyCube=cube;                  /* reflection map (build 63) */
    cube.wrapS=cube.wrapT=THREE.ClampToEdgeWrapping;
    cube.minFilter=THREE.LinearFilter;
    cube.magFilter=THREE.LinearFilter;
    cube.generateMipmaps=false;
    const loader=new THREE.ImageLoader();
    let pending=6;
    const faceDone=()=>{ if (--pending===0) cube.needsUpdate=true; };
    urls.forEach((url,i)=>{
      loader.load(url, img=>{
        cube.images[i]=skyFaceCanvas(img,faceRot[i]);
        faceDone();
      }, undefined, faceDone);
    });
    cube.needsUpdate=true;
    const mat=new THREE.MeshBasicMaterial({ envMap: cube, side: THREE.BackSide, depthWrite:false });
    this.skyMesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1), mat);
    this.skyMesh.scale.setScalar(4000);
    /* The seamless face mapping above is yawed +90 degrees relative to
     * the client's sky heading; yaw the cube back so the clouds/horizon
     * sit where they did before the seam fix. */
    this.skyMesh.rotation.y=-Math.PI/2;
    this.skyMesh.frustumCulled=false;
    this.skyMesh.renderOrder=-10;
    this.scene.add(this.skyMesh);
    this._buildCelestial();
    if (this.lighting) this.setCelestialTime(this.lighting.hrs!=null?this.lighting.hrs:14);
    return cube;
  }

  /* ---------- celestial bodies (the shipped content/sky pack) ---------- */
  /* G3D::Sky loaded 5 textures as twin loaders (decomp 776560-776780):
   * sun @0xA plain loader, moon @0xB + moon-alpha mask loader, lensflare
   * @0xC, sun-rays @0xD  all under content/sky/. Rendered billboarded
   * inside the skybox radius, occluded by parts (depthTest), no depth
   * writes. Sizes are APPROX (the DLL's vertex transform constants are
   * beneath them (the DLL's vertex transform constants are unrecovered;
   * textures are the client's own files). */
  _buildCelestial(){
    if (this.celestial) return;
    const mk=(url, size, opts)=>{
      const m=new THREE.MeshBasicMaterial({
        map: mkTex(url), transparent:true, depthWrite:false, depthTest:true,
        blending: opts&&opts.additive? THREE.AdditiveBlending : THREE.NormalBlending,
        side: THREE.DoubleSide });
      if (opts&&opts.alphaTexture){ m.alphaMap=opts.alphaTexture; m.alphaMap.needsUpdate=true; }
      else if (opts&&opts.alphaMap){ m.alphaMap=mkTex(opts.alphaMap); m.alphaMap.needsUpdate=true; }
      m.opacity=0;
      const q=new THREE.Mesh(new THREE.PlaneGeometry(size,size), m);
      q.userData={ moon: !!opts.moon, op: opts&&opts.op!=null? opts.op : 1 };
      q.renderOrder=-5;                       // above skybox, below parts
      q.frustumCulled=false;
      this.celestial.add(q);
      return q;
    };
    this.celestial=new THREE.Group();
    this.CELEST_R=1300;                       // inside the 4000 skybox
    mk('content/sky/sun.jpg',        120, { additive:true });          // glow disc
    mk('content/sky/sun-rays.jpg',   300, { additive:true });          // ray star
    mk('content/sky/moon.jpg',       110, { moon:true, alphaMap:'content/sky/moon-alpha.jpg' });
    /* the shipped lensflare is a hard white disc; the radial mask and low
     * opacity keep it from reading as a sky outline (flare is APPROX) */
    mk('content/sky/lensflare.jpg',  220, { additive:true, op:0.07,
      alphaTexture:radialFadeTexture(0.30,0.50) });
    this.scene.add(this.celestial);
  }

  /* per-render: bodies ride the camera (sky-positioned) and billboard */
  billboardCelestial(camera){
    if (this.celestial) this.celestial.position.copy(camera.position);
    for (const q of (this.celestial? this.celestial.children : [])){
      q.quaternion.copy(camera.quaternion);
    }
  }

  /* ---------- helpers ---------- */
  _colKey(bc){ return ((bc.r*255)|0)+','+((bc.g*255)|0)+','+((bc.b*255)|0); }
  _brick(bc, transparent){
    const key='lam|'+this._colKey(bc)+'|'+(transparent||0);
    let m=this.materialCache.get(key);
    if (!m){
      m=new THREE.MeshLambertMaterial({ color:new THREE.Color(bc.r,bc.g,bc.b),
                                        side:THREE.DoubleSide });
      if (transparent){ m.transparent=true; m.opacity=1-transparent; }
      this.materialCache.set(key,m);
    }
    return m;
  }
  /* Single material for non-block shapes (HeadMesh/Sphere/Cylinder/Wedge/
   * FileMesh).  The block path goes through _buildMaterials because it needs
   * six face slots; these shapes have one slot but still honour the Part's
   * Transparency and Reflectance properties (they used to ignore both, so a
   * ghosted SpecialMesh stayed opaque). */
  _specialMaterial(bc, transparency, reflectance){
    const tr=Math.max(0, Math.min(1, transparency||0));
    const rf=Math.max(0, Math.min(1, reflectance||0));
    const key='sp|'+this._colKey(bc)+'|'+tr.toFixed(2)+'|'+rf.toFixed(2);
    let m=this.materialCache.get(key);
    if (!m){
      if (rf>0.001){
        m=new THREE.MeshPhongMaterial({ color:new THREE.Color(bc.r,bc.g,bc.b),
                                        specular:new THREE.Color(rf,rf,rf),
                                        envMap:this.skyCube||null, reflectivity:rf,
                                        shininess:70, side:THREE.DoubleSide });
      } else {
        m=new THREE.MeshLambertMaterial({ color:new THREE.Color(bc.r,bc.g,bc.b),
                                        side:THREE.DoubleSide });
      }
      if (tr>0.001){ m.transparent=true; m.opacity=1-tr; }
      this.materialCache.set(key,m);
    }
    return m;
  }
  /* NOTE: THREE box material order is [+x,-x,+y,-y,+z,-z]
   * Roblox: Right(0)->+x slot0, Top(1)->+y slot2, Back(2)->+z slot4,
   *         Left(3)->-x slot1, Bottom(4)->-y slot3, Front(5)->-z slot5
   * (Front face → LookVector = -column3 = -Z; verified vs identity CFrame) */
  faceSlot(face){ return ({0:0,1:2,2:4,3:1,4:3,5:5})[face]; }

  _buildMaterials(size, bc, transparency, part, partTop){
    /* all six faces carry their own Surface token (every place part ships
     * all 12 face properties  the parser takes the full set now).  The
     * ParamA/ParamB values belong to the surface-tool brush, not to the
     * part-face texture matrix: the decomp's face builders FUN_004d3bd0 /
     * FUN_004e06f0 derive the UVs from the face size and surface token and
     * never read ParamA/B.  Do not use them as a texture phase. */
    const faceKeys=['Right','Left','Top','Bottom','Front','Back'].map(k=>{
      const face=SURFACE_FACE[k];
      const i=this.faceSlot(face);
      return { slot:i,
               token:surfToken(part.props[k+'Surface'], SURFACE_DEFAULT[face]) };
    });
    const base=this._brick(bc);
    const reflectance=Math.max(0, Math.min(1, part.props.Reflectance||0));
    /* Only Studs(3) and Inlet(4) are face textures in the 2007 game
     * renderer.  Weld(2)/Glue(1) are joint types: the atlas X/blob is the
     * Surface Tool cursor in Studio, and the default noob's Weld torso
     * sides render as solid brick colour in-game (see the 2007 screenshots
     * in PORT.md).  Spawn/hinge/motor/stepping are plain too. */
    const artRow={3:0, 4:1};
    const anyArt=faceKeys.some(f=>artRow[f.token]!=null);
    const hasTexture = anyArt;
    const hasPhong = reflectance>0.001;
    const trans = transparency>0.001;
    if (!hasTexture && !trans && !hasPhong) return base;   // shared single material
    // build (and cache) a material array
    const key='box|'+this._colKey(bc)+'|'+size.x.toFixed(3)+','+size.y.toFixed(3)+','+size.z.toFixed(3)+
      '|'+faceKeys.map(f=>f.token).join('.')+
      '|'+(transparency||0).toFixed(2)+'|'+reflectance.toFixed(2);
    let entry=this.materialCache.get(key);
    if (!entry){
      /* per-face geometry dims for UV repeats: slot order [+x,-x,+y,-y,+z,-z]
       * through faceSlot: Right/Left faces span (z,y); Top/Bottom (x,z);
       * Front/Back (x,y) */
      const dims={0:[size.z,size.y], 1:[size.z,size.y], 2:[size.x,size.z],
                  3:[size.x,size.z], 4:[size.x,size.y], 5:[size.x,size.y]};
      const makeBase=()=>{
        if (!hasPhong) return base;
        const m=new THREE.MeshPhongMaterial({ color:new THREE.Color(bc.r,bc.g,bc.b),
                                              specular:new THREE.Color(reflectance,reflectance,reflectance),
                                              envMap:this.skyCube||null, reflectivity:reflectance,
                                              shininess:70, side:THREE.DoubleSide });
        if (trans){ m.transparent=true; m.opacity=1-transparency; }
        return m;
      };
      const mats=[];
      for (let i=0;i<6;i++) mats.push(makeBase());
      for (const f of faceKeys){
        const row=artRow[f.token];
        if (row==null) continue;
        const [du,dv]=dims[f.slot];
        const t=cloneTile(SURFACE_TILE[row]||STUD_TEX);
        /* One atlas tile covers a 2x2-stud patch.  A face of size N studs
         * therefore spans N/2 tile periods in that axis.  The tile's stud
         * centres sit at 0.25/0.75 of the tile, so starting at UV 0 puts the
         * first stud at 0.5 studs from the edge  the same grid as a 2x2,
         * 4x2 or 1x1 brick.  No ParamA/B phase shift (see the faceKeys
         * comment above): the decomp builders never consume it. */
        /* One 64px tile covers a 2x2-stud patch, so a face of N studs spans
         * N/2 tile periods.  Keep the fractional repeat: a 1-stud face
         * (character arms/legs, 1x1 bricks) must sample the central stud of
         * the tile, not a whole 2-stud patch squeezed onto one stud. */
        t.repeat.set(du*0.5, dv*0.5);
        t.offset.set(0, 0);
        let m;
        if (hasPhong){
          m=new THREE.MeshPhongMaterial({ color:new THREE.Color(bc.r,bc.g,bc.b),
            specular:new THREE.Color(reflectance,reflectance,reflectance),
            envMap:this.skyCube||null, reflectivity:reflectance,
            shininess:70, map:t, side:THREE.DoubleSide });
          if (trans){ m.transparent=true; m.opacity=1-transparency; }
        } else {
          m=new THREE.MeshLambertMaterial({ color:new THREE.Color(bc.r,bc.g,bc.b), map:t,
            side:THREE.DoubleSide });
        }
        mats[f.slot]=m;
      }
      if (trans){
        for (let i=0;i<6;i++){
          const c=mats[i].clone();
          c.transparent=true;
          c.opacity=(c.map? c.opacity*(1-transparency) : 1-transparency);
          mats[i]=c;
        }
      }
      entry={mats};
      this.materialCache.set(key,entry);
    }
    return entry.mats;
  }
  /* Character/rig parts use the same six-face surface material builder as
   * workspace parts.  The shipped character.rbxm carries Top=Studs(3) on
   * the torso/arms/legs and Bottom=Inlet(4) on the torso/arms, so the rig
   * gets its studs without hardcoding part names. */
  materialsForPart(part, size, rgb){
    const c=rgb||[0.64,0.64,0.64];
    const bc={ r:c[0], g:c[1], b:c[2] };
    return this._buildMaterials(size, bc, part&&part.props? (part.props.Transparency||0):0,
                                part, true);
  }

  /* Decals are a separate transparent plane laid ON the face, not a
   * replacement for the face material.  Replacing the brick material made
   * every alpha pixel of the PNG show the inside of the box (the
   * "see-through side" bug): the face simply stopped existing wherever the
   * decal was transparent.  The plane keeps the brick face intact and only
   * paints the decal's opaque pixels on top.
   *
   * Face frames: PlaneGeometry's normal is local +Z and its texture reads
   * un-mirrored from that side.  Rotations below put +Z on the Roblox face
   * normal; Front(-Z) uses y=PI so its text still reads correctly. */
  _attachFaceOverlay(obj, face, url, dims, alpha, inset, opts){
    if (!url || alpha<=0.001) return null;
    /* face -> plane width axis, height axis, outward normal, euler */
    const faces={
      0:{w:'z', h:'y', n:[ 1,0,0], r:[0, Math.PI/2,0]},   // Right  (+X)
      3:{w:'z', h:'y', n:[-1,0,0], r:[0,-Math.PI/2,0]},   // Left   (-X)
      1:{w:'x', h:'z', n:[0, 1,0], r:[-Math.PI/2,0,0]},   // Top    (+Y)
      4:{w:'x', h:'z', n:[0,-1,0], r:[ Math.PI/2,0,0]},   // Bottom (-Y)
      2:{w:'x', h:'y', n:[0,0, 1], r:[0,0,0]},            // Back   (+Z)
      5:{w:'x', h:'y', n:[0,0,-1], r:[0, Math.PI,0]},     // Front  (-Z)
    };
    const f=faces[face];
    if (!f) return null;
    const s=(inset==null)? 0.98 : inset;
    const w=dims[f.w], h=dims[f.h];
    const map=mkTex(url);
    if (opts&&opts.tileU>0&&opts.tileV>0){
      /* RBX::Texture: StudsPerTileU/V is the world studs covered by one
       * texture repeat; OffsetU/V shifts the tiling by studs.  The plane's
       * local U spans the face's first axis (w) and V the second (h). */
      map.wrapS=map.wrapT=THREE.RepeatWrapping;
      map.repeat.set(w/opts.tileU, h/opts.tileV);
      map.offset.set((opts.offsetU||0)/opts.tileU, (opts.offsetV||0)/opts.tileV);
      map.needsUpdate=true;
    }
    const m=new THREE.MeshLambertMaterial({
      map,
      transparent:true,
      opacity:alpha,
      depthWrite:false,
      polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2,
    });
    const plane=new THREE.Mesh(new THREE.PlaneGeometry(w*s, h*s), m);
    const off=0.006;
    plane.position.set(
      f.n[0]*(dims.x/2+off),
      f.n[1]*(dims.y/2+off),
      f.n[2]*(dims.z/2+off));
    plane.rotation.set(f.r[0], f.r[1], f.r[2]);
    plane.renderOrder=1;
    obj.add(plane);
    return plane;
  }

  _attachPartDecals(obj, part, size, transparency){
    const dims=obj.userData.meshDim || size;
    for (const d of part.children){
      /* Decal and Texture are the two face-image classes.  Texture repeats
       * its image across the face (StudsPerTileU/V + OffsetU/V); a Decal
       * stretches to the face once.  Both are overlays, never face swaps. */
      const isTexture=(d.cls==='Texture');
      if (d.cls!=='Decal' && !isTexture) continue;
      const content=d.props.Texture;
      if (!content || (!content.binary && !content.url)) continue;
      const face=(d.props.Face!=null)? d.props.Face : 0;
      const dt=Math.max(0, Math.min(1, d.props.Transparency||0));
      const alpha=(1-dt)*(1-transparency);
      const tu=Number(d.props.StudsPerTileU);
      const tv=Number(d.props.StudsPerTileV);
      const opts=isTexture? {
        tileU:(isFinite(tu)&&tu>0)? tu : 4,
        tileV:(isFinite(tv)&&tv>0)? tv : 4,
        offsetU:Number(d.props.OffsetU)||0,
        offsetV:Number(d.props.OffsetV)||0,
      } : null;
      this._attachFaceOverlay(obj, face, content.url||content.binary, dims, alpha,
                              isTexture? 1 : 0.98, opts);
    }
  }

  /* Hinge(6)/Motor(7)/SteppingMotor(8) faces show the classic yellow peg:
   * a cylinder whose axis is the face normal, centered on the face and
   * protruding outward.  The 2007 client drew this in the surface pass; the
   * decomp's RotateJoint code (FUN_005ea670) carries the joint but no
   * recoverable draw constants, so the proportions come from the shipped
   * HingeTool.png (yellow peg on a grey cube). */
  _hingeMat(){
    const key='hinge|yellow';
    let m=this.materialCache.get(key);
    if (!m){
      m=new THREE.MeshLambertMaterial({ color:new THREE.Color(0.96,0.80,0.19) });
      this.materialCache.set(key,m);
    }
    return m;
  }
  _hingePegGeo(r,len){
    const key='HG|'+r.toFixed(3)+'|'+len.toFixed(3);
    let g=this.geometryCache.get(key);
    if (!g){ g=new THREE.CylinderGeometry(r,r,len,16); this.geometryCache.set(key,g); }
    return g;
  }
  _attachHingeArt(obj, part, size, transparency){
    if (transparency>0.95) return;
    const dims=obj.userData.meshDim || size;
    const surf=part.props||{};
    const faces=[
      {k:'Right', n:[ 1,0,0], r:[0,0,-Math.PI/2], d:dims.x, w:dims.z, h:dims.y},
      {k:'Left',  n:[-1,0,0], r:[0,0, Math.PI/2], d:dims.x, w:dims.z, h:dims.y},
      {k:'Top',   n:[0, 1,0], r:[0,0,0],          d:dims.y, w:dims.x, h:dims.z},
      {k:'Bottom',n:[0,-1,0], r:[Math.PI,0,0],    d:dims.y, w:dims.x, h:dims.z},
      {k:'Back',  n:[0,0, 1], r:[ Math.PI/2,0,0], d:dims.z, w:dims.x, h:dims.y},
      {k:'Front', n:[0,0,-1], r:[-Math.PI/2,0,0], d:dims.z, w:dims.x, h:dims.y},
    ];
    for (const f of faces){
      const token=surfToken(surf[f.k+'Surface'], SURFACE_DEFAULT[SURFACE_FACE[f.k]]);
      if (token<6 || token>8) continue;
      const r=Math.max(0.08, Math.min(0.25, Math.min(f.w,f.h)*0.16));
      const len=Math.max(0.18, Math.min(0.6, r*2.6));
      const peg=new THREE.Mesh(this._hingePegGeo(r,len), this._hingeMat());
      peg.position.set(f.n[0]*(f.d/2+len/2), f.n[1]*(f.d/2+len/2), f.n[2]*(f.d/2+len/2));
      peg.rotation.set(f.r[0], f.r[1], f.r[2]);
      obj.add(peg);
    }
  }

  _geoBlock(size){
    const key='B|'+size.x+'|'+size.y+'|'+size.z;
    let g=this.geometryCache.get(key);
    if (!g){ g=new THREE.BoxGeometry(size.x,size.y,size.z); this.geometryCache.set(key,g); }
    return g;
  }
  _geoSphere(r){
    const key='S|'+r.toFixed(3);
    let g=this.geometryCache.get(key);
    if (!g){ g=sphereGeometry(r); this.geometryCache.set(key,g); }
    return g;
  }
  _geoBall(rx, ry, rz){
    const key='E|'+rx.toFixed(3)+'|'+ry.toFixed(3)+'|'+rz.toFixed(3);
    let g=this.geometryCache.get(key);
    if (!g){ g=ellipsoidGeometry(rx, ry, rz); this.geometryCache.set(key,g); }
    return g;
  }
  _geoCylX(ry, rz, len){
    const key='CX|'+ry.toFixed(3)+'|'+rz.toFixed(3)+'|'+len.toFixed(3);
    let g=this.geometryCache.get(key);
    if (!g){ g=cylinderAlongXGeometry(ry, rz, len); this.geometryCache.set(key,g); }
    return g;
  }

  /* BrickColor wins when serialized; older files carry only the deprecated
   * Color3 property, so derive the palette entry from it instead of falling
   * back to grey.  Every look owns its rgb copy: scripts mutate it. */
  _partPalette(part, fallbackEntry){
    let palEntry=null;
    if (part.props.BrickColor!=null)
      palEntry=window.BrickColorFromId(part.props.BrickColor|0);
    const col=part.props.Color;
    if (!palEntry && col && typeof col==='object' && isFinite(col.r)){
      const rgb=[Math.round(col.r*255), Math.round(col.g*255), Math.round(col.b*255)];
      const near=window.BrickColorNearest? window.BrickColorNearest(rgb[0],rgb[1],rgb[2]) : null;
      palEntry={ id:near? near.id : 2, name:near? near.name : 'Medium stone grey', rgb };
    }
    if (!palEntry) palEntry=fallbackEntry||{ id:2, name:'Medium stone grey', rgb:[163,162,164] };
    const bc={ r:palEntry.rgb[0]/255, g:palEntry.rgb[1]/255, b:palEntry.rgb[2]/255 };
    const entry={ id:palEntry.id, name:palEntry.name, rgb:palEntry.rgb.slice() };
    return { bc, entry };
  }

  /* ---------- one Part (or SpawnLocation) ---------- */
  buildPart(part){
    const size=part.props.size || {x:4,y:1.2,z:2};
    const shape=('shape' in part.props)? part.props.shape : 1;
    const cf=part.props.CFrame || {pos:{x:0,y:8,z:0}, rot:[1,0,0, 0,1,0, 0,0,1]};
    const pal=this._partPalette(part, null);
    const bc=pal.bc, entry=pal.entry;
    const transparency=Math.max(0, Math.min(1, part.props.Transparency||0));
    const look={ part, size, shape, cf, entry, destroyed:false, anchored:part.props.Anchored!==false,
                 canCollide: part.props.CanCollide!==false,
                 friction: part.props.Friction, elasticity: part.props.Elasticity,
                 velocity: part.props.Velocity||null, rotVelocity: part.props.RotVelocity||null,
                 reflectance: part.props.Reflectance, cullable: part.props.Cullable!==false,
                 castsShadows: part.props.CastsShadows!==false,
                 locked: part.props.Locked===true,
                 draggingV1: part.props.DraggingV1===true,
                 formFactor: (part.props.FormFactor!=null? part.props.FormFactor
                              : (part.props.formFactorRaw!=null? part.props.formFactorRaw : 1)),
                 controller: part.props.Controller||0,
                 controllerFlagShown: part.props.ControllerFlagShown!==false,
                 archivable: part.props.archivable!==false };
    /* Classic auto-join needs each face's SurfaceType in NormalId order
     * [Right 0, Top 1, Back 2, Left 3, Bottom 4, Front 5]. Missing props on
     * runtime-built parts fall back to the ctor defaults. */
    look.surf=SURFACE_FACE_KEYS.map((k,i)=>
      surfToken(part.props[k+'Surface'], SURFACE_DEFAULT[i]));

    const obj=this._buildPartObject(part, size, shape, cf, bc, transparency, entry, true);
    this.scene.add(obj);
    look.obj=obj;
    const R=cf.rot, P=cf.pos;
    /* Geometry AABB for every part, colliding or not.  The assembly/joint
     * graph needs non-colliding parts too (JetPack P1/P2/P8/P9 are welded
     * decoration that must travel with P3); only `colliders` is used for
     * collision response. */
    {
      let hx=size.x/2, hy=size.y/2, hz=size.z/2;
      // enclosing AABB under rotation (norms of rows/cols)
      const ex=Math.abs(R[0])*hx+Math.abs(R[1])*hy+Math.abs(R[2])*hz;
      const ey=Math.abs(R[3])*hx+Math.abs(R[4])*hy+Math.abs(R[5])*hz;
      const ez=Math.abs(R[6])*hx+Math.abs(R[7])*hy+Math.abs(R[8])*hz;
      look.aabb={ min:{x:P.x-ex, y:P.y-ey, z:P.z-ez},
                  max:{x:P.x+ex, y:P.y+ey, z:P.z+ez} };
      if (look.canCollide) this.colliders.push(look);
    }
    this.partLook.set(part, look);
    if (part.cls==='SpawnLocation') this.spawnPoints.push(look);
    /* climbable geometry  TrussPart class, or a brick part inside a Model
     * named "Ladder" (Crossroads' shipped ladders). The enclosing box is
     * kept even for non-colliding parts so the volume is complete. */
    const cg=this._climbGroup(part);
    if (cg){
      look.climb=true; look.climbGroup=cg;
      let hx=size.x/2, hy=size.y/2, hz=size.z/2;
      const ex=Math.abs(R[0])*hx+Math.abs(R[1])*hy+Math.abs(R[2])*hz;
      const ey=Math.abs(R[3])*hx+Math.abs(R[4])*hy+Math.abs(R[5])*hz;
      const ez=Math.abs(R[6])*hx+Math.abs(R[7])*hy+Math.abs(R[8])*hz;
      look.volAABB={ min:{x:P.x-ex, y:P.y-ey, z:P.z-ez},
                     max:{x:P.x+ex, y:P.y+ey, z:P.z+ez} };
      this._climbLooks.push(look);
      this._climbDirty=true;
    }
    /* runtime-built parts start in their own assembly; the next ClumpStage
     * re-evaluates surface joints against neighbours (AutoJoin on contact) */
    if (window.RBLXdyn&&window.RBLXdyn._ready) window.RBLXdyn.attach(look);
    /* Only a part that can actually enter the merged static batch changes
     * the batch.  Runtime projectiles/debris are free bodies: marking the
     * batch dirty for them forced a full 2k-part re-merge on every rocket
     * shot (a visible stall when firing). */
    if (this._batchable(look)) this.markStaticDirty();
    return look;
  }

  /* nearest ancestor (or the part itself) named "Ladder", or a TrussPart */
  _climbGroup(part){
    if (!part) return null;
    if (part.cls==='TrussPart') return part;
    let it=part, n=0;
    while (it && n++<10){
      const nm=(it.props && it.props.Name)||'';
      if (/ladder/i.test(nm)) return it;
      it=it.parent;
    }
    return null;
  }

  /* union each ladder model's part boxes into one climb volume  the shipped
   * Crossroads ladder is rails + five separate rungs with 2-stud gaps, so a
   * per-part volume would drop the climber between rungs */
  _rebuildClimbVolumes(){
    const groups=new Map();
    const live=[];
    for (const look of this._climbLooks){
      if (!look || look.destroyed || !look.volAABB) continue;
      live.push(look);
      const g=look.climbGroup||look;
      let v=groups.get(g);
      if (!v){
        v={ min:{x: 1e9, y: 1e9, z: 1e9}, max:{x:-1e9, y:-1e9, z:-1e9}, parts:[] };
        groups.set(g, v);
      }
      const a=look.volAABB;
      v.min.x=Math.min(v.min.x,a.min.x); v.max.x=Math.max(v.max.x,a.max.x);
      v.min.y=Math.min(v.min.y,a.min.y); v.max.y=Math.max(v.max.y,a.max.y);
      v.min.z=Math.min(v.min.z,a.min.z); v.max.z=Math.max(v.max.z,a.max.z);
      v.parts.push(look);
    }
    this._climbLooks=live;   // drop destroyed/restored records (restorePart re-adds)
    this.climbVolumes=Array.from(groups.values());
    this._climbDirty=false;
  }

  /* Build just the render object for a part. Kept separate from buildPart so
   * runtime Surface/Param writes can replace the mesh without disturbing the
   * look record, collider, assembly or physics state. */
  _buildPartObject(part, size, shape, cf, bc, transparency, entry, withSpawnDecal){
    const sm=part.children.find(c=>c.cls==='SpecialMesh');
    let obj=null;
    if (sm){
      obj=this._buildSpecial(sm, part, size, bc, transparency, shape, cf, entry);
      if (!obj) sm=null;   // fell through: render plain block
    }
    if (!obj){
      if (shape===0){
        // RBX::View::SphereMesh: per-extent fit  an ellipsoid with radii half size
        obj=new THREE.Mesh(this._geoBall(size.x/2, size.y/2, size.z/2),
                           this._brick(bc, transparency>0.001 ? transparency : 0));
      } else if (shape===2){
        // RBX::View::CylinderAlongXMesh: axis along the part's local X; the
        // cross-section uses size.y/z (radius others assert "min/2, Y axis"
        // that guess made rotated supports lie on their side)
        obj=new THREE.Mesh(this._geoCylX(size.y/2, size.z/2, size.x),
                           this._brick(bc, transparency>0.001 ? transparency : 0));
      } else {
        const mats=this._buildMaterials(size, bc, transparency, part, true);
        obj=new THREE.Mesh(this._geoBlock(size), mats);
      }
    }
    // apply CFrame: three.Matrix4.set() is row-major like the Roblox XML comps
    // (element (0,0)=R00 ... ; three column0 becomes (R00,R10,R20) = RightVector)
    const R=cf.rot, P=cf.pos;
    const m4=new THREE.Matrix4().set(
      R[0], R[1], R[2], P.x,
      R[3], R[4], R[5], P.y,
      R[6], R[7], R[8], P.z,
      0,0,0,1);
    obj.matrixAutoUpdate=true;
    obj.applyMatrix4(m4);
    obj.visible = transparency<0.999;
    /* CastsShadows/Cullable are Part render flags in the 2007 client.
     * Three's equivalents are per-object flags, so a scripted write can
     * toggle them without rebuilding geometry. */
    obj.castShadow = part.props.CastsShadows!==false;
    obj.frustumCulled = part.props.Cullable!==false;
    /* decal overlays sit on the finished face (block/special-mesh parts
     * have flat faces; balls/cylinders have no face to lay a plane on) */
    if (part.children && (shape===1 || sm))
      this._attachPartDecals(obj, part, size, transparency);
    this._attachHingeArt(obj, part, size, transparency);
    /* SpawnLocation's class texture is an overlay on the top face, not a
     * replacement for it.  SpawnLocation.png is mostly transparent (the
     * spiky wheel); swapping the top face material for it left the pad's
     * top see-through wherever the wheel was transparent.  The shipped
     * places already carry the equivalent child Decal (handled above), so
     * only add the class-texture plane when it is missing. */
    if (withSpawnDecal!==false && part.cls==='SpawnLocation' && !sm && shape===1){
      const hasTopDecal=(part.children||[]).some(c=>
        c.cls==='Decal' && (c.props.Face==null || c.props.Face===1));
      if (!hasTopDecal)
        this._attachFaceOverlay(obj, 1, 'content/textures/SpawnLocation.png',
                                obj.userData.meshDim||size, 1-transparency, 1);
    }
    return obj;
  }

  /* Rebuild a built part's art in place after Surface/ParamA/ParamB writes.
   * The Surface property setter also refreshes look.surf and marks dynamics
   * dirty, so the next ClumpStage re-evaluates the joint graph. */
  refreshPartArt(inst){
    const look=this.partLook.get(inst);
    if (!look||look.destroyed) return null;
    const part=inst;
    const size=look.size||part.props.size||{x:4,y:1.2,z:2};
    const shape=look.shape!=null? look.shape : (('shape' in part.props)? part.props.shape : 1);
    const cf=look.cf||part.props.CFrame||{pos:{x:0,y:8,z:0}, rot:[1,0,0, 0,1,0, 0,0,1]};
    const pal=this._partPalette(part, look.entry);
    const bc=pal.bc, entry=pal.entry;
    const transparency=Math.max(0, Math.min(1, part.props.Transparency||0));
    const obj=this._buildPartObject(part, size, shape, cf, bc, transparency, entry, true);
    if (look.obj&&look.obj.parent) look.obj.parent.remove(look.obj);
    this.scene.add(obj);
    look.obj=obj;
    look.entry=entry;
    look.surf=SURFACE_FACE_KEYS.map((k,i)=>
      surfToken(part.props[k+'Surface'], SURFACE_DEFAULT[i]));
    delete look.__faces;
    this.markStaticDirty();
    return obj;
  }

  _buildSpecial(sm, part, size, bc, transparency, shape, cf, entry){
    const mt=(sm.props.MeshType!=null)? sm.props.MeshType : 0;
    const scl=sm.props.Scale || {x:1,y:1,z:1};
    const mat=this._specialMaterial(bc, transparency, part.props.Reflectance);
    let obj=null;
    if (mt===0){
      // decomp: HeadMesh is generated in-code (MeshFactory<HeadMesh,1> at
      // Roblox.exe.c:202637/201468; HeadBuilder ctor at FUN_004df000)
      // no mesh file is loaded for built-in heads
      const real=builtHeadGeometry(size, scl);
      if (real){
        obj=new THREE.Mesh(real.geo, mat);
        obj.userData.meshDim=real.dim;
      } else {
        // only reached if js/headmesh.js failed to load; the real module is
        // loaded before world.js in index.html and the tests.
        obj=new THREE.Mesh(headGeometry(size, scl), mat);
        obj.userData.meshDim={ x:size.x*scl.x, y:size.y*scl.y, z:size.z*scl.z };
      }
    } else if (mt===2){
      obj=new THREE.Mesh(wedgeGeometry(size, scl), mat);
    } else if (mt===3){
      // SphereMesh: per-extent ellipsoid × SpecialMesh.Scale
      obj=new THREE.Mesh(this._geoBall(size.x/2*scl.x, size.y/2*scl.y, size.z/2*scl.z), mat);
    } else if (mt===4){
      // CylinderAlongXMesh: length along local X × scale, elliptical cross-section
      obj=new THREE.Mesh(this._geoCylX(size.y/2*scl.y, size.z/2*scl.z, size.x*scl.x), mat);
    } else if (mt===5 && sm.props.MeshId && (sm.props.MeshId.url||sm.props.MeshId.binary)){
      // FileMesh: the old text mesh format.  The mesh can be shipped
      // (fonts/<name>.mesh), or embedded in the place as a Content binary
      // data URL (possibly reached through a <hash> reference).
      const mid=sm.props.MeshId;
      const inline=(mid.binary && /^data:/i.test(mid.binary))? mid.binary
                 : ((mid.url && /^data:/i.test(mid.url))? mid.url : null);
      const sclY=(size.y||1)*scl.y;
      let geo=null, file=null, key=null;
      if (inline){
        const txt=window.RBLXxml&&window.RBLXxml.dataUrlText
          ? window.RBLXxml.dataUrlText(inline) : null;
        if (txt){
          const ck='inline|'+txt.length+'|'+txt.slice(0,40);
          key='inline|'+ck+'|'+sclY.toFixed(4);
          geo=this.geometryCache.get(key);
          if (!geo){ geo=meshGeoFromText(txt, sclY, ck); if (geo) this.geometryCache.set(key,geo); }
        }
      } else {
        const url=mid.url||mid.binary;
        file=String(url).replace(/\\/g,'/').split('/').pop().toLowerCase();
        key='file|'+file+'|'+sclY.toFixed(4);
        geo=this.geometryCache.get(key);
        if (!geo){
          geo=fileMeshGeo('fonts/'+file, sclY)||fileMeshGeo(file, sclY);
          if (geo) this.geometryCache.set(key,geo);
        }
      }
      if (geo){
        obj=new THREE.Mesh(geo, mat);
        obj.userData.meshDim={ x:(size.x||1)*scl.x, y:sclY, z:(size.z||1)*scl.z };
      } else {
        console.warn('[world] FileMesh not embedded, block fallback for', file||'inline mesh');
      }
    }
    if (!obj && (mt===1 || mt===6)){
      obj=new THREE.Mesh(this._geoBlock({x:size.x*scl.x, y:size.y*scl.y, z:size.z*scl.z}), mat);
    }
    /* SpecialMesh.TextureId paints the mesh's own UVs (the file meshes carry
     * valid UVs; primitive mesh types use the generated geometry's UVs).
     * A mesh without a texture keeps the brick-colour material. */
    if (obj && sm.props.TextureId){
      const tid=sm.props.TextureId;
      const url=(typeof tid==='string')? tid : (tid.url||tid.binary);
      if (url){
        const mm=mat.clone();
        mm.map=mkTex(url);
        mm.needsUpdate=true;
        obj.material=mm;
      }
    }
    return obj;
  }

  /* ---------- queries used by tools/physics/scripts ---------- */
  /* tallest collider top under (x,z) within radius r  used by the spawn
   * fallback (maps without SpawnLocation: the engine spawns at the camera /
   * origin; we match by standing on the highest ground near origin) */
  tallestGroundAt(x, z, r){
    let best=null;
    for (const c of this.colliders){
      if (c.destroyed) continue;
      if (x < c.aabb.min.x-r || x > c.aabb.max.x+r) continue;
      if (z < c.aabb.min.z-r || z > c.aabb.max.z+r) continue;
      if (!best || c.aabb.max.y > best.y) best={ y:c.aabb.max.y };
    }
    return best;
  }
  rayFromCamera(px, py){
    // NDC unproject (three.js): construct ray through pixel
    const cam=this._camera||window.__camera;
    if (!cam) return { origin:new THREE.Vector3(0,0,0), dir:new THREE.Vector3(0,0,-1) };
    this._camera=cam;
    /* tools.update runs in step() BEFORE render() refreshes the camera
     * pose  unproject reads cam.matrixWorld, which was one frame stale
     * (fast camera turns made clicks land where the camera WAS).  Refresh
     * the world matrix here so the aim ray is always this frame's view. */
    if (cam.parent) cam.parent.updateMatrixWorld(true);
    else cam.updateMatrixWorld();
    const w=window.innerWidth||1, h=window.innerHeight||1;
    const x=((px||0)/w)*2-1, y=1-((py||0)/h)*2;
    const v=new THREE.Vector3(x, y, 0.5).unproject(cam);
    v.sub(cam.position).normalize();
    return { origin:cam.position.clone(), dir:v };
  }
  setCamera(cam){ this._camera=cam; }

  rayHit(origin, dir, maxDist, exclude){
    maxDist=maxDist||300;
    let best=null;
    /* traverse the dynamics spatial hash instead of every collider; the
     * hash indexes all world looks with exact AABBs (fallback: full list) */
    const D=window.RBLXdyn;
    const src=(D&&D._ready&&D.rayCandidates)? D.rayCandidates(origin,dir,maxDist) : this.colliders;
    for (const o of src){
      if (o.destroyed || !o.aabb || o.canCollide===false) continue;
      if (exclude && (exclude.has(o)||exclude.has(o.part))) continue;
      /* enclosing-AABB broadphase, then the part's REAL oriented box
       * rotated walls have fat AABBs and the old broadphase-only test
       * destroyed/moved/aimed at bricks the cursor was well beside (the
       * "hammer is inaccurate" bug) */
      if (this._rayAABB(origin, dir, o.aabb, maxDist)==null) continue;
      const hit=this._rayOBB(origin, dir, o, maxDist);
      if (hit!=null && (!best || hit<best.distance)){
        best={ look:o, distance:hit,
               hit:new THREE.Vector3(origin.x+dir.x*hit, origin.y+dir.y*hit, origin.z+dir.z*hit) };
      }
    }
    return best;
  }
  /* exact ray vs the part's oriented size-box (rigid transform to local
   * space, slab test; rigid rotations preserve ray parameter scale) */
  _rayOBB(o, d, look, maxDist){
    const cf=look.cf;
    if (!cf||!look.size) return null;
    const R=cf.rot, P=cf.pos;
    const ox=o.x-P.x, oy=o.y-P.y, oz=o.z-P.z;
    /* local ray = Rᵀ·(world), R row-major → Rᵀ rows are R's columns */
    const lx=[R[0]*ox+R[3]*oy+R[6]*oz, R[1]*ox+R[4]*oy+R[7]*oz, R[2]*ox+R[5]*oy+R[8]*oz];
    const ld=[R[0]*d.x+R[3]*d.y+R[6]*d.z, R[1]*d.x+R[4]*d.y+R[7]*d.z, R[2]*d.x+R[5]*d.y+R[8]*d.z];
    const h=[look.size.x/2, look.size.y/2, look.size.z/2];
    let tmin=0, tmax=Infinity;
    for (let i=0;i<3;i++){
      if (Math.abs(ld[i])<1e-9){
        if (Math.abs(lx[i])>h[i]) return null;
      } else {
        let t1=(-h[i]-lx[i])/ld[i], t2=(h[i]-lx[i])/ld[i];
        if (t1>t2){ const t=t1; t1=t2; t2=t; }
        tmin=Math.max(tmin,t1); tmax=Math.min(tmax,t2);
        if (tmin>tmax) return null;
      }
    }
    return (tmin<=maxDist && tmax>=0)? tmin : null;
  }
  _rayAABB(o, d, bb, maxDist){
    let tmin=0, tmax=Infinity;
    const oo=[o.x,o.y,o.z], dd=[d.x,d.y,d.z];
    const mns=[bb.min.x,bb.min.y,bb.min.z], mxs=[bb.max.x,bb.max.y,bb.max.z];
    for (let i=0;i<3;i++){
      if (Math.abs(dd[i])<1e-9){ if (oo[i]<mns[i]||oo[i]>mxs[i]) return null; }
      else {
        let t1=(mns[i]-oo[i])/dd[i], t2=(mxs[i]-oo[i])/dd[i];
        if (t1>t2){ const t=t1; t1=t2; t2=t; }
        tmin=Math.max(tmin,t1); tmax=Math.min(tmax,t2);
        if (tmin>tmax) return null;
      }
    }
    return (tmin<=maxDist && tmax>=0)? tmin : null;
  }
  raycastBoxes(pos, opt){
    // "is pos inside any solid part, expanded by radius" (rocket/pellet touch probe)
    const r=(opt&&opt.radius)||0;
    const D=window.RBLXdyn;
    let src=this.colliders;
    if (D&&D._ready&&D._neighbors){
      src=D._neighbors({ min:{x:pos.x-r,y:pos.y-r,z:pos.z-r},
                         max:{x:pos.x+r,y:pos.y+r,z:pos.z+r} });
    }
    for (const o of src){
      if (o.destroyed || !o.aabb || o.canCollide===false) continue;
      const a=o.aabb;
      if (pos.x>=a.min.x-r && pos.x<=a.max.x+r &&
          pos.y>=a.min.y-r && pos.y<=a.max.y+r &&
          pos.z>=a.min.z-r && pos.z<=a.max.z+r) return o;
    }
    return null;
  }
  pickPart(px, py){
    const r=this.rayFromCamera(px,py);
    return this.rayHit(r.origin, r.dir, 800);
  }
  pickPartRaw(ray){
    return this.rayHit(ray.origin, ray.dir, 800);
  }
  /* Which face of `look` did a world-space point hit?  GameTool uses this
   * for its drag plane and surface snapping.  NormalId order matches the
   * engine: Right(+X) 0, Top(+Y) 1, Back(+Z) 2, Left(-X) 3, Bottom(-Y) 4,
   * Front(-Z) 5.  Returns the face centre, outward normal and half extent. */
  partFaceAt(look, point){
    if (!look||!look.cf||!look.size) return null;
    const R=look.cf.rot, P=look.cf.pos;
    const dx=point.x-P.x, dy=point.y-P.y, dz=point.z-P.z;
    const l=[R[0]*dx+R[3]*dy+R[6]*dz,
             R[1]*dx+R[4]*dy+R[7]*dz,
             R[2]*dx+R[5]*dy+R[8]*dz];
    const h=[look.size.x/2, look.size.y/2, look.size.z/2];
    let axis=0, best=-Infinity;
    for (let i=0;i<3;i++){
      const v=Math.abs(l[i])/Math.max(h[i],1e-6);
      if (v>best){ best=v; axis=i; }
    }
    const sign=(l[axis]>=0)? 1 : -1;
    const hn=h[axis]*sign;
    const center={ x:P.x+R[axis]*hn, y:P.y+R[3+axis]*hn, z:P.z+R[6+axis]*hn };
    const normal={ x:R[axis]*sign, y:R[3+axis]*sign, z:R[6+axis]*sign };
    const face=(axis===0? (sign>0?0:3) : axis===1? (sign>0?1:4) : (sign>0?2:5));
    return { face, axis, sign, half:h[axis], center, normal };
  }
  humanoidWithin(pos, radius){
    const out=[];
    if (this.character && this.character.alive){
      const P=this.character.group.position;
      const dx=Math.abs(P.x-pos.x), dy=Math.abs(P.y-pos.y), dz=Math.abs(P.z-pos.z);
      if (dx<radius+1 && dy<radius+2.5 && dz<radius+1){
        out.push({ hurt:(d)=>this.character.takeDamage(d) });
      }
    }
    return out;
  }
  /* Engine Explosion blast (FUN_00604250/00604150/006029c0):
   *  - query parts in the cube pos±radius
   *  - keep parts whose bounding radius is < 2*radius
   *  - fire Explosion.Hit(part, distance) for every hit part
   *  - apply the radial pressure impulse to unanchored bodies
   * The 2007 Explosion does NOT directly destroy parts or damage Health;
   * destruction is a script consequence (e.g. the rocket removes its shaft).
   * `onHit(partInst, distance)` lets rbxenv fire the Lua Hit signal. */
  explodeAt(pos, radius, pressure, explosionInst, onHit){
    radius=Number(radius)||0;
    pressure=(pressure==null)? 500000 : (Number(pressure)||0);
    if (!(radius>0)) return;
    const p={x:pos.x||0, y:pos.y||0, z:pos.z||0};
    const seen=new Set();
    const blastLooks=[];
    const hitPart=(o,dist)=>{
      if (onHit){
        try { onHit(o.part, dist); } catch(_){}
      }
      if (o.destroyed) return;
      if (window.RBLXdyn && (window.RBLXdyn.blastParts||window.RBLXdyn.blastPart)){
        const asm=window.RBLXdyn.asmMap && window.RBLXdyn.asmMap.get(o);
        if (asm){
          /* Queue every hit before cutting: dynamics performs one shared
           * re-cluster for the whole explosion, not one per wall brick. */
          if (window.RBLXdyn.blastParts) blastLooks.push(o);
          else window.RBLXdyn.blastPart(o, p, radius, pressure, seen);
          return;
        }
      }
      if (o.anchored) return;
      /* no dynamics module (tests/dev): apply a capped velocity impulse */
      if (!o.velocity) o.velocity={x:0,y:0,z:0};
      const s=o.size||{x:1,y:1,z:1};
      const br=0.5*Math.hypot(s.x,s.y,s.z);
      const mass=Math.max(0.5, s.x*s.y*s.z*0.7);
      const dv=Math.min(80, pressure>0? pressure*br*br/(mass*20000) : 0);
      let dx=(o.aabb.min.x+o.aabb.max.x)/2-p.x;
      let dy=(o.aabb.min.y+o.aabb.max.y)/2-p.y;
      let dz=(o.aabb.min.z+o.aabb.max.z)/2-p.z;
      const d=Math.hypot(dx,dy,dz)||1;
      o.velocity.x+=dx/d*dv; o.velocity.y+=dy/d*dv; o.velocity.z+=dz/d*dv;
    };
    for (const o of this.colliders.slice()){
      if (o.destroyed || !o.aabb) continue;
      const a=o.aabb;
      if (a.max.x<p.x-radius || a.min.x>p.x+radius ||
          a.max.y<p.y-radius || a.min.y>p.y+radius ||
          a.max.z<p.z-radius || a.min.z>p.z+radius) continue;
      const s=o.size||{x:1,y:1,z:1};
      const br=0.5*Math.hypot(s.x,s.y,s.z);
      if (!(br<radius*2)) continue;
      const cx=(a.min.x+a.max.x)/2, cy=(a.min.y+a.max.y)/2, cz=(a.min.z+a.max.z)/2;
      hitPart(o, Math.hypot(cx-p.x,cy-p.y,cz-p.z));
    }
    if (blastLooks.length)
      window.RBLXdyn.blastParts(blastLooks, p, radius, pressure, seen);
    /* the humanoid torso is a body too; the decomp applies the impulse to
     * the part body (there is no direct Health write in the blast path) */
    const ch=this.character;
    if (ch && ch.alive && ch.group && ch.velocity){
      const P=ch.group.position;
      let dx=P.x-p.x, dy=P.y-p.y, dz=P.z-p.z;
      const d=Math.hypot(dx,dy,dz);
      /* classic explosion damage: linear falloff to 0 at BlastRadius */
      if (radius>0 && d<radius && typeof ch.takeDamage==='function'){
        const dmg=BLAST_DAMAGE*(1-d/radius);
        if (dmg>0) ch.takeDamage(dmg);
      }
      if (d<radius*2){
        if (d<1e-4){ dx=0; dy=1; dz=0; }
        const n=Math.hypot(dx,dy,dz)||1;
        const mass=10;                         /* classic torso mass (approx) */
        const dv=Math.min(80, pressure>0? pressure*6.25/(mass*20000) : 0);
        ch.velocity.x+=dx/n*dv;
        ch.velocity.y+=dy/n*dv;
        ch.velocity.z+=dz/n*dv;
        if (ch.onGround) ch.onGround=false;
      }
    }
  }
  destroyPart(inst){
    const look=this.partLook.get(inst);
    if (!look || look.destroyed) return;
    look.destroyed=true;
    if (look.climb) this._climbDirty=true;      /* drop its climb volume */
    if (window.RBLXdyn) window.RBLXdyn.detach(look);   /* weld breaks through the hole */
    if (look.obj){
      look.obj.visible=false;
      if (look.obj.parent) look.obj.parent.remove(look.obj);
    }
    const i=this.colliders.indexOf(look);
    if (i>=0) this.colliders.splice(i,1);
    /* only a part that was merged into the static batch requires the batch
     * to be rebuilt when it disappears (projectiles are never batched) */
    if (look.__batched) this.markStaticDirty();
  }
  restorePart(inst){
    const newLook=this.buildPart(inst);       // fresh mesh/collider
    this.partLook.set(inst, newLook);
    return newLook;
  }
  findModelByName(name){
    const list=this.byName.get(String(name).toLowerCase())||[];
    for (const inst of list){
      if (this.destroyed.has(inst)) continue;
      return inst;
    }
    return null;
  }
  modelRoots(){ return []; }  // unused helper kept out of the regen port
  snapshotModel(inst){
    // regen script backup: list insts of the subtree to rebuild later
    const snap=[inst];
    const collect=(n)=>{ for (const c of n.children){ snap.push(c); collect(c); } };
    collect(inst);
    return { inst, insts:snap.slice() };
  }
  removeModel(inst){
    const snap=this.snapshotModel(inst);
    // hide & unregister each part
    let n=0;
    for (const it of snap.insts){
      this.destroyed.add(it);
      if (it.cls==='Part'||it.cls==='SpawnLocation'||it.cls==='TrussPart'){
        this.destroyPart(it); n++;
      }
    }
    return { snap, removed:n };
  }
  restoreModel(snap){
    for (const it of snap.insts) this.destroyed.delete(it);
    let n=0;
    for (const it of snap.insts){
      if (it.cls==='Part'||it.cls==='SpawnLocation'||it.cls==='TrussPart'){
        // was destroyed in removeModel: rebuild fresh mesh + collider
        const old=this.partLook.get(it);
        if (old && old.destroyed){
          if (old.obj && old.obj.parent) old.obj.parent.remove(old.obj);
          this.partLook.delete(it);
          const i=this.colliders.indexOf(old);
          if (i>=0) this.colliders.splice(i,1);
          /* drop the destroyed look out of the assembly world too */
          if (window.RBLXdyn) window.RBLXdyn.detach(old);
        }
        this.restorePart(it); n++;
      }
    }
    return n;
  }
  moveGrab(target){/* studio grab (used by tools.js) */}

  /* "AndYetItMoves" day-cycle port: Lighting:SetMinutesAfterMidnight()
   * modulated ambient sun tint over a 1440-minute loop, and the celestial
   * bodies + lights ride the same hours (classic sun/moon sweep) */
  applyTimeOfDay(minutes){
    if (!this._hemi) return;
    const f=(Math.sin((minutes/1440)*Math.PI*2 - Math.PI*0.5)+1)/2;   // 0..1
    const day=new THREE.Color(0xffffff), night=new THREE.Color(0x4a5a7a);
    this._hemi.color.copy(night).lerp(day, 0.25+0.75*f);
    this._hemi.intensity=(0.85+0.45*f)*0.95;
    this.setCelestialTime(minutes/60);
  }

  /* ---------- run the whole file ---------- */
  build(parsed){
    const D=window.RBLXxml;
    this._parsed=parsed;
    this.decalCount=0;
    this.jointRecs=new Map();
    for (const inst of parsed.instances){
      this.allInsts.push(inst);
      if ((inst.cls==='Decal'||inst.cls==='Texture') && inst.props.Texture &&
          (inst.props.Texture.url||inst.props.Texture.binary)) this.decalCount++;
      const n=(inst.props.Name||'').toLowerCase();
      if (n){ let a=this.byName.get(n); if (!a){ a=[]; this.byName.set(n,a); } a.push(inst); }
    }
    let workspace=null, lighting=null;
    for (const i of parsed.instances){
      if (i.cls==='Workspace') workspace=i;
      else if (i.cls==='Lighting') lighting=i;
    }
    if (!workspace) throw new Error('place has no Workspace');
    this.applyLighting(lighting);
    // every place renders the client's default plainsky cube unless a Sky
    // object overrides faces (G3D::Sky param_4 constructor path)
    this.applySky(lighting? lighting.children.find(c=>c.cls==='Sky') : null);
    // build all parts (walk everything; models nest parts)
    // 2007 semantics: the client replicated StarterPack contents into the
    // Backpack on join, so HopperBins/Tools are collected from the WHOLE
    // tree (they sit under StarterPack, not Workspace, in the bundled places).
    let count=0;
    for (const inst of window.RBLXxml.descendants(workspace)){
      if (inst.cls==='Part' || inst.cls==='SpawnLocation' || inst.cls==='TrussPart'){
        this.buildPart(inst); count++;
      }
    }
    this._rebuildClimbVolumes();   // ladder models → one climb volume each
    this._buildControllerFlags(parsed);
    for (const inst of parsed.instances){
      if (inst.cls==='HopperBin'){ this.hoppers.push(inst); this.inventory.push(inst); }
      else if (inst.cls==='Tool'){ this.tools.push(inst); this.inventory.push(inst); }
    }
    /* GL_LIGHT_MODEL_TWO_SIDE applies to every brick, including materials
     * created after applyLighting ran; the batch materials are built with
     * DoubleSide directly in _rebuildStaticBatch. */
    this._twoSidedBricks();
    /* one batch build after the load-time pass (dynamics may not have been
     * ready while individual parts were built, so welded-immobile parts
     * could not mark themselves batchable yet) */
    this.markStaticDirty();
    return { parts:count };
  }
  update(input, camera){ this.setCamera(camera); }
}

window.RBLXworld = { WorldBuilder, buildWorld, headGeometry, wedgeGeometry, mkTex,
                     STUD_TEX, INLET_TEX, GLUE_TEX, buildToolModel, builtHeadGeometry,
                     TOOL_HAND_ROT, TOOL_MESH_STUDS_PER_UNIT, toolMeshGeo,
                     SURFACE_NAMES, SURFACE_DEFAULT, SURFACE_FACE, surfToken };

/* Built-in HeadMesh (place SpecialMesh MeshType=0 and the character head).
 * The engine never loads a file for heads: RBX::View::HeadMesh is generated
 * in code.  js/headmesh.js contains the exact vertices/normals/quads
 * captured by emulating FUN_004e1bb0 / FUN_004df000 / FUN_004e26e0 /
 * FUN_004e8d30 / FUN_004e2860 in client/Roblox.exe (see that file for the
 * addresses and the size rules).  This wrapper only applies the part size
 * and SpecialMesh.Scale.
 * Returns { geo, dim } where dim = rendered bounding box for decals. */
function builtHeadGeometry(size, scl){
  if (window.RBLXheadMesh && window.RBLXheadMesh.build){
    const real=window.RBLXheadMesh.build(size, scl);
    real.kind='decomp';
    return real;
  }
  return null;
}
function buildWorld(scene, parsed){
  const wb=new WorldBuilder(scene);
  const stats=wb.build(parsed);
  console.log('[world] parts:', stats.parts, 'colliders:', wb.colliders.length,
              'spawns:', wb.spawnPoints.length, 'hopperbins:', wb.hoppers.length, 'tools:', wb.tools.length);
  return wb;
}
})();
