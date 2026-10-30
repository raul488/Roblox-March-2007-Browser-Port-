/* ============================================================
 * g3d.js  literal port of the client's G3D RenderDevice layer.
 *
 * The 0.3.368 client renders through G3D's OpenGL 1.x RenderDevice
 * (decomp 0x4735c0-0x475f50).  This module ports that state layer:
 * the enum tables, the state cache (each setter only touches the GL
 * state when the value actually changes), up to eight GL lights, the
 * global ambient / two-sided / color-material model, texture env
 * modes, and the begin/end immediate-mode vertex path.
 *
 * WebGL has no fixed function, so the state is consumed by two small
 * GLSL programs that reproduce GL's lighting equation (ambient +
 * diffuse + specular, Lambert term, two-sided normal selection,
 * GL_MODULATE/DECAL/REPLACE/ADD/BLEND texture environments).
 *
 * Mined tables:
 *   depth func     FUN_00473ad0  (0 LEQUAL 1 LESS 2 GEQUAL 3 GREATER
 *                                 4 NOTEQUAL 5 EQUAL 6 off 7 ALWAYS)
 *   cull           FUN_00473870  (0 back 1 front 2 off)
 *   blend factors  FUN_00473390  (0 SRC_ALPHA 1 1-SRC_ALPHA 2 ONE
 *                                 3 ZERO 4 ZERO 5 SRC_COLOR
 *                                 6 1-SRC_COLOR)
 *   blend equations FUN_00474220 (0 MIN 1 MAX 2 ADD 3 SUBTRACT
 *                                 4 REVERSE_SUBTRACT)
 *   alpha func     FUN_00473dd0  (same value table as depth; 6 off)
 *   texture env    FUN_00474780  (0 MODULATE 1 BLEND 2 REPLACE
 *                                 3 COMBINE 4 DECAL 5 ADD 6 ADD-SIGNED
 *                                 7 DOT3 8 DOT3-RGBA 9 unchanged)
 *   shade model    0x1D00 smooth / 0x1D01 flat
 *   default material (FUN_0061d2d0): specular 0.2 grey, shininess 64,
 *                    emission black, color material AMBIENT_AND_DIFFUSE
 *   global ambient FUN_00474470 (uploaded divided by the device gamma)
 *   brightness     FUN_00478bc0 (gamma; 1.0/brightness stored at +0x224)
 *
 * Not carried over: stencil, fog (no Fog registration in this exe),
 * multisample, and the G3D bloom passes (not referenced by RBX::View).
 * ============================================================ */
