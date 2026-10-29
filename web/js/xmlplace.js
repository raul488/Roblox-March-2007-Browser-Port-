/* ============================================================
 * xmlplace.js  Roblox XML v4 parser (the 2007-era rbxlx/rbxm)
 * One source, validated against the actual 2007 files:
 * Crossroads.rbxl, RobloxHQ.rbxl, HappyHomeInRobloxia.rbxl,
 * TabulaRasa.rbxl, character.rbxm, Rocket.rbxm, SlingshotPellet.rbxm.
 * ============================================================ */
(function(){
"use strict";

function propText(el){
  let s='';
  for (let n=el.firstChild; n; n=n.nextSibling){
    if (n.nodeType===3/*text*/ || n.nodeType===4/*cdata*/ || n.nodeType===8) s += n.nodeValue||'';
  }
  return s;
}
function num(el, d){ const v=parseFloat(propText(el)); return isFinite(v)?v:(d||0); }
function vec3of(el){
  const x=el.querySelector('X'), y=el.querySelector('Y'), z=el.querySelector('Z');
  return { x:num(x), y:num(y), z:num(z) };
}
/* v4 CoordinateFrame: position (X,Y,Z) + 3x3 rotation (R00..R22) */
function cf3of(el){
  const g=t=>{ const x=el.querySelector(t); return x?num(x,0):0; };
  const R=[];
  for (let r=0;r<3;r++) for (let c=0;c<3;c++) R[r*3+c]=g('R'+r+c);
  return { pos:{x:g('X'),y:g('Y'),z:g('Z')}, rot:R };
}
/* Color3 V9 packed AARRGGBB (mined: TopAmbientV9=4291743407=0xFFC06A2F) */
function colorFromV9(u){
  u=u>>>0;
  return { r:((u>>>16)&255)/255, g:((u>>>8)&255)/255, b:(u&255)/255, a:((u>>>24)&255)/255, raw:u };
}
/* 2047-style asset url: engine's rbxasset:// prefix map (rbxasset://textures\x.png) */
function assetMap(u){
  u=String(u).replace(/\\/g,'/');
  if (u.indexOf('rbxasset://')!==0) return u;
  /* rbxasset directories ship lowercase in content/ (fonts/textures/sounds/
   * sky)  the exe is case-insensitive, file systems aren't */
  return ('content/'+u.slice('rbxasset://'.length))
    .replace(/^content\/(fonts|textures|sounds|sky)\//i, s=>s.toLowerCase());
}

/* ============================================================
 * Base64 content cache (2007 place archive format).
 * A place stores each embedded asset ONCE as <Content><binary>, and every
 * duplicate reference uses <Content><hash>MD5</hash>.  The hash is the
 * asset's MD5 written as per-byte hex with leading zeros omitted (so a
 * digest containing 0x0e serializes as "e").  Build a cache keyed by both
 * padded and unpadded MD5 while parsing, then resolve all hash references
 * after the tree exists.
 * ========================================================== */
function base64Bytes(b64){
  const s=atob(String(b64||'').replace(/\s+/g,''));
  const n=s.length, out=new Uint8Array(n);
  for (let i=0;i<n;i++) out[i]=s.charCodeAt(i);
  return out;
}
/* compact MD5 (bytes -> 16-byte digest); the engine's content hash is MD5 */
function md5Bytes(bytes){
  const n=bytes.length;
  const padded=(((n+8)>>6)+1)*64;
  const buf=new Uint8Array(padded);
  buf.set(bytes);
  buf[n]=0x80;
  const dv=new DataView(buf.buffer);
  const bits=n*8;
  dv.setUint32(padded-8, bits>>>0, true);
  dv.setUint32(padded-4, Math.floor(bits/0x100000000), true);
  const S=[7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
           5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
           4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
           6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K=new Array(64);
  for (let i=0;i<64;i++) K[i]=Math.floor(Math.abs(Math.sin(i+1))*0x100000000)|0;
  let a0=0x67452301, b0=0xefcdab89, c0=0x98badcfe, d0=0x10325476;
  const M=new Int32Array(16);
  for (let off=0; off<padded; off+=64){
    for (let i=0;i<16;i++) M[i]=dv.getInt32(off+i*4,true);
    let A=a0, B=b0, C=c0, D=d0;
    for (let i=0;i<64;i++){
      let F, g;
      if (i<16){ F=(B&C)|(~B&D); g=i; }
      else if (i<32){ F=(D&B)|(~D&C); g=(5*i+1)&15; }
      else if (i<48){ F=B^C^D; g=(3*i+5)&15; }
      else { F=C^(B|~D); g=(7*i)&15; }
      const tmp=D; D=C; C=B;
      const sum=(A+F+K[i]+M[g])|0;
      B=(B+((sum<<S[i])|(sum>>>(32-S[i]))))|0;
      A=tmp;
    }
    a0=(a0+A)|0; b0=(b0+B)|0; c0=(c0+C)|0; d0=(d0+D)|0;
  }
  const out=new Uint8Array(16);
  const od=new DataView(out.buffer);
  od.setInt32(0,a0,true); od.setInt32(4,b0,true); od.setInt32(8,c0,true); od.setInt32(12,d0,true);
  return out;
}
function md5Keys(bytes){
  const d=md5Bytes(bytes);
  let padded='', unpadded='';
  for (const b of d){ const h=b.toString(16); padded+=(b<16?'0':'')+h; unpadded+=h; }
  return [padded, unpadded];
}
/* best-effort mime type for an embedded payload (the archive often omits
 * mimeType; browsers sniff images but the property tells us the asset class) */
function sniffBase64Mime(b64){
  try {
    const head=atob(String(b64).replace(/\s+/g,'').slice(0,64));
    if (head.startsWith('\x89PNG')) return 'image/png';
    if (head.startsWith('\xFF\xD8\xFF')) return 'image/jpeg';
    if (head.startsWith('GIF8')) return 'image/gif';
    if (head.startsWith('RIFF') && head.slice(8,12)==='WAVE') return 'audio/wav';
    if (head.startsWith('RIFF') && head.slice(8,12)==='WEBP') return 'image/webp';
    if (head.startsWith('OggS')) return 'audio/ogg';
    if (head.startsWith('ID3')) return 'audio/mpeg';
    if (head.charCodeAt(0)===0xFF && (head.charCodeAt(1)&0xE0)===0xE0) return 'audio/mpeg';
    if (head.startsWith('BM')) return 'image/bmp';
    if (/^(version\s|<\?xml|<roblox|<\!--)/i.test(head)) return 'text/plain';
  } catch(_){}
  return null;
}
function hintMimeFor(name){
  const n=String(name||'');
  if (/Sound/i.test(n)) return 'audio/wav';
  if (/Mesh/i.test(n)) return 'text/plain';
  if (/(Texture|Graphic|Icon|Image|Sky|Decal|Face|Shirt|Pants)/i.test(n)) return 'image/png';
  return null;
}
/* raw base64 in a text <url> (some exporters put the payload there) */
function rawBase64Mime(s){
  const t=String(s).replace(/\s+/g,'');
  if (t.length<64 || t.length%4!==0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  return sniffBase64Mime(t);
}
function contentUrlFromString(str, propName){
  const u=String(str||'').trim();
  if (!u) return '';
  if (/^data:/i.test(u)) return u;
  const mime=rawBase64Mime(u);
  if (mime) return 'data:'+mime+';base64,'+u.replace(/\s+/g,'');
  return assetMap(u);
}
function dataUrlBytes(url){
  const s=String(url||'');
  const comma=s.indexOf(',');
  if (comma<0) return null;
  const meta=s.slice(0,comma), payload=s.slice(comma+1);
  let bin;
  if (/;base64/i.test(meta)) bin=atob(payload.replace(/\s+/g,''));
  else {
    try { bin=decodeURIComponent(payload); } catch(_){ bin=payload; }
  }
  const n=bin.length, out=new Uint8Array(n);
  for (let i=0;i<n;i++) out[i]=bin.charCodeAt(i);
  return out;
}
function dataUrlText(url){
  const b=dataUrlBytes(url);
  if (!b) return null;
  if (typeof TextDecoder!=='undefined') return new TextDecoder('utf-8').decode(b);
  let s='';
  for (let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]);
  return s;
}

class RbxInstance {
  constructor(cls, ref){
    this.cls=cls; this.ref=ref||null;
    this.props={};       // parsed primitives
    this.children=[];
    this.parent=null;
    this.tag=null;       // <Extra> escape hatch (xml tags/ProtectedString forms)
  }
  findFirst(name){
    for (const c of this.children) if (c.props.Name===name) return c;
    return null;
  }
  childrenOf(cls){
    return this.children.filter(c=>c.cls===cls);
  }
}

function parseProps(propsEl, ctx){
  const out={};
  ctx=ctx||{ cache:new Map(), pending:[] };
  for (const n of propsEl.children){
    if (n.nodeType!==1) continue;
    const tag=n.nodeName, name=n.getAttribute('name');
    if (!name) continue;
    if (tag==='string' || tag==='ProtectedString'){
      out[name]=propText(n);
    } else if (tag==='bool'){
      out[name]=(propText(n).trim()==='true');
    } else if (tag==='int'||tag==='float'||tag==='double'){
      const v=num(n,0); out[name]=v;
    } else if (tag==='token'){
      out[name]=parseInt(propText(n).trim(),10)||0;
    } else if (tag==='Vector3'){
      out[name]=vec3of(n);
    } else if (tag==='Vector2'){
      out[name]={x:num(n.querySelector('X')), y:num(n.querySelector('Y'))};
    } else if (tag==='CoordinateFrame'){
      out[name]=cf3of(n);
    } else if (tag==='Color3'||tag==='Color3uint8'){
      const t=propText(n).trim();
      out[name]=/^\d+$/.test(t) ? colorFromV9(parseInt(t,10)) : {r:0,g:0,b:0};
    } else if (tag==='Ref'){
      const t=propText(n).trim();
      out[name]=(t===''||t==='null')?null:t;
    } else if (tag==='Content'){
      const binEl=n.querySelector('binary');
      const hashEl=n.querySelector('hash');
      const urlEl=n.querySelector('url');
      const mimeAttr=(n.getAttribute('mimeType')||
                      (binEl&&binEl.getAttribute('xmime:contentType'))||
                      (hashEl&&hashEl.getAttribute('mimeType'))||'').trim().toLowerCase();
      if (binEl){
        const b64=propText(binEl).replace(/\s+/g,'');
        const mime=mimeAttr||sniffBase64Mime(b64)||hintMimeFor(name)||'application/octet-stream';
        let rec=null;
        try {
          const keys=md5Keys(base64Bytes(b64));
          rec=ctx.cache.get(keys[0]);
          if (!rec){
            rec={ b64, mime, url:'data:'+mime+';base64,'+b64 };
            for (const k of keys) ctx.cache.set(k, rec);
          }
        } catch(_){
          rec={ b64, mime, url:'data:'+mime+';base64,'+b64 };
        }
        out[name]={ binary:rec.url };
      } else if (hashEl){
        /* duplicate asset: the archive stored this binary once and the
         * property references it by the MD5 content hash */
        const h=propText(hashEl).trim().toLowerCase();
        const rec=ctx.cache.get(h);
        if (rec){
          const mime=mimeAttr||rec.mime||'application/octet-stream';
          out[name]={ binary: (mime===rec.mime)? rec.url : 'data:'+mime+';base64,'+rec.b64 };
        } else if (urlEl){
          /* missing from this file: keep the URL as a fallback, but still
           * let a later <binary> resolve the hash */
          out[name]={ url:contentUrlFromString(propText(urlEl).trim(), name) };
          ctx.pending.push({ props:out, name, hash:h, mime:mimeAttr });
        } else {
          out[name]=null;
          ctx.pending.push({ props:out, name, hash:h, mime:mimeAttr });
        }
      } else if (urlEl){
        out[name]={ url:contentUrlFromString(propText(urlEl).trim(), name) };
      } else out[name]=null;
    } else if (tag==='Axes' || tag==='Faces' || tag==='int64'){
      // flag-sum enums (JointSurface Axes/Faces) and 64-bit ints serialize
      // as plain integer text in v4 XML
      out[name]=parseInt(propText(n).trim(),10)||0;
    } else if (tag==='Vector3int16'){
      out[name]=vec3of(n);
    } else if (tag==='OptionalCoordinateFrame'){
      // joints store their C0/C1 here: either a nested frame or a legacy
      // comma list "1,0,0,0,..."
      const cfEl=n.querySelector('CoordinateFrame');
      if (cfEl) out[name]=cf3of(cfEl);
      else {
        const p=propText(n).split(',').map(Number);
        out[name]=(p.length>=12)?{ pos:{x:p[3],y:p[7],z:p[11]},
          rot:[p[0],p[1],p[2],p[4],p[5],p[6],p[8],p[9],p[10]] }:{pos:{x:0,y:0,z:0},rot:[1,0,0,0,1,0,0,0,1]};
      }
    } else if (tag==='BinaryString'){
      out[name]=propText(n).trim();
    } else if (tag==='Font'){
      out[name]={ family:n.getAttribute('family'), bold:propText(n).trim()==='true' };
    } else {
      out['@'+name]=propText(n).trim();
    }
  }
  return out;
}

function parseRbx(text){
  const doc=new DOMParser().parseFromString(text,'application/xml');
  const root=doc.documentElement;
  if (!root || root.nodeName!=='roblox'){
    const pe=doc.querySelector('parsererror');
    throw new Error('not a roblox XML file'+(pe? ': '+String(pe.textContent).trim().slice(0,200) : ''));
  }
  /* Every <Item> is registered exactly once: handle() registers `el` itself,
   * then recurses into its <Item> children. (An earlier version called walk()
   * on the child element, which registered only its grandchildren and silently
   * dropped every other nesting level  caught by the headless test suite.) */
  const instances=[], byRef=new Map();
  /* embedded-asset hash cache (Content <binary>/<hash>), see parseProps */
  const contentCache=new Map(), pendingHashes=[];
  function handle(el, parent){
    const cls=el.getAttribute('class')||'', ref=el.getAttribute('referent');
    const it=new RbxInstance(cls,ref);
    if (ref) byRef.set(ref,it);
    it.parent=parent;
    it.refs={};                 // <Ref name="...">referent</Ref>
    instances.push(it);
    for (const c of el.children){
      if (c.nodeType!==1) continue;
      if (c.nodeName==='Properties'){
        it.props=parseProps(c, {cache:contentCache, pending:pendingHashes});
        for (const p of c.children){
          if (p.nodeType!==1 || p.nodeName!=='Ref') continue;
          const nm=p.getAttribute('name');
          if (nm) it.refs[nm]=propText(p).trim();
        }
      } else if (c.nodeName==='Item') handle(c,it);
    }
    if (parent) parent.children.push(it);
    return it;
  }
  for (const el of root.children){
    if (el.nodeType===1 && el.nodeName==='Item') handle(el,null);
  }
  /* Duplicate-asset hash references are resolved after every <binary> in
   * the file has been hashed and cached (forward refs are normal). */
  for (const p of pendingHashes){
    const rec=contentCache.get(p.hash);
    if (!rec) continue;
    const mime=p.mime||rec.mime||'application/octet-stream';
    p.props[p.name]={ binary:(mime===rec.mime)? rec.url : 'data:'+mime+';base64,'+rec.b64 };
  }
  /* Resolve object references after the whole tree exists (forward refs are
   * common: Model.PrimaryPart points at a later Part).  props[name] becomes
   * the RbxInstance itself; the bridge wraps it on read. */
  for (const it of instances){
    if (!it.refs) continue;
    for (const nm of Object.keys(it.refs)){
      const r=it.refs[nm];
      if (r===''||r==='null'){ it.props[nm]=null; continue; }
      const target=byRef.get(r);
      if (target) it.props[nm]=target;
    }
  }
  return {doc, root, instances, byRef, deserialize:refs=>({
    *iter(){ /* placeholder */ }
  })};
}
/* resolve a Ref property after load: returns RbxInstance or null */
function resolve(refObj, parsed){ return refObj? (parsed.byRef.get(refObj)||null) : null; }

function* descendants(inst){
  for (const c of inst.children){ yield c; yield* descendants(c); }
}

window.RBLXxml = { parseRbx, resolve, descendants, colorFromV9, vec3of, cf3of, assetMap,
                   contentUrlFromString, dataUrlBytes, dataUrlText, sniffBase64Mime, md5Bytes };
})();
