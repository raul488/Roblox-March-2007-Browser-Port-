/* ============================================================
 * audio.js  SoundService port.
 * The 14 built-in SoundType files are ported verbatim from decomp
 * FUN_00586d90 (the SoundService registration table):
 *   1 bass.wav, 2 collide.wav, 3 glassbreak.wav, 4 switch.wav,
 *   5 clickfast.wav, 6 Rubber band sling shot.wav, 7 pageturn.wav,
 *   8 electronicpingshort.wav, 9 snap.wav, 10 splat.wav,
 *   11 SWITCH3.wav, 12 flashbulb.wav, 13 swoosh.wav, 14 victory.wav
 * Sounds load from content/sounds  or from embedded data URLs
 * (web/js/coreAssets.js) so audio works from file:// too.
 * ============================================================ */
(function(){
"use strict";

const BUILTIN = {
  1:'bass.wav', 2:'collide.wav', 3:'glassbreak.wav', 4:'switch.wav', 5:'clickfast.wav',
  6:'Rubber band sling shot.wav', 7:'pageturn.wav', 8:'electronicpingshort.wav',
  9:'snap.wav', 10:'splat.wav', 11:'SWITCH3.wav', 12:'flashbulb.wav', 13:'swoosh.wav', 14:'victory.wav'
};

class AudioBus {
  constructor(){
    this.ctx=null;
    this.master=null;
    this.buffers=new Map();
    this.pending=new Map();
    this._listener=null;
  }
  ensureCtx(){
    if (!this.ctx){
      const AC=window.AudioContext||window.webkitAudioContext;
      if (!AC) return null;
      try { this.ctx=new AC(); }
      catch(_){ return null; }
      this.master=this.ctx.createGain();
      this.master.gain.value=0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state==='suspended') this.ctx.resume();
    return this.ctx;
  }
  resume(){ this.ensureCtx(); }

  /* FMOD in 0.3.368 calls Channel::set3DAttributes (decomp 0x583f70), so
   * Sound instances are positional.  Keep the WebAudio listener on the
   * camera each frame; Sounds with no world ancestor stay 2D. */
  setListener(pos, forward, up){
    const ctx=this.ensureCtx();
    if (!ctx||!pos) return;
    this._listener={ pos:{x:pos.x,y:pos.y,z:pos.z},
                     forward:forward? {x:forward.x,y:forward.y,z:forward.z}:null,
                     up:up? {x:up.x,y:up.y,z:up.z}:null };
    const L=ctx.listener;
    if (!L) return;
    const f=this._listener.forward||{x:0,y:0,z:-1};
    const u=this._listener.up||{x:0,y:1,z:0};
    if (L.positionX){
      L.positionX.value=pos.x; L.positionY.value=pos.y; L.positionZ.value=pos.z;
      if (L.forwardX){
        L.forwardX.value=f.x; L.forwardY.value=f.y; L.forwardZ.value=f.z;
        L.upX.value=u.x; L.upY.value=u.y; L.upZ.value=u.z;
      }
    } else if (L.setPosition){
      L.setPosition(pos.x,pos.y,pos.z);
      if (L.setOrientation) L.setOrientation(f.x,f.y,f.z,u.x,u.y,u.z);
    }
  }
  _panner(ctx, position){
    const p=ctx.createPanner();
    /* equalpower is the cheap stereo law; FMOD's default 3D curve is an
     * inverse-distance rolloff, which is what the distance model gives. */
    p.panningModel='equalpower';
    p.distanceModel='inverse';
    p.refDistance=10;
    p.maxDistance=10000;
    p.rolloffFactor=1;
    if (p.positionX){ p.positionX.value=position.x; p.positionY.value=position.y; p.positionZ.value=position.z; }
    else if (p.setPosition) p.setPosition(position.x,position.y,position.z);
    return p;
  }

  /* resolve a SoundId-ish name → URL. rbxasset://sounds/x.wav → content/sounds/x.wav
     (the engine's rbxasset root maps 1:1 to the shipped content folder).
     Absolute URLs (http/blob) and embedded data: URLs are returned intact. */
  resolve(name){
    if (typeof name==='number' && BUILTIN[name]) name=BUILTIN[name];
    let url=String(name).replace(/\\/g,'/');
    if (/^rbxasset:\/\//i.test(url)) url='content/'+url.slice('rbxasset://'.length);
    else if (/^(?:data|blob):/i.test(url)) return url;
    else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(url)) return url;
    else if (!/^content\//.test(url)) url='content/sounds/'+url;
    return url;
  }

  load(url){
    /* data URLs (embedded) always work, fetch works over http(s) */
    let b=this.buffers.get(url);
    if (b) return Promise.resolve(b);
    let p=this.pending.get(url);
    if (p) return p;
    const embedded=window.SOUND_DATA&&window.SOUND_DATA[url];
    const dataUrl=embedded || (/^data:/i.test(url)? url : null);
    if (dataUrl){
      /* Embedded sounds are base64 data URLs (shipped SOUND_DATA or a
       * place's <binary>/<hash> Content).  Handing a 700 KB data URL to
       * fetch() decoded it synchronously on the caller's task (the first
       * rocket shot stalled for ~80 ms).  Decode it in a later task with a
       * plain byte loop instead, and only then decodeAudioData. */
      p=new Promise((resolve,reject)=>{
        setTimeout(()=>{
          try {
            const bytes=(window.RBLXxml&&window.RBLXxml.dataUrlBytes)
              ? window.RBLXxml.dataUrlBytes(dataUrl)
              : (()=>{
                  const comma=dataUrl.indexOf(',');
                  const bin=atob(dataUrl.slice(comma+1).replace(/\s+/g,''));
                  const u=new Uint8Array(bin.length);
                  for (let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
                  return u;
                })();
            if (!bytes){ reject(new Error('bad audio data URL')); return; }
            const ctx=this.ensureCtx();
            if (!ctx){ reject(new Error('no audio context')); return; }
            ctx.decodeAudioData(bytes.buffer).then(resolve, reject);
          } catch(e){ reject(e); }
        }, 0);
      });
    } else {
      p=(/^content/.test(url))
        ? fetch(url).then(r=>{ if(!r.ok) throw new Error('404 '+url); return r.arrayBuffer(); })
          .then(ab=> this.ensureCtx().decodeAudioData(ab))
        : fetch(url).then(r=>{ if(!r.ok) throw new Error('404 '+url); return r.arrayBuffer(); })
          .then(ab=> this.ensureCtx().decodeAudioData(ab));
    }
    p=p.then(buf=>{ this.buffers.set(url, buf); this.pending.delete(url); return buf; })
       .catch(err=>{ this.pending.delete(url); throw err; });
    this.pending.set(url, p);
    return p;
  }

  playBuf(buf, opts){
    opts=opts||{};
    const ctx=this.ensureCtx();
    if (!ctx || !buf) return null;
    const src=ctx.createBufferSource();
    src.buffer=buf;
    src.loop=!!opts.loop;
    const g=ctx.createGain();
    g.gain.value=(opts.volume!=null)?opts.volume:1;
    let panner=null;
    if (opts.position && typeof ctx.createPanner==='function'){
      try {
        panner=this._panner(ctx, opts.position);
        src.connect(panner); panner.connect(g);
      } catch(_){ panner=null; }
    }
    if (!panner) src.connect(g);
    g.connect(this.master);
    src.start(0, opts.offset||0);
    return { src, gain:g, panner,
      stop(){ try{src.stop();}catch(_){} },
      setVolume(v){ g.gain.value=v; },
      setPosition(x,y,z){
        if (!panner) return;
        if (panner.positionX){ panner.positionX.value=x; panner.positionY.value=y; panner.positionZ.value=z; }
        else if (panner.setPosition) panner.setPosition(x,y,z);
      } };
  }

  sound(name, opts){
    opts=opts||{};
    const url=this.resolve(name);
    const vol=opts.volume!=null?opts.volume:1;
    return this.load(url).then(buf=>{ if(!opts.mute) this.playBuf(buf,{volume:vol,position:opts.position,loop:opts.loop,onended:opts.onended}); return true; })
                         .catch(()=>false);   // missing file: silent like an engine no-op
  }

  /* persistent loop handle with play/pause  used by the humanoidSound
     port (sRunning, sFreeFalling implement onState(state,sound)) */
  makeLoop(name, opts){
    opts=opts||{};
    const bus=this;
    const url=this.resolve(name);
    const h={
      url, buf:null, src:null, gain:null, panner:null, wanted:false,
      volume:(opts.volume!=null)?opts.volume:0.3,
      position:opts.position||null,
      _ensure(){ return bus.load(url).then(b=>{ h.buf=b; }); },
      play(){
        h.wanted=true;
        h._ensure().then(()=>{
          if (!h.wanted || h.src) return;
          const ctx=bus.ensureCtx(); if (!ctx) return;
          h.src=ctx.createBufferSource(); h.src.buffer=h.buf; h.src.loop=true;
          h.gain=ctx.createGain(); h.gain.gain.value=h.volume;
          if (h.position){
            try {
              h.panner=bus._panner(ctx,h.position);
              h.src.connect(h.panner); h.panner.connect(h.gain);
            } catch(_){ h.panner=null; }
          }
          if (!h.panner) h.src.connect(h.gain);
          h.gain.connect(bus.master);
          h.src.start(0);
        }).catch(()=>{});
      },
      pause(){ h.wanted=false; if (h.src){ try{h.src.stop();}catch(_){} h.src=null; } },
      setVolume(v){ h.volume=v; if (h.gain) h.gain.gain.value=v; },
      setPosition(x,y,z){
        if (x&&typeof x==='object'){ y=x.y; z=x.z; x=x.x; }
        h.position={x:x,y:y,z:z};
        if (!h.panner) return;
        if (h.panner.positionX){ h.panner.positionX.value=x; h.panner.positionY.value=y; h.panner.positionZ.value=z; }
        else if (h.panner.setPosition) h.panner.setPosition(x,y,z);
      }
    };
    return h;
  }
}

window.Sounds=new AudioBus();
window.addEventListener('pointerdown', ()=>window.Sounds.resume(), {passive:true});
window.addEventListener('keydown', ()=>window.Sounds.resume());
})();