(function(){
"use strict";

/* ---------------- GL enum tables (mined above) ---------------- */
const GLX={};
(function(){
  const gl=window.WebGLRenderingContext||{};
  Object.assign(GLX,{
    DEPTH_TEST:0x0B71, ALPHA_TEST:0x0BC0, LEQUAL:0x0203, LESS:0x0201, GEQUAL:0x0206,
    GREATER:0x0204, NOTEQUAL:0x0205, EQUAL:0x0202, ALWAYS:0x0207,
    NEVER:0x0200, CULL_FACE:0x0B44, BACK:0x0405, FRONT:0x0404,
    BLEND:0x0BE2, SRC_ALPHA:0x0302, ONE_MINUS_SRC_ALPHA:0x0303,
    ONE:1, ZERO:0, SRC_COLOR:0x0300, ONE_MINUS_SRC_COLOR:0x0301,
    FUNC_ADD:0x8006, FUNC_SUBTRACT:0x800A, FUNC_REVERSE_SUBTRACT:0x800B,
    MIN:0x8007, MAX:0x8008,
    TEXTURE_2D:0x0DE1, TEXTURE_CUBE_MAP:0x8513,
    RGBA:0x1908, UNSIGNED_BYTE:0x1401, FLOAT:0x1406,
    TEXTURE0:0x84C0,
    TEXTURE_MIN_FILTER:0x2801, TEXTURE_MAG_FILTER:0x2800,
    TEXTURE_WRAP_S:0x2802, TEXTURE_WRAP_T:0x2803,
    TEXTURE_WRAP_R:0x8072,
    NEAREST:0x2600, LINEAR:0x2601,
    NEAREST_MIPMAP_NEAREST:0x2700, LINEAR_MIPMAP_NEAREST:0x2701,
    NEAREST_MIPMAP_LINEAR:0x2702, LINEAR_MIPMAP_LINEAR:0x2703,
    CLAMP_TO_EDGE:0x812F, REPEAT:0x2901, MIRRORED_REPEAT:0x8370,
    UNPACK_FLIP_Y_WEBGL:0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL:0x9241,
    COLOR_BUFFER_BIT:0x4000, DEPTH_BUFFER_BIT:0x0100,
    ARRAY_BUFFER:0x8892, ELEMENT_ARRAY_BUFFER:0x8893,
    STATIC_DRAW:0x88E4, DYNAMIC_DRAW:0x88E8,
    TRIANGLES:4, TRIANGLE_STRIP:5, TRIANGLE_FAN:6, QUADS:7,
    LINES:1, LINE_STRIP:3, LINE_LOOP:2, POINTS:0,
    CCW:0x0901, CW:0x0900,
    FRONT_AND_BACK:0x0408, POLYGON_OFFSET_FILL:0x8037,
    TEXTURE_CUBE_MAP_POSITIVE_X:0x8515,
    LEQUAL_ALPHA:0x0203,
  });
})();

const CULL={BACK:0, FRONT:1, NONE:2};
const DEPTH={LEQUAL:0, LESS:1, GEQUAL:2, GREATER:3, NOTEQUAL:4,
             EQUAL:5, OFF:6, NEVER:7};
const BLEND={SRC_ALPHA:0, ONE_MINUS_SRC_ALPHA:1, ONE:2, ZERO:3,
             ZERO2:4, SRC_COLOR:5, ONE_MINUS_SRC_COLOR:6};
const BLEND_EQ={MIN:0, MAX:1, ADD:2, SUBTRACT:3, REVERSE_SUBTRACT:4};
const TEXENV={MODULATE:0, BLEND:1, REPLACE:2, COMBINE:3, DECAL:4,
              ADD:5, ADD_SIGNED:6, DOT3:7, DOT3_RGBA:8, KEEP:9};

function glDepthFunc(mode){
  return [GLX.LEQUAL,GLX.LESS,GLX.GEQUAL,GLX.GREATER,GLX.NOTEQUAL,
          GLX.EQUAL,null,GLX.NEVER][mode]||GLX.LEQUAL;
}
function glBlendFactor(v){
  switch(v){
    case BLEND.SRC_ALPHA: return GLX.SRC_ALPHA;
    case BLEND.ONE_MINUS_SRC_ALPHA: return GLX.ONE_MINUS_SRC_ALPHA;
    case BLEND.ONE: return GLX.ONE;
    case BLEND.ZERO: case BLEND.ZERO2: return GLX.ZERO;
    case BLEND.SRC_COLOR: return GLX.SRC_COLOR;
    case BLEND.ONE_MINUS_SRC_COLOR: return GLX.ONE_MINUS_SRC_COLOR;
  }
  return GLX.ZERO;
}
function glBlendEquation(v){
  return [GLX.MIN,GLX.MAX,GLX.FUNC_ADD,GLX.FUNC_SUBTRACT,
          GLX.FUNC_REVERSE_SUBTRACT][v]||GLX.FUNC_ADD;
}
function glTexFilter(v){
  switch(v){
    case 1003: return GLX.NEAREST;
    case 1004: return GLX.NEAREST_MIPMAP_NEAREST;
    case 1005: return GLX.LINEAR_MIPMAP_NEAREST;
    case 1006: return GLX.LINEAR;
    case 1007: return GLX.NEAREST_MIPMAP_LINEAR;
    case 1008: return GLX.LINEAR_MIPMAP_LINEAR;
  }
  return GLX.LINEAR;
}
function glWrap(v){
  switch(v){
    case 1000: return GLX.REPEAT;
    case 1002: return GLX.MIRRORED_REPEAT;
  }
  return GLX.CLAMP_TO_EDGE;
}

/* ---------------- fixed-function-equivalent shaders ---------------- *
 * GL 1.x lighting is per-vertex (Gouraud) with a constant eye-space view
 * vector unless GL_LIGHT_MODEL_LOCAL_VIEWER is set (the client never sets
 * it), so the light equation runs in the vertex shader and the fragment
 * stage only applies texture env + separate specular, exactly like the
 * fixed-function pipeline.  Front/back lighting is carried separately for
 * GL_LIGHT_MODEL_TWO_SIDE and selected with gl_FrontFacing. */
const VERT_SRC=`
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;
attribute vec4 aColor;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMatrix;
uniform mat3 uUvTransform;
uniform bool uUseVertexColor;
uniform bool uLit;
uniform bool uTwoSided;
uniform float uOpacity;
uniform vec3 uColor;
uniform vec3 uEmissive;
uniform vec3 uSpecular;
uniform float uShininess;
uniform vec3 uAmbient;
uniform vec3 uTopAmbient;
uniform vec3 uBottomAmbient;
uniform vec3 uEyeDir;
uniform vec3 uCameraPos;
uniform bool uEnvReflect;
uniform float uLightOn[8];
uniform vec4 uLightPos[8];
uniform vec3 uLightDiffuse[8];
uniform vec3 uLightSpecular[8];
uniform vec3 uLightAtten[8];
varying vec3 vLit;
varying vec3 vSpec;
varying vec3 vLitBack;
varying vec3 vSpecBack;
varying vec3 vEnv;
varying vec2 vUv;
varying float vAlpha;

void lightVertex(vec3 N, vec3 base, vec3 P, out vec3 lit, out vec3 spec){
  vec3 hemi=mix(uBottomAmbient,uTopAmbient,clamp(N.y*0.5+0.5,0.0,1.0));
  lit=base*(uAmbient+hemi)+uEmissive;
  spec=vec3(0.0);
  for (int i=0;i<8;i++){
    if (uLightOn[i]>0.5){
      vec3 L; float att=1.0;
      if (uLightPos[i].w>0.5){
        vec3 d=uLightPos[i].xyz-P;
        float dist=length(d);
        L=d/max(dist,0.0001);
        att=1.0/max(uLightAtten[i].x+uLightAtten[i].y*dist+
                    uLightAtten[i].z*dist*dist,0.0001);
      } else {
        L=normalize(uLightPos[i].xyz);
      }
      float ndl=max(dot(N,L),0.0);
      lit+=base*uLightDiffuse[i]*ndl*att;
      vec3 H=normalize(L+uEyeDir);
      spec+=uSpecular*uLightSpecular[i]*
            pow(max(dot(N,H),0.0),max(uShininess,1.0))*ndl*att;
    }
  }
}

void main(){
  vec4 wp=uModel*vec4(aPosition,1.0);
  vec3 N=normalize(uNormalMatrix*aNormal);
  vec3 V=normalize(uCameraPos-wp.xyz);
  vec3 base=uColor*(uUseVertexColor? aColor.rgb : vec3(1.0));
  vAlpha=uOpacity*(uUseVertexColor? aColor.a : 1.0);
  /* GL_REFLECTION_MAP for parts; a sky box samples the view direction
   * directly because it is the background, not a mirror. */
  vEnv=uEnvReflect? reflect(-V,N) : -V;
  if (uLit){
    lightVertex(N,base,wp.xyz,vLit,vSpec);
    if (uTwoSided) lightVertex(-N,base,wp.xyz,vLitBack,vSpecBack);
    else { vLitBack=vLit; vSpecBack=vSpec; }
  } else {
    vLit=base; vSpec=vec3(0.0);
    vLitBack=base; vSpecBack=vSpec;
  }
  vUv=(uUvTransform*vec3(aUv,1.0)).xy;
  gl_Position=uProjection*uView*wp;
}
`;

const FRAG_SRC=`
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform bool uTwoSided;
uniform bool uUseMap;
uniform bool uUseAlphaMap;
uniform bool uUseEnv;
uniform int uTexEnv;
uniform float uAlphaTest;
uniform float uBrightness;
uniform float uReflectivity;
uniform sampler2D uMap;
uniform sampler2D uAlphaMap;
uniform samplerCube uEnvMap;
varying vec3 vLit;
varying vec3 vSpec;
varying vec3 vLitBack;
varying vec3 vSpecBack;
varying vec3 vEnv;
varying vec2 vUv;
varying float vAlpha;
void main(){
  vec4 texel=uUseMap? texture2D(uMap,vUv) : vec4(1.0);
  vec3 lit=(uTwoSided && !gl_FrontFacing)? vLitBack : vLit;
  vec3 spec=(uTwoSided && !gl_FrontFacing)? vSpecBack : vSpec;
  vec3 base;
  if (uTexEnv==2) base=texel.rgb;
  else if (uTexEnv==5) base=lit+texel.rgb;
  else if (uTexEnv==1 || uTexEnv==4) base=mix(lit,texel.rgb,texel.a);
  else base=lit*texel.rgb;
  float alpha=vAlpha*texel.a;
  if (uUseAlphaMap) alpha*=texture2D(uAlphaMap,vUv).g;
  if (uUseEnv) base=mix(base,textureCube(uEnvMap,normalize(vEnv)).rgb,clamp(uReflectivity,0.0,1.0));
  base+=spec;                          /* GL_SEPARATE_SPECULAR_COLOR */
  if (uBrightness>0.0 && uBrightness!=1.0)
    base=pow(max(base,vec3(0.0)),vec3(1.0/uBrightness));
  if (uAlphaTest>0.0 && alpha<uAlphaTest) discard;
  gl_FragColor=vec4(base,alpha);
}
`;

/* ---------------- the RenderDevice port ---------------- */
class Device {
  constructor(gl){
    this.gl=gl;
    this.isWebGL2=!!(window.WebGL2RenderingContext &&
                     gl instanceof window.WebGL2RenderingContext);
    this.stats={stateChanges:0,draws:0,triangles:0,lights:0,programs:0};
    this.programs=new Map();
    this.buffers=new WeakMap();
    this.textures=new WeakMap();
    this._white2d=null;
    this._whiteCube=null;
    this._activeUnit=null;
    this._bound={};
    this._frame=0;
    this.im={active:false,mode:0,verts:[],nx:0,ny:0,nz:1,tu:0,tv:0,
             cr:1,cg:1,cb:1,ca:1};
    this.gamma=1.0;
    this.brightness=1.0;
    this._lightVersion=1;
    this.state={
      color:[1,1,1,1],
      ambient:[0,0,0,1],
      specular:[0.2,0.2,0.2,1],
      shininess:64,
      emissive:[0,0,0,1],
      lit:true, twoSided:false,
      depthTest:DEPTH.LEQUAL, depthWrite:true, depthMode:DEPTH.LEQUAL,
      cull:CULL.BACK, blend:{src:BLEND.ONE,dst:BLEND.ZERO,eq:BLEND_EQ.ADD,
                             on:false},
      alphaTest:6, alphaRef:0,
      shadeModel:0x1D00,
      polygonOffset:0,
      texEnv:TEXENV.MODULATE,
      texture:null, alphaMap:null, envMap:null, reflectivity:1, envReflect:false,
      useVertexColor:false,
      view:null, projection:null,
      topAmbient:[1,1,1], bottomAmbient:[0.25,0.3,0.35],
      cameraPos:[0,0,0], eyeDir:[0,0,1],
      lights:new Array(8),
      lightOn:new Array(8).fill(false),
    };
    for (let i=0;i<8;i++)
      this.state.lights[i]={pos:[0,0,1,0],diffuse:[0,0,0],
        specular:[0,0,0],atten:[1,0,0]};
    this.state.lightOn.fill(false);
    const uint=gl.getExtension&&gl.getExtension('OES_element_index_uint');
    this.uintIndex=!!uint;
    /* G3D initial state (FUN_0061d2d0): color material, 0.2 specular,
     * shininess 64, emission black. */
    gl.enable(GLX.DEPTH_TEST);
    gl.depthFunc(GLX.LEQUAL);
    gl.depthMask(true);
    gl.enable(GLX.CULL_FACE);
    gl.cullFace(GLX.BACK);
    gl.frontFace(GLX.CCW);
    gl.disable(GLX.BLEND);
    gl.pixelStorei(GLX.UNPACK_FLIP_Y_WEBGL,true);
  }

  beginFrame(){ this._frame++; this.stats.draws=0; this.stats.triangles=0; }
  get programCount(){ return this.programs.size; }

  /* ---- state setters (mirror FUN_0047xxxx) ---- */
  setColor(c,alpha){
    if (!c) return;
    if (typeof c.r==='number') c=[c.r,c.g,c.b,1];
    const a=(alpha==null)?(c[3]==null?1:c[3]):alpha;
    if (same4(this.state.color,[c[0],c[1],c[2],a])) return;
    this.state.color=[c[0],c[1],c[2],a]; this.stats.stateChanges++;
  }
  setAmbient(c){
    if (!c) return;
    if (typeof c.r==='number') c=[c.r,c.g,c.b,1];
    const g=this.gamma||1;
    const v=[c[0]/g,c[1]/g,c[2]/g,1];
    if (same4(this.state.ambient,v)) return;
    this.state.ambient=v; this.stats.stateChanges++; this._lightVersion++;
  }
  setSpecular(c){ if (!c) return;
    if (typeof c.r==='number') c=[c.r,c.g,c.b,1];
    if (same4(this.state.specular,[c[0],c[1],c[2],1])) return;
    this.state.specular=[c[0],c[1],c[2],1]; this.stats.stateChanges++; }
  setShininess(v){ v=Number(v)||0;
    if (this.state.shininess===v) return;
    this.state.shininess=v; this.stats.stateChanges++; }
  setEmissive(c){ if (!c) return;
    if (typeof c.r==='number') c=[c.r,c.g,c.b,1];
    if (same4(this.state.emissive,[c[0],c[1],c[2],1])) return;
    this.state.emissive=[c[0],c[1],c[2],1]; this.stats.stateChanges++; }
  setLit(on){ on=!!on;
    if (this.state.lit===on) return;
    this.state.lit=on; this.stats.stateChanges++; }
  setTopAmbient(c){ if (!c) return;
    if (same3(this.state.topAmbient,c)) return;
    this.state.topAmbient=c.slice(); this._lightVersion++; }
  setBottomAmbient(c){ if (!c) return;
    if (same3(this.state.bottomAmbient,c)) return;
    this.state.bottomAmbient=c.slice(); this._lightVersion++; }
  setTwoSided(on){ on=!!on;
    if (this.state.twoSided===on) return;
    this.state.twoSided=on; this.stats.stateChanges++; }
  setVertexColor(on){ this.state.useVertexColor=!!on; }

  setBrightness(b){
    b=Number(b); if (!isFinite(b)||b<=0) b=1;
    if (this.brightness===b) return;
    this.brightness=b; this.stats.stateChanges++;
  }

  /* FUN_00474e00: one of eight GL lights.  light.position is vec4:
   * w=0 directional, w=1 positional. */
  setLight(i,light){
    if (i<0||i>7) return;
    const s=this.state.lights[i];
    const changed=
      !s.pos||!same4(s.pos,light.pos)||
      !same3(s.diffuse,light.diffuse)||
      !same3(s.specular,light.specular)||
      !same3(s.atten||[1,0,0],light.atten||[1,0,0]);
    s.pos=(light.pos||[0,0,1,0]).slice();
    s.diffuse=(light.diffuse||[0,0,0]).slice();
    s.specular=(light.specular||[0,0,0]).slice();
    s.atten=(light.atten||[1,0,0]).slice();
    if (changed){ this.stats.stateChanges++; this.stats.lights++; this._lightVersion++; }
    this.setLightEnabled(i, light.enabled!==false);
  }
  setLightEnabled(i,on){
    if (i<0||i>7) return;
    if (this.state.lightOn[i]===!!on) return;
    this.state.lightOn[i]=!!on;
    this.stats.stateChanges++; this._lightVersion++;
  }
  enableLight(i){ this.setLightEnabled(i,true); }
  disableLight(i){ this.setLightEnabled(i,false); }

  setDepthTest(mode){
    mode=(mode==null)?DEPTH.LEQUAL:(mode|0);
    if (mode===8) return;                       /* keep current */
    if (this.state.depthMode===mode) return;
    this.state.depthMode=mode; this.stats.stateChanges++;
    if (mode===DEPTH.OFF) this.gl.disable(GLX.DEPTH_TEST);
    else {
      this.gl.enable(GLX.DEPTH_TEST);
      this.gl.depthFunc(glDepthFunc(mode));
    }
  }
  setDepthWrite(on){ on=!!on;
    if (this.state.depthWrite===on) return;
    this.state.depthWrite=on; this.stats.stateChanges++;
    this.gl.depthMask(on); }
  setCull(mode){
    mode=(mode==null)?CULL.BACK:(mode|0);
    if (mode===8) return;
    if (this.state.cull===mode) return;
    this.state.cull=mode; this.stats.stateChanges++;
    if (mode===CULL.NONE) this.gl.disable(GLX.CULL_FACE);
    else {
      this.gl.enable(GLX.CULL_FACE);
      this.gl.cullFace(mode===CULL.FRONT?GLX.FRONT:GLX.BACK);
    }
  }
  setBlend(src,dst,eq){
    src=(src==null)?BLEND.ONE:(src|0);
    dst=(dst==null)?BLEND.ZERO:(dst|0);
    eq=(eq==null)?BLEND_EQ.ADD:(eq|0);
    const was=this.state.blend;
    if (was.src===src&&was.dst===dst&&was.eq===eq) return;
    this.state.blend={src,dst,eq,on:true};
    this.stats.stateChanges++;
    /* FUN_00474270 disables blending for ONE/ZERO with ADD/SUBTRACT */
    const opaque=(src===BLEND.ONE&&dst===BLEND.ZERO&&
                  (eq===BLEND_EQ.ADD||eq===BLEND_EQ.SUBTRACT));
    if (opaque){
      this.state.blend.on=false;
      this.gl.disable(GLX.BLEND);
    } else {
      this.gl.enable(GLX.BLEND);
      this.gl.blendFunc(glBlendFactor(src),glBlendFactor(dst));
      if (this.gl.blendEquation) this.gl.blendEquation(glBlendEquation(eq));
    }
  }
  setBlendEnabled(on){
    if (this.state.blend.on===!!on) return;
    this.state.blend.on=!!on;
    this.stats.stateChanges++;
    if (on) this.gl.enable(GLX.BLEND); else this.gl.disable(GLX.BLEND);
  }
  setAlphaTest(mode,ref){
    mode=(mode==null)?6:(mode|0);
    ref=Number(ref)||0;
    if (this.state.alphaTest===mode&&this.state.alphaRef===ref) return;
    this.state.alphaTest=mode; this.state.alphaRef=ref;
    this.stats.stateChanges++;
    /* WebGL has no fixed-function alpha test; the shader discards below
     * uAlphaTest (monotonic less-than form). */
  }
  setShadeModel(model){ this.state.shadeModel=model|0; }
  setPolygonOffset(amount){
    amount=Number(amount)||0;
    if (this.state.polygonOffset===amount) return;
    this.state.polygonOffset=amount; this.stats.stateChanges++;
    if (amount===0) this.gl.disable(GLX.POLYGON_OFFSET_FILL);
    else {
      this.gl.enable(GLX.POLYGON_OFFSET_FILL);
      this.gl.polygonOffset(-amount,-amount);
    }
  }
  setTexture(tex){ this.state.texture=tex||null; }
  setAlphaMap(tex){ this.state.alphaMap=tex||null; }
  setEnvMap(tex){ this.state.envMap=tex||null; }
  setEnvReflect(on){ this.state.envReflect=!!on; }
  setReflectivity(v){ this.state.reflectivity=v==null?1:v; }
  setTextureEnv(mode){ this.state.texEnv=(mode==null?TEXENV.MODULATE:mode|0); }

  setViewMatrix(m){ this.state.view=m; }
  setProjectionMatrix(m){ this.state.projection=m; }
  viewport(x,y,w,h){ this.gl.viewport(x,y,w,h); }
  clearColor(c,a){
    this.state.clear=[c[0],c[1],c[2],a==null?1:a];
    this.gl.clearColor(c[0],c[1],c[2],a==null?1:a);
  }
  clear(mask){ this.gl.clear(mask==null?(GLX.COLOR_BUFFER_BIT|GLX.DEPTH_BUFFER_BIT):mask); }

  /* ---- texture upload (TextureProxy cache) ---- */
  _dummy2d(){
    if (this._white2d) return this._white2d;
    const gl=this.gl, t=gl.createTexture();
    gl.bindTexture(GLX.TEXTURE_2D,t);
    gl.texImage2D(GLX.TEXTURE_2D,0,GLX.RGBA,1,1,0,GLX.RGBA,GLX.UNSIGNED_BYTE,
                  new Uint8Array([255,255,255,255]));
    gl.texParameteri(GLX.TEXTURE_2D,GLX.TEXTURE_MIN_FILTER,GLX.NEAREST);
    gl.texParameteri(GLX.TEXTURE_2D,GLX.TEXTURE_MAG_FILTER,GLX.NEAREST);
    this._white2d=t; this._bound={}; return t;
  }
  _dummyCube(){
    if (this._whiteCube) return this._whiteCube;
    const gl=this.gl, t=gl.createTexture();
    gl.bindTexture(GLX.TEXTURE_CUBE_MAP,t);
    for (let i=0;i<6;i++)
      gl.texImage2D(GLX.TEXTURE_CUBE_MAP_POSITIVE_X+i,0,GLX.RGBA,1,1,0,
                    GLX.RGBA,GLX.UNSIGNED_BYTE,
                    new Uint8Array([255,255,255,255]));
    gl.texParameteri(GLX.TEXTURE_CUBE_MAP,GLX.TEXTURE_MIN_FILTER,GLX.NEAREST);
    gl.texParameteri(GLX.TEXTURE_CUBE_MAP,GLX.TEXTURE_MAG_FILTER,GLX.NEAREST);
    this._whiteCube=t; this._bound={}; return t;
  }
  _texture(tex){
    if (!tex) return null;
    const gl=this.gl;
    let rec=this.textures.get(tex);
    if (!rec){
      rec={tex:null,version:-1,cube:false,loaded:0};
      this.textures.set(tex,rec);
      if (tex.addEventListener) tex.addEventListener('dispose',()=>{
        const r=this.textures.get(tex);
        if (r&&r.tex) gl.deleteTexture(r.tex);
        this.textures.delete(tex); this._bound={};
      });
    }
    const cube=!!tex.isCubeTexture;
    const ready=im=>!!(im&&(im.width||im.videoWidth));
    const loaded=cube? (tex.image||[]).filter(ready).length : (ready(tex.image)?1:0);
    if (rec.tex && rec.version===tex.version && rec.cube===cube &&
        rec.loaded===loaded) return rec.tex;
    if (!rec.tex) rec.tex=gl.createTexture();
    rec.cube=cube; rec.version=tex.version; rec.loaded=loaded;
    const target=cube?GLX.TEXTURE_CUBE_MAP:GLX.TEXTURE_2D;
    gl.bindTexture(target,rec.tex);
    gl.pixelStorei(GLX.UNPACK_FLIP_Y_WEBGL,tex.flipY!==false);
    if (cube){
      const imgs=tex.image||[];
      for (let i=0;i<6;i++){
        const img=imgs[i];
        if (ready(img)) gl.texImage2D(GLX.TEXTURE_CUBE_MAP_POSITIVE_X+i,0,
                               GLX.RGBA,GLX.RGBA,GLX.UNSIGNED_BYTE,img);
      }
    } else if (tex.image && (tex.image.width||tex.image.videoWidth)){
      gl.texImage2D(GLX.TEXTURE_2D,0,GLX.RGBA,GLX.RGBA,GLX.UNSIGNED_BYTE,tex.image);
    }
    const pot=n=>n>0&&(n&(n-1))===0;
    let mipOK=true;
    if (cube){
      const imgs=tex.image||[];
      mipOK=imgs.length===6&&imgs.every(im=>im&&pot(im.width)&&pot(im.height));
    } else if (tex.image){
      mipOK=pot(tex.image.width)&&pot(tex.image.height);
    } else mipOK=false;
    if (!this.isWebGL2 && !mipOK) mipOK=false;
    const wrapS=mipOK?glWrap(tex.wrapS):GLX.CLAMP_TO_EDGE;
    const wrapT=mipOK?glWrap(tex.wrapT):GLX.CLAMP_TO_EDGE;
    const min=glTexFilter(tex.minFilter), mag=glTexFilter(tex.magFilter);
    const canMip=mipOK && tex.generateMipmaps!==false;
    gl.texParameteri(target,GLX.TEXTURE_WRAP_S,wrapS);
    gl.texParameteri(target,GLX.TEXTURE_WRAP_T,wrapT);
    if (cube) gl.texParameteri(target,GLX.TEXTURE_WRAP_R,wrapS);
    const mipMin=(min===GLX.NEAREST||min===GLX.LINEAR)?min:GLX.LINEAR_MIPMAP_LINEAR;
    gl.texParameteri(target,GLX.TEXTURE_MIN_FILTER,
      canMip?mipMin:GLX.LINEAR);
    gl.texParameteri(target,GLX.TEXTURE_MAG_FILTER,
      (mag===GLX.NEAREST)?GLX.NEAREST:GLX.LINEAR);
    if (canMip){
      try { gl.generateMipmap(target); } catch(_){}
    }
    this._bound={};               /* uploads changed the bound texture */
    return rec.tex;
  }

  /* ---- geometry buffers ---- */
  _buffers(geo){
    let rec=this.buffers.get(geo);
    if (rec) return rec;
    const gl=this.gl, a=geo.attributes||{};
    rec={};
    const mk=(attr,size)=>{
      if (!attr) return null;
      const buf=gl.createBuffer();
      gl.bindBuffer(GLX.ARRAY_BUFFER,buf);
      gl.bufferData(GLX.ARRAY_BUFFER,attr.array,GLX.STATIC_DRAW);
      return {buf,size,count:attr.count,type:GLX.FLOAT,
              normalized:!!attr.normalized};
    };
    rec.pos=mk(a.position,3);
    rec.nor=mk(a.normal,3);
    rec.uv=mk(a.uv,2);
    if (a.color){
      const n=a.color.count, src=a.color.array, sz=a.color.itemSize;
      const arr=new Float32Array(n*4);
      for (let i=0;i<n;i++){
        arr[i*4]=src[i*sz]; arr[i*4+1]=src[i*sz+1];
        arr[i*4+2]=src[i*sz+2];
        arr[i*4+3]=(sz>3)?src[i*sz+3]:1;
      }
      rec.col=mk({array:arr,count:n},4);
    } else rec.col=null;
    rec.idx=null;
    if (geo.index){
      let arr=geo.index.array;
      let type=(arr instanceof Uint32Array)?0x1405:0x1403;
      if (type===0x1405 && !this.uintIndex){
        /* WebGL1 without OES_element_index_uint: narrow when possible. */
        let max=0;
        for (let i=0;i<arr.length;i++) if (arr[i]>max) max=arr[i];
        if (max<65536){ arr=new Uint16Array(arr); type=0x1403; }
      }
      const ib=gl.createBuffer();
      gl.bindBuffer(GLX.ELEMENT_ARRAY_BUFFER,ib);
      gl.bufferData(GLX.ELEMENT_ARRAY_BUFFER,arr,GLX.STATIC_DRAW);
      rec.idx={buf:ib,count:geo.index.count,type};
    }
    this.buffers.set(geo,rec);
    if (geo.addEventListener) geo.addEventListener('dispose',()=>{
      const r=this.buffers.get(geo);
      if (!r) return;
      for (const k of ['pos','nor','uv','col'])
        if (r[k]&&r[k].buf) gl.deleteBuffer(r[k].buf);
      if (r.idx&&r.idx.buf) gl.deleteBuffer(r.idx.buf);
      this.buffers.delete(geo);
    });
    return rec;
  }

  /* ---- program cache ---- */
  _program(lit,env){
    const key=(lit?'lit':'unlit')+(env?'|env':'');
    let p=this.programs.get(key);
    if (p) return p;
    p=this._compile(lit,env);
    this.programs.set(key,p);
    if (p) this.stats.programs++;
    return p;
  }
  _compile(lit,env){
    const gl=this.gl;
    const vs=gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs,VERT_SRC); gl.compileShader(vs);
    const okV=gl.getShaderParameter(vs,gl.COMPILE_STATUS);
    if (!okV&&gl.getShaderInfoLog)
      console.error('[g3d] vertex shader: '+gl.getShaderInfoLog(vs));
    const fs=gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs,FRAG_SRC); gl.compileShader(fs);
    const okF=gl.getShaderParameter(fs,gl.COMPILE_STATUS);
    if (!okF&&gl.getShaderInfoLog)
      console.error('[g3d] fragment shader: '+gl.getShaderInfoLog(fs));
    if (!okV||!okF) return null;
    const prog=gl.createProgram();
    gl.attachShader(prog,vs); gl.attachShader(prog,fs);
    const names=['aPosition','aNormal','aUv','aColor'];
    for (let i=0;i<names.length;i++) gl.bindAttribLocation(prog,i,names[i]);
    gl.linkProgram(prog);
    const okL=gl.getProgramParameter(prog,gl.LINK_STATUS);
    if (!okL&&gl.getProgramInfoLog)
      console.error('[g3d] link: '+gl.getProgramInfoLog(prog));
    if (!okL) return null;
    const u={};
    const scalars=['uProjection','uView','uModel','uNormalMatrix','uUvTransform','uUseVertexColor',
      'uLit','uTwoSided','uUseMap','uUseAlphaMap','uUseEnv','uTexEnv','uOpacity',
      'uAlphaTest','uBrightness','uColor','uEmissive','uSpecular','uShininess',
      'uAmbient','uTopAmbient','uBottomAmbient','uCameraPos','uEyeDir',
      'uReflectivity','uEnvReflect','uMap','uAlphaMap','uEnvMap'];
    for (const n of scalars) u[n]=gl.getUniformLocation(prog,n);
    u.lightOn=[],u.lightPos=[],u.lightDiffuse=[],u.lightSpecular=[],u.lightAtten=[];
    for (let i=0;i<8;i++){
      u.lightOn.push(gl.getUniformLocation(prog,'uLightOn['+i+']'));
      u.lightPos.push(gl.getUniformLocation(prog,'uLightPos['+i+']'));
      u.lightDiffuse.push(gl.getUniformLocation(prog,'uLightDiffuse['+i+']'));
      u.lightSpecular.push(gl.getUniformLocation(prog,'uLightSpecular['+i+']'));
      u.lightAtten.push(gl.getUniformLocation(prog,'uLightAtten['+i+']'));
    }
    /* sampler units are static for the program lifetime */
    gl.useProgram(prog);
    if (u.uMap!=null) gl.uniform1i(u.uMap,0);
    if (u.uAlphaMap!=null) gl.uniform1i(u.uAlphaMap,1);
    if (u.uEnvMap!=null) gl.uniform1i(u.uEnvMap,2);
    return {prog,u,lit,env,frame:-1};
  }

  _setUniforms(p,geo,model,normal){
    const gl=this.gl, u=p.u, s=this.state;
    const U=(loc,fn,...a)=>{ if (loc!=null) gl[fn](loc,...a); };
    if (p.frame!==this._frame){
      if (s.projection) U(u.uProjection,'uniformMatrix4fv',false,s.projection);
      if (s.view) U(u.uView,'uniformMatrix4fv',false,s.view);
      p.frame=this._frame;
    }
    U(u.uModel,'uniformMatrix4fv',false,model.elements||model);
    U(u.uNormalMatrix,'uniformMatrix3fv',false,normal.elements||normal);
    if (s.texture && s.texture.updateMatrix) s.texture.updateMatrix();
    const tm=(s.texture&&s.texture.matrix&&s.texture.matrix.elements)
      ? s.texture.matrix.elements : IDENT3.elements;
    U(u.uUvTransform,'uniformMatrix3fv',false,tm);
    U(u.uUseVertexColor,'uniform1i',s.useVertexColor?1:0);
    U(u.uLit,'uniform1i',s.lit?1:0);
    U(u.uTwoSided,'uniform1i',s.twoSided?1:0);
    U(u.uUseMap,'uniform1i',s.texture?1:0);
    U(u.uUseAlphaMap,'uniform1i',s.alphaMap?1:0);
    U(u.uUseEnv,'uniform1i',s.envMap?1:0);
    U(u.uTexEnv,'uniform1i',s.texEnv);
    U(u.uOpacity,'uniform1f',s.color[3]);
    U(u.uAlphaTest,'uniform1f',s.alphaTest===6?0:s.alphaRef);
    U(u.uBrightness,'uniform1f',this.brightness);
    U(u.uColor,'uniform3f',s.color[0],s.color[1],s.color[2]);
    U(u.uEmissive,'uniform3f',s.emissive[0],s.emissive[1],s.emissive[2]);
    U(u.uSpecular,'uniform3f',s.specular[0],s.specular[1],s.specular[2]);
    U(u.uShininess,'uniform1f',s.shininess);
    const cp=s.cameraPos||[0,0,0];
    U(u.uCameraPos,'uniform3f',cp[0],cp[1],cp[2]);
    const ed=s.eyeDir||[0,0,1];
    U(u.uEyeDir,'uniform3f',ed[0],ed[1],ed[2]);
    U(u.uReflectivity,'uniform1f',s.reflectivity==null?1:s.reflectivity);
    U(u.uEnvReflect,'uniform1i',s.envReflect?1:0);
    /* GL light state changes rarely (time of day / a script write); upload
     * it once per change instead of once per draw. */
    if (p.lightVersion!==this._lightVersion){
      U(u.uAmbient,'uniform3f',s.ambient[0],s.ambient[1],s.ambient[2]);
      U(u.uTopAmbient,'uniform3f',s.topAmbient[0],s.topAmbient[1],s.topAmbient[2]);
      U(u.uBottomAmbient,'uniform3f',s.bottomAmbient[0],s.bottomAmbient[1],s.bottomAmbient[2]);
      for (let i=0;i<8;i++){
        U(u.lightOn[i],'uniform1f',s.lightOn[i]?1:0);
        const L=s.lights[i];
        U(u.lightPos[i],'uniform4f',L.pos[0],L.pos[1],L.pos[2],L.pos[3]);
        U(u.lightDiffuse[i],'uniform3f',L.diffuse[0],L.diffuse[1],L.diffuse[2]);
        U(u.lightSpecular[i],'uniform3f',L.specular[0],L.specular[1],L.specular[2]);
        U(u.lightAtten[i],'uniform3f',L.atten[0],L.atten[1],L.atten[2]);
      }
      p.lightVersion=this._lightVersion;
    }
  }

  _bindAttributes(p,geo,rec){
    const gl=this.gl;
    const set=(loc,data,size)=>{
      if (loc==null) return;
      if (!data){ gl.disableVertexAttribArray(loc); gl.vertexAttrib3f(loc,1,1,1); return; }
      gl.bindBuffer(GLX.ARRAY_BUFFER,data.buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc,size,GLX.FLOAT,false,0,0);
    };
    set(0,rec.pos,3); set(1,rec.nor,3); set(2,rec.uv,2);
    set(3,rec.col,4);
  }

  _bindTextures(p){
    const gl=this.gl, s=this.state;
    const bind=(unit,target,tex)=>{
      if (this._activeUnit!==unit){
        gl.activeTexture(GLX.TEXTURE0+unit); this._activeUnit=unit;
      }
      const key=(target===GLX.TEXTURE_CUBE_MAP?'c':'t')+unit;
      if (this._bound[key]===tex) return;
      gl.bindTexture(target,tex); this._bound[key]=tex;
    };
    bind(0,GLX.TEXTURE_2D,this._texture(s.texture)||this._dummy2d());
    bind(1,GLX.TEXTURE_2D,this._texture(s.alphaMap)||this._dummy2d());
    bind(2,GLX.TEXTURE_CUBE_MAP,this._texture(s.envMap)||this._dummyCube());
  }

  /* draw an indexed/non-indexed BufferGeometry: the G3D vertex-array
   * path (FUN_00476030/FUN_004763b0) */
  drawGeometry(geo,model,normal,range){
    if (!geo) return;
    const gl=this.gl, p=this._program(this.state.lit,!!this.state.envMap);
    if (!p) return;
    const rec=this._buffers(geo);
    if (!rec.pos) return;
    gl.useProgram(p.prog);
    this._setUniforms(p,geo,model,normal);
    this._bindAttributes(p,geo,rec);
    this._bindTextures(p);
    const start=range&&range.start||0;
    const count=range&&range.count!=null?range.count:null;
    if (rec.idx){
      gl.bindBuffer(GLX.ELEMENT_ARRAY_BUFFER,rec.idx.buf);
      const bytes=(rec.idx.type===0x1405)?4:2;
      gl.drawElements(GLX.TRIANGLES,count!=null?count:rec.idx.count,rec.idx.type,
                      start*bytes);
      this.stats.triangles+=(count!=null?count:rec.idx.count)/3;
    } else {
      gl.drawArrays(GLX.TRIANGLES,start,count!=null?count:rec.pos.count);
      this.stats.triangles+=(count!=null?count:rec.pos.count)/3;
    }
    this.stats.draws++;
  }
  /* ---- immediate mode (glBegin/glEnd) ------------------------------
   * G3D still exposes the vertex-array path for parts, but the device's
   * immediate API is part of the ported layer.  Vertices are captured with
   * the current normal/texcoord/color and flushed as one transient draw. */
  begin(mode){
    if (this.im.active) this.end();
    this.im.active=true; this.im.mode=mode|0; this.im.verts=[];
  }
  end(){
    if (!this.im.active) return;
    this.im.active=false;
    if (this.im.verts.length) this._flushImmediate();
    this.im.verts.length=0;
  }
  vertex(x,y,z){
    if (x&&typeof x==='object'){ z=x.z; y=x.y; x=x.x; }
    const im=this.im;
    im.verts.push({x:x||0,y:y||0,z:z||0,nx:im.nx,ny:im.ny,nz:im.nz,
                   u:im.tu,v:im.tv,r:im.cr,g:im.cg,b:im.cb,a:im.ca});
  }
  normal(x,y,z){
    if (x&&typeof x==='object'){ z=x.z; y=x.y; x=x.x; }
    const im=this.im;
    im.nx=x||0; im.ny=y||0; im.nz=z||0;
  }
  texCoord(u,v){ if (u&&typeof u==='object'){ v=u.y; u=u.x; }
    this.im.tu=u||0; this.im.tv=v||0; }
  color(r,g,b,a){
    if (r&&typeof r==='object'){ a=r[3]; g=r[1]; b=r[2]; r=r[0]; }
    const im=this.im;
    im.cr=r==null?1:r; im.cg=g==null?1:g;
    im.cb=b==null?1:b; im.ca=a==null?1:a;
  }
  _flushImmediate(){
    const gl=this.gl, V=this.im.verts, mode=this.im.mode;
    const tri=[];
    const push=(a,b,c)=>{ tri.push(a,b,c); };
    if (mode===GLX.QUADS){
      for (let i=0;i+3<V.length;i+=4){ push(i,i+1,i+2); push(i,i+2,i+3); }
    } else if (mode===GLX.TRIANGLES){
      for (let i=0;i+2<V.length;i+=3) push(i,i+1,i+2);
    } else if (mode===GLX.TRIANGLE_FAN){
      for (let i=1;i+1<V.length;i++) push(0,i,i+1);
    } else if (mode===GLX.TRIANGLE_STRIP){
      for (let i=0;i+2<V.length;i++){
        if (i&1) push(i+1,i,i+2); else push(i,i+1,i+2);
      }
    } else if (mode===GLX.LINES){
      for (let i=0;i+1<V.length;i+=2) push(i,i+1);
    } else if (mode===GLX.LINE_STRIP){
      for (let i=0;i+1<V.length;i++) push(i,i+1);
    } else if (mode===GLX.LINE_LOOP){
      for (let i=0;i+1<V.length;i++) push(i,i+1);
      if (V.length>2) push(V.length-1,0);
    } else if (mode===GLX.POINTS){
      for (let i=0;i<V.length;i++) push(i,i,i);
    }
    if (!tri.length) return;
    const pos=new Float32Array(V.length*3), nor=new Float32Array(V.length*3);
    const uv=new Float32Array(V.length*2), col=new Float32Array(V.length*4);
    for (let i=0;i<V.length;i++){
      const v=V[i];
      pos[i*3]=v.x; pos[i*3+1]=v.y; pos[i*3+2]=v.z;
      nor[i*3]=v.nx; nor[i*3+1]=v.ny; nor[i*3+2]=v.nz;
      uv[i*2]=v.u; uv[i*2+1]=v.v;
      col[i*4]=v.r; col[i*4+1]=v.g; col[i*4+2]=v.b; col[i*4+3]=v.a;
    }
    const p=this._program(this.state.lit,!!this.state.envMap);
    if (!p) return;
    const prevVC=this.state.useVertexColor;
    const prevColor=this.state.color;
    this.state.useVertexColor=true;       /* glColor is the vertex material */
    this.state.color=[1,1,1,1];           /* do not multiply glColor twice */
    gl.useProgram(p.prog);
    this._setUniforms(p,null,IDENT4,IDENT3);
    this._bindTextures(p);
    this.state.useVertexColor=prevVC;
    this.state.color=prevColor;
    const bufs=[];
    const bind=(loc,arr,size)=>{
      const b=gl.createBuffer(); bufs.push(b);
      gl.bindBuffer(GLX.ARRAY_BUFFER,b);
      gl.bufferData(GLX.ARRAY_BUFFER,arr,GLX.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc,size,GLX.FLOAT,false,0,0);
    };
    bind(0,pos,3); bind(1,nor,3); bind(2,uv,2); bind(3,col,4);
    const idx=(tri.length>65535)?new Uint32Array(tri):new Uint16Array(tri);
    const ib=gl.createBuffer(); bufs.push(ib);
    gl.bindBuffer(GLX.ELEMENT_ARRAY_BUFFER,ib);
    gl.bufferData(GLX.ELEMENT_ARRAY_BUFFER,idx,GLX.DYNAMIC_DRAW);
    const type=(idx instanceof Uint32Array)?0x1405:0x1403;
    if (mode===GLX.POINTS){
      gl.drawArrays(GLX.POINTS,0,V.length);
    } else if (mode===GLX.LINES||mode===GLX.LINE_STRIP||mode===GLX.LINE_LOOP){
      gl.drawElements(GLX.LINES,idx.length,type,0);
    } else gl.drawElements(GLX.TRIANGLES,idx.length,type,0);
    for (const b of bufs) if (gl.deleteBuffer) gl.deleteBuffer(b);
    this.stats.triangles+=(mode===GLX.LINES||mode===GLX.LINE_STRIP||
      mode===GLX.LINE_LOOP||mode===GLX.POINTS)?0:tri.length/3;
    this.stats.draws++;
  }

  drawLines(geo,model,normal){
    if (!geo) return;
    const gl=this.gl, p=this._program(false,false);
    if (!p) return;
    const rec=this._buffers(geo);
    if (!rec.pos) return;
    gl.useProgram(p.prog);
    this._setUniforms(p,geo,model,normal||IDENT3);
    this._bindAttributes(p,geo,rec);
    this._bindTextures(p);
    if (rec.idx){
      gl.bindBuffer(GLX.ELEMENT_ARRAY_BUFFER,rec.idx.buf);
      gl.drawElements(GLX.LINES,rec.idx.count,rec.idx.type,0);
    } else gl.drawArrays(GLX.LINES,0,rec.pos.count);
    this.stats.draws++;
  }
}

/* ---------------- helpers ---------------- */
const IDENT3={elements:new Float32Array([1,0,0, 0,1,0, 0,0,1])};
const IDENT4={elements:new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1])};
function same3(a,b){ return a&&b&&a[0]===b[0]&&a[1]===b[1]&&a[2]===b[2]; }
function same4(a,b){ return a&&b&&a[0]===b[0]&&a[1]===b[1]&&a[2]===b[2]&&a[3]===b[3]; }

/* ---------------- the scene renderer ---------------- */
class Renderer {
  constructor(opts){
    opts=opts||{};
    const canvas=opts.canvas||document.createElement('canvas');
    const attrs={antialias:!!opts.antialias,alpha:false,premultipliedAlpha:false,
      preserveDrawingBuffer:!!opts.preserveDrawingBuffer,
      powerPreference:opts.powerPreference||'high-performance',depth:true,
      stencil:false};
    /* WebGL 1 keeps the fixed-function-equivalent GLSL ES 1.00 shaders
     * portable (WebGL2 contexts require GLSL ES 3.00 unless aliased).
     * 32-bit indices come from OES_element_index_uint, which every target
     * browser exposes. */
    let gl=null;
    try { gl=canvas.getContext('webgl',attrs)
             ||canvas.getContext('experimental-webgl',attrs); } catch(_){}
    if (!gl) throw new Error('WebGL is not available');
    this.domElement=canvas;
    this.gl=gl;
    this.isWebGL2=!!(window.WebGL2RenderingContext &&
                     gl instanceof window.WebGL2RenderingContext);
    this.device=new Device(gl);
    this.device.isWebGL2=this.isWebGL2;
    /* compile up front so a driver/shader failure reaches the page's
     * WebGL warning instead of silently drawing nothing. */
    if (!this.device._program(true,false)||!this.device._program(false,false)||
        !this.device._program(false,true))
      throw new Error('G3D shader compilation failed');
    this.pixelRatio=1;
    this.width=1; this.height=1;
    this.brightness=1;
    this.info={render:{calls:0,triangles:0,frame:0},memory:{geometries:0,textures:0}};
    this.renderLists={dispose:()=>{}};
    this.autoClear=true;
    this._quad=null;
    this._frustum=new THREE.Frustum();
    this._mvp=new THREE.Matrix4();
    this._projScreen=new THREE.Matrix4();
    this._tmpV=new THREE.Vector3();
    this._normal=new THREE.Matrix3();
    this._items=[];
  }
  getContext(){ return this.gl; }
  setPixelRatio(p){ this.pixelRatio=Math.max(0.1,p||1); this.setSize(this.width,this.height,false); }
  setSize(w,h,updateStyle){
    this.width=Math.max(1,Math.floor(w||1));
    this.height=Math.max(1,Math.floor(h||1));
    const pw=Math.max(1,Math.floor(this.width*this.pixelRatio));
    const ph=Math.max(1,Math.floor(this.height*this.pixelRatio));
    if (this.domElement.width!==pw) this.domElement.width=pw;
    if (this.domElement.height!==ph) this.domElement.height=ph;
    if (updateStyle!==false){
      this.domElement.style.width=this.width+'px';
      this.domElement.style.height=this.height+'px';
    }
  }

  /* lights come from the scene's three.js light objects, which world.js
   * already drives from Lighting/TimeOfDay.  G3D receives them in the
   * fixed-function form: one global ambient, hemisphere ambient, and
   * GL_LIGHT0 as the sun/moon. */
  _applyLights(scene,camera){
    const d=this.device, s=d.state;
    let hemi=null,dir=null,amb=null;
    scene.traverse(o=>{
      if (o.isHemisphereLight&&!hemi) hemi=o;
      else if (o.isDirectionalLight&&!dir) dir=o;
      else if (o.isAmbientLight&&!amb) amb=o;
    });
    const scale=1; /* intensities are the world's day/night values; Brightness is gamma */
    if (hemi){
      d.setTopAmbient([hemi.color.r*hemi.intensity*scale,
                       hemi.color.g*hemi.intensity*scale,
                       hemi.color.b*hemi.intensity*scale]);
      d.setBottomAmbient([hemi.groundColor.r*hemi.intensity*scale,
                          hemi.groundColor.g*hemi.intensity*scale,
                          hemi.groundColor.b*hemi.intensity*scale]);
    } else {
      d.setTopAmbient([1,1,1]); d.setBottomAmbient([0.25,0.3,0.35]);
    }
    if (amb) d.setAmbient([amb.color.r*amb.intensity,amb.color.g*amb.intensity,
                           amb.color.b*amb.intensity]);
    else d.setAmbient([0,0,0]);
    d.setBrightness(this.brightness!=null?this.brightness:1);
    if (dir){
      const p=this._tmpV.copy(dir.position);
      if (p.lengthSq()<1e-9) p.set(0,1,0);
      p.normalize();
      d.setLight(0,{enabled:true,pos:[p.x,p.y,p.z,0],
        diffuse:[dir.color.r*dir.intensity,dir.color.g*dir.intensity,
                 dir.color.b*dir.intensity],
        /* GL light specular is independent of the diffuse intensity.  The
         * client leaves G3D's default white specular in place, which is what
         * gives every part the plastic sheen even with Reflectance = 0. */
        specular:[1,1,1],
        atten:[1,0,0]});
    } else d.disableLight(0);
    for (let i=1;i<8;i++) d.disableLight(i);
    s.cameraPos=[camera.position.x,camera.position.y,camera.position.z];
    /* GL_LIGHT_MODEL_LOCAL_VIEWER is left at its default (disabled), so
     * fixed-function specular uses the constant eye-space (0,0,1) view
     * direction.  The view matrix's third column is that direction in
     * world space. */
    const ve=camera.matrixWorldInverse.elements;
    const ex=ve[2],ey=ve[6],ez=ve[10];
    const el=Math.hypot(ex,ey,ez)||1;
    s.eyeDir=[ex/el,ey/el,ez/el];
  }

  _collect(scene,camera){
    const items=[];
    const fr=this._frustum;
    this._projScreen.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    fr.setFromProjectionMatrix(this._projScreen);
    const walk=(o)=>{
      if (!o.visible) return;
      if (o.isMesh||o.isLine||o.isPoints||o.isSprite){
        if (!o.frustumCulled||o.isSprite||fr.intersectsObject(o))
          items.push(o);
      }
      const ch=o.children;
      for (let i=0;i<ch.length;i++) walk(ch[i]);
    };
    walk(scene);
    return items;
  }

  _drawMesh(obj,material,geo,group){
    const d=this.device, mat=material;
    if (!mat||mat.visible===false) return;
    const isBasic=!!mat.isMeshBasicMaterial;
    d.setLit(!isBasic);
    d.setTwoSided(mat.side===THREE.DoubleSide);
    const col=mat.color||{r:1,g:1,b:1};
    const opacity=(mat.opacity==null)?1:mat.opacity;
    d.setColor([col.r,col.g,col.b],opacity);
    const spec=mat.specular;
    d.setSpecular(spec?[spec.r,spec.g,spec.b]:[0.2,0.2,0.2]);
    d.setShininess(mat.shininess!=null?mat.shininess:64);
    const em=mat.emissive;
    d.setEmissive(em?[em.r,em.g,em.b]:[0,0,0]);
    d.setVertexColor(!!mat.vertexColors);
    d.setTexture(mat.map||null);
    d.setAlphaMap(mat.alphaMap||null);
    d.setEnvMap(mat.envMap||null);
    /* The sky box is the background itself (view direction); a reflective
     * part uses GL_REFLECTION_MAP around its own normal. */
    d.setEnvReflect(!!mat.envMap && !(mat.isMeshBasicMaterial &&
                                      mat.side===THREE.BackSide));
    d.setReflectivity(mat.reflectivity!=null?mat.reflectivity:1);
    d.setTextureEnv(TEXENV.MODULATE);
    const transparent=!!mat.transparent;
    if (transparent){
      if (mat.blending===THREE.AdditiveBlending) d.setBlend(BLEND.SRC_ALPHA,BLEND.ONE,BLEND_EQ.ADD);
      else if (mat.blending===THREE.SubtractiveBlending) d.setBlend(BLEND.ZERO,BLEND.ONE_MINUS_SRC_COLOR,BLEND_EQ.ADD);
      else if (mat.blending===THREE.MultiplyBlending) d.setBlend(BLEND.ZERO,BLEND.SRC_COLOR,BLEND_EQ.ADD);
      else if (mat.blending===THREE.NoBlending) d.setBlend(BLEND.ONE,BLEND.ZERO,BLEND_EQ.ADD);
      else d.setBlend(BLEND.SRC_ALPHA,BLEND.ONE_MINUS_SRC_ALPHA,BLEND_EQ.ADD);
    } else d.setBlend(BLEND.ONE,BLEND.ZERO,BLEND_EQ.ADD);
    d.setDepthTest(mat.depthTest===false?DEPTH.OFF:DEPTH.LEQUAL);
    d.setDepthWrite(mat.depthWrite!==false);
    d.setCull(mat.side===THREE.DoubleSide?CULL.NONE:
              (mat.side===THREE.BackSide?CULL.FRONT:CULL.BACK));
    d.setPolygonOffset(mat.polygonOffset?1:0);
    d.setAlphaTest(mat.alphaTest>0?DEPTH.LEQUAL:6,mat.alphaTest||0);
    /* material arrays invoke this once per face group; the normal matrix
     * is an object property, so compute it once per object per frame. */
    let nm=obj.__g3dNormal;
    if (!nm){ nm=obj.__g3dNormal=new THREE.Matrix3(); obj.__g3dNormalFrame=-1; }
    if (obj.__g3dNormalFrame!==d._frame){
      nm.getNormalMatrix(obj.matrixWorld);
      obj.__g3dNormalFrame=d._frame;
    }
    d.drawGeometry(geo,obj.matrixWorld,nm,group);
  }

  _drawSprite(obj){
    const mat=obj.material;
    if (!mat) return;
    if (!this._quad){
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.Float32BufferAttribute(
        [-0.5,-0.5,0, 0.5,-0.5,0, 0.5,0.5,0, -0.5,0.5,0],3));
      g.setAttribute('normal',new THREE.Float32BufferAttribute(
        [0,0,1, 0,0,1, 0,0,1, 0,0,1],3));
      g.setAttribute('uv',new THREE.Float32BufferAttribute(
        [0,0, 1,0, 1,1, 0,1],2));
      g.setIndex([0,1,2,0,2,3]);
      this._quad=g;
    }
    const d=this.device;
    d.setLit(false); d.setTwoSided(false);
    const col=mat.color||{r:1,g:1,b:1};
    d.setColor([col.r,col.g,col.b],mat.opacity==null?1:mat.opacity);
    d.setSpecular([0,0,0]); d.setEmissive([0,0,0]); d.setShininess(1);
    d.setVertexColor(false);
    d.setTexture(mat.map||null); d.setAlphaMap(mat.alphaMap||null);
    d.setEnvMap(null); d.setEnvReflect(false); d.setTextureEnv(TEXENV.MODULATE);
    d.setBlend(BLEND.SRC_ALPHA,BLEND.ONE_MINUS_SRC_ALPHA,BLEND_EQ.ADD);
    d.setDepthTest(mat.depthTest===false?DEPTH.OFF:DEPTH.LEQUAL);
    d.setDepthWrite(false);
    d.setCull(CULL.NONE); d.setPolygonOffset(0);
    d.setAlphaTest(mat.alphaTest>0?DEPTH.LEQUAL:6,mat.alphaTest||0);
    /* billboard: camera right/up columns, sprite scale from matrixWorld */
    const cam=this._camera, mw=obj.matrixWorld, e=mw.elements;
    const sx=Math.hypot(e[0],e[1],e[2])||1;
    const sy=Math.hypot(e[4],e[5],e[6])||1;
    const ce=cam.matrixWorld.elements;
    const model=new THREE.Matrix4();
    model.set(
      ce[0]*sx, ce[4]*sy, ce[8], e[12],
      ce[1]*sx, ce[5]*sy, ce[9], e[13],
      ce[2]*sx, ce[6]*sy, ce[10], e[14],
      0,0,0,1);
    const n=new THREE.Matrix3().identity();
    d.drawGeometry(this._quad,model,n);
  }

  _drawLine(obj){
    const mat=obj.material;
    if (!mat) return;
    const d=this.device;
    d.setLit(false); d.setTwoSided(false);
    const c=mat.color||{r:1,g:1,b:1};
    d.setColor([c.r,c.g,c.b],mat.opacity==null?1:mat.opacity);
    d.setSpecular([0,0,0]); d.setEmissive([0,0,0]); d.setShininess(1);
    d.setTexture(null); d.setAlphaMap(null); d.setEnvMap(null); d.setEnvReflect(false);
    const tr=!!mat.transparent;
    if (tr) d.setBlend(BLEND.SRC_ALPHA,BLEND.ONE_MINUS_SRC_ALPHA,BLEND_EQ.ADD);
    else d.setBlend(BLEND.ONE,BLEND.ZERO,BLEND_EQ.ADD);
    d.setDepthTest(mat.depthTest===false?DEPTH.OFF:DEPTH.LEQUAL);
    d.setDepthWrite(mat.depthWrite!==false);
    d.setCull(CULL.NONE); d.setPolygonOffset(0);
    d.setVertexColor(false);
    this._normal.getNormalMatrix(obj.matrixWorld);
    d.drawLines(obj.geometry,obj.matrixWorld,this._normal);
  }

  render(scene,camera){
    if (!scene||!camera) return;
    const gl=this.gl, d=this.device;
    this._camera=camera;
    scene.updateMatrixWorld();
    if (camera.parent===null) camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    d.viewport(0,0,this.domElement.width,this.domElement.height);
    d.setProjectionMatrix(camera.projectionMatrix.elements);
    d.setViewMatrix(camera.matrixWorldInverse.elements);
    d.beginFrame();
    if (scene.userData&&scene.userData.lightingBrightness!=null)
      this.brightness=Number(scene.userData.lightingBrightness)||1;
    this._applyLights(scene,camera);
    const bg=scene.background;
    if (bg&&bg.isColor) d.clearColor([bg.r,bg.g,bg.b],1);
    else d.clearColor([0.04,0.06,0.09],1);
    /* the previous frame's last transparent draw may have left depth writes
     * off; glClear(DEPTH) is masked by depthMask in GL. */
    d.setDepthWrite(true);
    if (this.autoClear) d.clear(GLX.COLOR_BUFFER_BIT|GLX.DEPTH_BUFFER_BIT);

    const objs=this._collect(scene,camera);
    const camPos=camera.position;
    const opaque=[],transparent=[];
    for (const o of objs){
      if (o.isMesh){
        const mats=Array.isArray(o.material)?o.material:[o.material];
        const groups=(o.geometry&&o.geometry.groups)||[];
        if (Array.isArray(o.material)&&groups.length){
          for (const g of groups){
            const mat=mats[g.materialIndex]||mats[0];
            if (mat) this._queue(o,mat,o.geometry,g,opaque,transparent,camPos);
          }
        } else if (mats[0]) this._queue(o,mats[0],o.geometry,null,opaque,transparent,camPos);
      } else if (o.isSprite){
        this._tmpV.setFromMatrixPosition(o.matrixWorld);
        transparent.push({o,kind:'sprite',order:o.renderOrder||0,
          depthTest:o.material&&o.material.depthTest!==false,
          dist:camPos.distanceToSquared(this._tmpV)});
      } else if (o.isLine||o.isPoints){
        opaque.push({o,kind:'line',order:o.renderOrder||0,dist:0});
      }
    }
    /* G3D submits opaque geometry in scene order; keep that order so a
     * later-authored part wins the LEQUAL test on coplanar faces (the
     * HappyHome stair treads over their blue risers). */
    opaque.sort((a,b)=> a.order-b.order);
    transparent.sort((a,b)=>{
      if (a.order!==b.order) return a.order-b.order;
      if (a.depthTest!==b.depthTest) return a.depthTest? -1:1;
      return b.dist-a.dist;
    });
    for (const it of opaque){
      if (it.kind==='line') this._drawLine(it.o);
      else this._drawMesh(it.o,it.mat,it.geo,it.group);
    }
    for (const it of transparent){
      if (it.kind==='sprite') this._drawSprite(it.o);
      else this._drawMesh(it.o,it.mat,it.geo,it.group);
    }
    this.info.render.calls=d.stats.draws;
    this.info.render.triangles=Math.round(d.stats.triangles);
    this.info.render.frame++;
  }

  _queue(o,mat,geo,group,opaque,transparent,camPos){
    const tr=!!mat.transparent;
    const center=this._tmpV;
    if (geo&&geo.boundingSphere==null){
      try { geo.computeBoundingSphere(); } catch(_){}
    }
    if (geo&&geo.boundingSphere) center.copy(geo.boundingSphere.center).applyMatrix4(o.matrixWorld);
    else center.setFromMatrixPosition(o.matrixWorld);
    const dist=camPos.distanceToSquared(center);
    const item={o,mat,geo,group,kind:'mesh',order:o.renderOrder||0,dist,
                depthTest:mat.depthTest!==false};
    (tr?transparent:opaque).push(item);
  }
}

window.RBLXg3d={Device,Renderer,RenderDevice:Device,View:Renderer,
  CULL,DEPTH,BLEND,BLEND_EQ,TEXENV,
  glDepthFunc,glBlendFactor,glBlendEquation,VERT_SRC,FRAG_SRC};
})();
