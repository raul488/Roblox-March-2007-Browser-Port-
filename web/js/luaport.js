/* ============================================================
 * luaport.js  Lua→JS translation layer ("no hardcoded scripts").
 * Lua 5.1-subset interpreter whose executors are generators: a
 * script blocking in wait()/Stepped:wait() suspends the whole call
 * stack and the frame scheduler resumes it exactly there.
 *
 * Supported: full statement/expression grammar for 2007-era scripts
 * (locals, multi-assign, if/while/repeat/fornum/forin, functions
 * incl. a.b:c sugar, varargs, tables with spread, closures,
 * coroutines, pcall/error, metatables, math/string/table subsets,
 * pairs/ipairs/next, wait/spawn/delay).
 * Parse failures throw RBLXlua.Unsupported so scriptport can fall
 * back to its per-script ports instead of dying.
 * ============================================================ */
(function(){
"use strict";

const MT = Symbol('mt');

/* --------------------------- errors ---------------------------- */
class Unsupported extends Error{ constructor(msg){ super(msg); this.unsupported = true; } }
class LuaThrow extends Error{ constructor(v){ super(typeof v==='string'? v : 'runtime error'); this.value = v; } }
function fail(msg){ throw new Unsupported(msg); }

/* --------------------------- lexer ---------------------------- */
const KW = new Set('and break do else elseif end false for function if in local nil not or repeat return then true until while'.split(' '));

function lex(src){
  const toks=[]; let i=0; const n=src.length;
  const isD=c=>c>='0'&&c<='9';
  while (i<n){
    const c=src[i];
    if (c===' '||c==='\t'||c==='\r'||c==='\n'){ i++; continue; }
    /* comments: -- line / --[[…]] / --[=*[…]=*] */
    if (c==='-'&&src[i+1]==='-'){
      let j=i+2;
      if (src[j]==='['){
        let lvl=0,k=j+1;
        while (src[k]==='='){ lvl++; k++; }
        if (src[k]==='['){
          const close=']'+'='.repeat(lvl)+']';
          const end=src.indexOf(close,k+1);
          if (end<0){ i=n; continue; }   /* unterminated = rest of file */
          i=end+close.length; continue;
        }
      }
      while (i<n&&src[i]!=='\n') i++;
      continue;
    }
    /* long strings: [[…]] / [=*[…]=*] */
    if (c==='['&&(src[i+1]==='['||src[i+1]==='=')){
      let lvl=0,k=i+1;
      while (src[k]==='='){ lvl++; k++; }
      if (src[k]==='['){
        const start=k+1;
        const close=']'+'='.repeat(lvl)+']';
        const end=src.indexOf(close,start);
        if (end<0) fail('unterminated long string');
        toks.push({t:'str',v:src.slice(start,end)});
        i=end+close.length; continue;
      }
    }
    /* numbers */
    if (isD(c)||(c==='.'&&isD(src[i+1]))){
      let j=i;
      if (c==='0'&&(src[j+1]==='x'||src[j+1]==='X')){
        j=i+2; while (isD(src[j])||('a'<=src[j]&&src[j]<='f')||('A'<=src[j]&&src[j]<='F')) j++;
        toks.push({t:'num',v:parseInt(src.slice(i,j),16)}); i=j; continue;
      }
      while (isD(src[j])) j++;
      if (src[j]==='.'){ j++; while (isD(src[j])) j++; }
      if (src[j]==='e'||src[j]==='E'){ j++; if (src[j]==='+'||src[j]==='-') j++; while (isD(src[j])) j++; }
      toks.push({t:'num',v:parseFloat(src.slice(i,j))}); i=j; continue;
    }
    /* names / keywords */
    if (/[A-Za-z_]/.test(c)){
      let j=i; while (j<n&&/[A-Za-z0-9_]/.test(src[j])) j++;
      const w=src.slice(i,j);
      toks.push(KW.has(w)? {t:'kw',v:w} : {t:'name',v:w});
      i=j; continue;
    }
    /* quoted strings with escapes */
    if (c==='"'||c==="'"){
      const q=c; let j=i+1, s='';
      while (j<n&&src[j]!==q){
        if (src[j]==='\\'){
          const e=src[j+1]; j+=2;
          if (/^[0-9]$/.test(e)){
            let oct=e; while (j<n&&/[0-9]/.test(src[j])&&oct.length<3){ oct+=src[j]; j++; }
            s+=String.fromCharCode(parseInt(oct,8)); continue;
          }
          s+= e==='n'? '\n' : e==='t'? '\t' : e==='r'? '\r' : e;
          continue;
        }
        s+=src[j]; j++;
      }
      if (j>=n) fail('unterminated string');
      toks.push({t:'str',v:s}); i=j+1; continue;
    }
    /* operators: '...' then '..' then two-char then single */
    if (src.startsWith('...',i)){ toks.push({t:'op',v:'...'}); i+=3; continue; }
    if (src.startsWith('..',i)){ toks.push({t:'op',v:'..'}); i+=2; continue; }
    const two=src.substr(i,2);
    if (two==='=='||two==='~='||two==='<='||two==='>='){ toks.push({t:'op',v:two}); i+=2; continue; }
    if ('+-*/%^#=<>();:,.[]{}'.indexOf(c)>=0){ toks.push({t:'op',v:c}); i++; continue; }
    fail('bad char '+JSON.stringify(c));
  }
  toks.push({t:'eof',v:null});
  return toks;
}

/* --------------------------- parser ---------------------------- */
function parse(src){
  const toks=lex(src);
  let p=0;
  const peek=()=>toks[p];
  const next=()=>toks[p++];
  const eok=op=>{ const t=peek(); if (t.v!==op) fail('expected '+op+', got '+(t.v==null?'EOF':t.v)); return next(); };
  const at=op=>{ const t=peek(); return t.t==='op'&&t.v===op; };
  const atkw=w=>{ const t=peek(); return t.t==='kw'&&t.v===w; };
  const eokw=w=>{ if (!atkw(w)) fail('expected '+w); next(); };
  function expectName(){ const t=peek(); if (t.t!=='name') fail('name expected'); return next().v; }

  function chunk(){ const b=block(); if (peek().t!=='eof') fail('unexpected '+(peek().v==null?'EOF':JSON.stringify(peek().v))+' after end'); return b; }

  function block(){
    const stats=[];
    for(;;){
      const t=peek();
      if (t.t==='eof') break;
      if (t.t==='op'&&t.v===';'){ next(); continue; }
      if (t.t==='kw'){
        if (t.v==='local'){ stats.push(localStat()); continue; }
        if (t.v==='if'||t.v==='while'||t.v==='for'||t.v==='repeat'||t.v==='function'){ stats.push(blockStat()); continue; }
        if (t.v==='do'){ next(); const b=block(); eok('end'); stats.push({k:'doblock',b}); continue; }
        if (t.v==='return'){ next(); const exps=retExps(); finishStmt(); stats.push({k:'return',exps}); break; }
        if (t.v==='break'){ next(); finishStmt(); stats.push({k:'break'}); break; }
        break;                        /* end/else/elseif/until → caller */
      }
      if (t.t==='name'||(t.t==='op'&&t.v==='(')){
        const e=postfix();
        const t2=peek();
        if (t2.t==='op'&&(t2.v==='='||t2.v===',')){ stats.push(assignStat(e)); continue; }
        if (e.k==='call'||e.k==='selfcall'){ stats.push({k:'callstat',e}); finishStmt(); continue; }
        fail('expression has no effects');
      }
      break;
    }
    return {k:'block',stats};
  }
  function finishStmt(){ const t=peek(); if (t.t==='op'&&t.v===';') next(); }
  function retExps(){
    const t=peek();
    if (t.t==='eof'||(t.t==='op'&&t.v===';')||
        (t.t==='kw'&&['end','else','elseif','until'].includes(t.v))) return [];
    return explist();
  }
  function explist(){
    const out=[expr()];
    while (at(',')){ next(); out.push(expr()); }
    return out;
  }

  function localStat(){
    next();                                        /* 'local' */
    if (atkw('function')){
      next();
      const nm=expectName();
      const f=funcBody();
      return {k:'localfunc',name:nm,f};
    }
    const names=[expectName()];
    while (at(',')){ next(); names.push(expectName()); }
    let exps=null;
    if (at('=')){ next(); exps=explist(); }
    finishStmt();
    return {k:'localnames',names,exps};
  }

  function blockStat(){
    const t=peek();
    switch (t.v){
      case 'if': {
        next();
        const arms=[];
        const c=expr(); eok('then');
        arms.push({cond:c,b:block()});
        while (atkw('elseif')){ next(); const cc=expr(); eok('then'); arms.push({cond:cc,b:block()}); }
        let els=null;
        if (atkw('else')){ next(); els=block(); }
        eok('end');
        return {k:'if',arms,els};
      }
      case 'while': { next(); const c=expr(); eok('do'); const b=block(); eok('end'); return {k:'while',c,b}; }
      case 'repeat': { next(); const b=block(); eok('until'); const c=expr(); return {k:'repeat',b,c}; }
      case 'function': {
        next();
        const path=[expectName()];
        let method=false;
        while (at('.')){ next(); path.push(expectName()); }
        if (at(':')){ next(); path.push(expectName()); method=true; }
        const f=funcBody();
        if (method) f.params.names.unshift('self');
        return {k:'funcstat',path,f};
      }
      case 'for': {
        next();
        const v1=expectName();
        if (at('=')){
          next();
          const a=expr(); eok(','); const b=expr();
          let step=null;
          if (at(',')){ next(); step=expr(); }
          eok('do'); const body=block(); eok('end');
          return {k:'fornum',v:v1,a,b,step,body};
        }
        const names=[v1];
        while (at(',')){ next(); names.push(expectName()); }
        eokw('in');
        const exps=explist();
        eok('do'); const body=block(); eok('end');
        return {k:'forin',names,exps,body};
      }
      default: fail('bad statement');
    }
  }

  function funcBody(){
    eok('(');
    const params=parlist();
    eok(')');
    const body=block();
    eok('end');
    return {k:'func',params,body};
  }
  function parlist(){
    if (at(')')) return {names:[],dots:false};
    if (at('...')){ next(); return {names:[],dots:true}; }
    const names=[expectName()];
    while (at(',')){
      next();
      if (at('...')){ next(); return {names,dots:true}; }
      names.push(expectName());
    }
    return {names,dots:false};
  }

  /* precedence: or < and < cmp < concat < addsub < muldiv < unary < pow < postfix */
  function expr(){ return and_or(); }
  function and_or(){
    let a=cmp_expr();
    for(;;){
      const t=peek();
      if (t.t==='kw'&&(t.v==='and'||t.v==='or')){ next(); a={k:t.v,a,b:cmp_expr()}; } else break;
    }
    return a;
  }
  function cmp_expr(){
    let a=concat_expr();
    for(;;){
      const t=peek();
      if (t.t==='op'&&['==','~=','<','>','<=','>='].includes(t.v)){ next(); a={k:'cmp',op:t.v,a,b:concat_expr()}; } else break;
    }
    return a;
  }
  function concat_expr(){
    const a=addsub();
    if (at('..')){ next(); const b=concat_expr(); return {k:'concat',a,b}; }   /* right assoc */
    return a;
  }
  function addsub(){
    let a=muldiv();
    for(;;){
      const t=peek();
      if (t.t==='op'&&(t.v==='+'||t.v==='-')){ next(); a={k:'arith',op:t.v,a,b:muldiv()}; } else break;
    }
    return a;
  }
  function muldiv(){
    let a=unary();
    for(;;){
      const t=peek();
      if (t.t==='op'&&(t.v==='*'||t.v==='/'||t.v==='%')){ next(); a={k:'arith',op:t.v,a,b:unary()}; } else break;
    }
    return a;
  }
  function unary(){
    const t=peek();
    if (t.t==='kw'&&t.v==='not'){ next(); return {k:'not',a:unary()}; }
    if (t.t==='op'&&t.v==='#'){ next(); return {k:'len',a:unary()}; }
    if (t.t==='op'&&t.v==='-'){ next(); return {k:'neg',a:unary()}; }
    return pow_expr();
  }
  function pow_expr(){
    const a=postfix();
    if (at('^')){ next(); return {k:'arith',op:'^',a,b:unary()}; }   /* right assoc */
    return a;
  }
  function postfix(){
    let e=primexp();
    for(;;){
      const t=peek();
      if (t.t==='op'&&t.v==='.'){ next(); e={k:'member',o:e,prop:expectName()}; }
      else if (t.t==='op'&&t.v==='['){ next(); const idx=expr(); eok(']'); e={k:'index',o:e,idx}; }
      else if (t.t==='op'&&t.v===':'){
        next(); const m=expectName();
        if (at('(')){ e={k:'selfcall',o:e,m,args:callArgs()}; }
        else if (peek().t==='str'){ e={k:'selfcall',o:e,m,args:[{k:'str',v:next().v}]}; }
        else if (at('{')){ e={k:'selfcall',o:e,m,args:[tablector()]}; }
        else fail('expected call after :'+m);
      }
      else if (t.t==='op'&&t.v==='('){ e={k:'call',e,args:callArgs()}; }
      else if (t.t==='str'){ e={k:'call',e,args:[{k:'str',v:next().v}]}; }
      else if (t.t==='op'&&t.v==='{'){ e={k:'call',e,args:[tablector()]}; }
      else break;
    }
    return e;
  }
  function callArgs(){
    eok('(');
    const a=at(')')?[]:explist();
    eok(')');
    return a;
  }
  function primexp(){
    const t=peek();
    if (t.t==='num'){ next(); return {k:'num',v:t.v}; }
    if (t.t==='str'){ next(); return {k:'str',v:t.v}; }
    if (t.t==='kw'){
      next();
      if (t.v==='nil') return {k:'nil'};
      if (t.v==='true') return {k:'bool',v:true};
      if (t.v==='false') return {k:'bool',v:false};
      if (t.v==='function') return funcBody();
      fail('unexpected '+t.v);
    }
    if (t.t==='op'){
      if (t.v==='...'){ next(); return {k:'vararg'}; }
      if (t.v==='('){ next(); const e=expr(); eok(')'); e.parens=true; return e; }
      if (t.v==='{') return tablector();
    }
    if (t.t==='name'){ next(); return {k:'name',v:t.v}; }
    fail('unexpected '+(t.v==null?'EOF':JSON.stringify(t.v)));
  }
  function tablector(){
    eok('{');
    const rows=[];
    while (!at('}')){
      if (at('[')){ next(); const kk=expr(); eok(']'); eok('='); rows.push({kk,vv:expr(),array:false}); }
      else {
        const t=peek();
        if (t.t==='name'&&toks[p+1].t==='op'&&toks[p+1].v==='='){
          const nm=next().v; next(); rows.push({kk:{k:'str',v:nm},vv:expr(),array:false});
        } else {
          rows.push({vv:expr(),array:true});
        }
      }
      if (at(',')||at(';')){ next(); } else break;
    }
    eok('}');
    return {k:'table',rows};
  }
  function assignStat(e0){
    const targets=[e0];
    while (at(',')){ next(); targets.push(postfix()); }
    eok('=');
    const exps=explist();
    finishStmt();
    return {k:'assign',targets,exps};
  }

  return chunk();
}

/* --------------------------- values ---------------------------- */
class LuaTable{
  constructor(){ this.a=[undefined]; this.h=new Map(); this.mt=null; this.id=tableSeq++; }
  _find(k){
    const stored=LuaTable.key(k);
    const e=this.h.get(stored);
    if (e!==undefined) return e;
    if (typeof k==='number'&&Number.isInteger(k)&&k>=1&&k<this.a.length)
      return {k,v:this.a[k]};
    return null;
  }
  get(k){
    if (k===undefined||k===null) return undefined;
    const e=this._find(k);
    return e? e.v : undefined;
  }
  set(k,v){
    if (k===undefined||k===null) throw new LuaThrow('table index is nil');
    const stored=LuaTable.key(k);
    const e=this.h.get(stored);
    if (typeof k==='number'&&Number.isInteger(k)&&k>=1){
      if (v===undefined||v===null){
        this.a[k]=undefined;                       /* mark hole (extends if trailing) */
        while (this.a.length>1&&this.a[this.a.length-1]===undefined) this.a.pop();
        if (e) this.h.delete(stored);
        return;
      }
      if (k<this.a.length){ this.a[k]=v; return; }
      if (k===this.a.length){ this.a[k]=v; return; }   /* append: a[k] extends */
    }
    if (v===undefined||v===null){ if (e) this.h.delete(stored); return; }
    this.h.set(stored,{k,v});
  }
  get length(){
    let n=this.a.length;
    while (n>0&&this.a[n]===undefined) n--;
    return n;
  }
  Arr(){ const out=[]; for (let i=1;i<this.a.length;i++) if (this.a[i]!==undefined) out.push(this.a[i]); return out; }
}
let tableSeq=1;
LuaTable.key=function(x){
  switch (typeof x){
    case 'number': return '#n'+x;
    case 'string': return '#s'+x;
    case 'boolean': return '#b'+x;
    default: return x;
  }
};
/* next: iterative protocol used by next()/pairs(); array part first */
LuaTable.next=function(t,k){
  if (k===undefined||k===null){
    if (t.a.length>1&&t.a[1]!==undefined) return [1,t.a[1]];
    return hashFirst(t);
  }
  if (typeof k==='number'&&Number.isInteger(k)&&k>=1){
    /* scan forward past holes to the next present array entry */
    if (k+1<t.a.length){
      for (let i=k+1;i<t.a.length;i++){
        if (t.a[i]!==undefined) return [i,t.a[i]];
      }
    }
  }
  const stored=LuaTable.key(k);
  const ks=[...t.h.keys()];
  const idx=ks.indexOf(stored);
  for (let i=idx+1;i<ks.length;i++){ const e=t.h.get(ks[i]); return [e.k,e.v]; }
  return [undefined];
  function hashFirst(tt){
    const ks=[...tt.h.keys()];
    if (ks.length){ const e=tt.h.get(ks[0]); return [e.k,e.v]; }
    return [undefined];
  }
};

function truthy(v){ return !(v===undefined||v===null||v===false); }
function typeName(v){
  if (v===undefined||v===null) return 'nil';
  if (typeof v==='boolean') return 'boolean';
  if (typeof v==='number') return 'number';
  if (typeof v==='string') return 'string';
  if (v instanceof LuaTable) return 'table';
  if (v&&typeof v==='object'){
    if (v.__co) return 'thread';
    if (v.lua) return 'function';
    if (v.__luaType) return v.__luaType;
    return 'userdata';
  }
  if (typeof v==='function') return 'function';
  return 'userdata';
}
function fmtNum(x){
  if (!isFinite(x)){
    if (Number.isNaN(x)) return 'nan';
    return x>0? 'inf' : '-inf';
  }
  if (Number.isInteger(x)&&Math.abs(x)<1e15) return String(x);
  const p=Number(x.toPrecision(14));
  return String(p);
}
function tostring(v,seen){
  seen=seen||new Set();
  if (v===undefined||v===null) return 'nil';
  if (typeof v==='string') return v;
  if (typeof v==='boolean') return v?'true':'false';
  if (typeof v==='number') return fmtNum(v);
  if (v instanceof LuaTable||(v&&typeof v==='object')){
    const mt=getMT(v);
    if (mt){
      const ts=mtGet(mt,'__tostring');
      if (ts){
        let out=null;
        if (typeof ts==='function'&&!ts.gen){
          const r=ts([v]);
          if (r&&r.length) out=r[0];
        } else if ((ts&&ts.lua)||typeof ts==='function'){
          /* drive a pure closure synchronously; bail if it yields */
          try {
            const ip=SCHED.interp;
            if (ip){
              const r=syncCall(ip,ts,[v]);
              if (r&&r.length) out=r[0];
            }
          } catch(_){}
        }
        if (typeof out==='string') return out;
      }
    }
    if (seen.has(v)) return '(cycle)';
    seen.add(v);
    return typeName(v)+': 0x'+(v.id||((Math.random()*0xffffff)|0)).toString(16);
  }
  if (typeof v==='function') return 'function: builtin';
  return String(v);
}
function tonumber(v){
  if (typeof v==='number') return v;
  if (typeof v==='string'){
    const s=v.trim();
    if (/^[-+]?0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s,16);
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
    return null;
  }
  return null;
}
function getMT(v){
  if (v instanceof LuaTable) return v.mt;
  if (v&&typeof v==='object') return v[MT]||null;
  return null;
}
/* meta lookup works for LuaTable metatables AND plain bridge MT objects */
function mtGet(mt,k){ return mt instanceof LuaTable? mt.get(k) : (mt? mt[k] : undefined); }
const MTNAME={'+':'__add','-':'__sub','*':'__mul','/':'__div','%':'__mod','^':'__pow'};
function luaEq(a,b){
  if (a===b) return true;
  if ((a===null||a===undefined)&&(b===null||b===undefined)) return true;
  return false;
}
function mkNative(fn,gen){ if (gen) fn.gen=true; return fn; }
/* string metatable target (set up by installStd; indexable before that) */
let STR_TABLE=new LuaTable();
/* drive an interpreter call synchronously; returns result array, or
 * null if the call attempted to yield (those need the scheduler) */
function syncCall(ip,f,args){
  const gen=ip.callValue(f,args);   /* generator object  not started yet */
  const first=gen.next();
  return first.done? first.value : null;
}

/* --------------------------- interpreter ------------------------ */
/* every executor is a generator; yield* composition gives fiber
 * semantics. Yields pass tagged objects to the scheduler:
 *   {t:'wait', d}     sleep d seconds (next tick when d<=0)
 *   {t:'coyield', v}  coroutine.yield
 *   {t:'spin'}        cooperative breather for long loops          */
class Interp{
  constructor(globals,sched){
    this.G=globals;            /* LuaTable  _G */
    this.sched=sched;
  }

  /* ---- indexing (meta __index may call lua  generator form) ---- */
  *rawIndex(o,k){
    if (o instanceof LuaTable){
      const v=o.get(k);
      if (v!==undefined) return v;
      const mt=o.mt;
      if (mt){
        const h=mtGet(mt,'__index');
        if (h!==undefined&&(typeof h==='function'||h instanceof LuaTable)){
          if (typeof h==='function') return (yield* this.callValue(h,[o,k]))[0];
          return h.get(k);
        }
      }
      return undefined;
    }
    if (typeof o==='string'){
      /* string metatable: ("abc"):upper(), s:len(), s:sub() … */
      const v=STR_TABLE.get(k);
      if (v!==undefined) return v;
      return undefined;
    }
    if (o&&typeof o==='object'){
      const imt=o[MT];
      if (imt){
        const h=imt.__index;
        if (typeof h==='function'){
          const r=yield* this.callValue(h,[o,k]);
          return r&&r.length? r[0] : undefined;
        }
        return undefined;
      }
      const v=o[k];
      return v===undefined? undefined : v;
    }
    throw new LuaThrow('attempt to index a '+typeName(o)+' value');
  }
  *rawNewindex(o,k,v){
    if (o instanceof LuaTable){
      const mt=o.mt;
      if (mt){
        const h=mtGet(mt,'__newindex');
        if (h!==undefined&&(typeof h==='function'||h instanceof LuaTable)){
          if (typeof h==='function'){ yield* this.callValue(h,[o,k,v]); return; }
          h.set(k,v); return;
        }
      }
      o.set(k,v); return;
    }
    if (o&&typeof o==='object'){
      const imt=o[MT];
      if (imt){
        if (typeof imt.__newindex==='function'){ yield* this.callValue(imt.__newindex,[o,k,v]); return; }
        if (imt.__newindex===null) return;          /* bridge forbids writes */
      }
    }
    throw new LuaThrow('attempt to assign into a '+typeName(o)+' value');
  }

  /* ---- calls ---- */
  *callValue(f,args){
    if (typeof f==='function'){
      if (f.gen) return (yield* f(this,args))||[];
      const prevIp=CALL_IP; CALL_IP=this;
      try{
        const out=f(args);
        return Array.isArray(out)? out : (out===undefined? [] : [out]);
      } finally { CALL_IP=prevIp; }
    }
    if (f&&f.lua) return yield* this.callLua(f,args);
    if (f&&f.__co) throw new LuaThrow('attempt to call a thread value');
    if (f instanceof LuaTable||(f&&typeof f==='object')){
      const mt=getMT(f);
      if (mt){
        const c=mtGet(mt,'__call');
        if (c!==undefined&&(typeof c==='function'||c&&c.lua))
          return yield* this.callValue(c,[f,...args]);
      }
    }
    throw new LuaThrow('attempt to call a '+typeName(f)+' value');
  }
  *callLua(lf,args){
    const sc=newScope(lf.env);
    const ps=lf.params;
    for (let i=0;i<ps.names.length;i++) sc.vars.set(ps.names[i], i<args.length? args[i] : undefined);
    if (ps.dots) sc.dots=args.slice(ps.names.length);
    const r=yield* this.execBlock(lf.body,sc);
    return (r&&r.ret)? r.ret : [];
  }

  /* ---- statements ---- */
  *execBlock(b,sc){
    for (const st of b.stats){
      const r=yield* this.execStat(st,sc);
      if (r&&(r.brk||r.ret)) return r;
    }
    return null;
  }
  *execStat(st,sc){
    switch (st.k){
      case 'localnames': {
        let vals=[];
        if (st.exps) vals=yield* this.evalList(st.exps,sc);
        for (let i=0;i<st.names.length;i++) sc.vars.set(st.names[i], i<vals.length? vals[i] : undefined);
        return null;
      }
      case 'localfunc': {
        sc.vars.set(st.name,undefined);
        const f={lua:true,params:st.f.params,body:st.f.body,env:sc,name:st.name};
        sc.vars.set(st.name,f);
        return null;
      }
      case 'funcstat': {
        const first=st.path[0];
        const owner=scopeLookup(sc,first);
        let obj=owner? owner.vars.get(first) : undefined;
        if (st.path.length===1){
          /* function name() end === name = function  create if missing */
          const f0={lua:true,params:st.f.params,body:st.f.body,env:sc,name:first};
          if (owner) owner.vars.set(first,f0); else this.G.set(first,f0);
          return null;
        }
        if (obj===undefined||obj===null) obj=(yield* this.rawIndex(this.G,first));
        if (obj===undefined||obj===null)
          throw new LuaThrow("attempt to index nil (defining '"+st.path.join('.')+"')");
        for (let i=1;i<st.path.length;i++){
          const nm=st.path[i];
          if (i===st.path.length-1){
            const f={lua:true,params:st.f.params,body:st.f.body,env:sc,name:nm};
            yield* this.rawNewindex(obj,nm,f);
          } else {
            let nxt=(yield* this.rawIndex(obj,nm));
            if (nxt===undefined||nxt===null){ nxt=new LuaTable(); yield* this.rawNewindex(obj,nm,nxt); }
            obj=nxt;
          }
        }
        return null;
      }
      case 'assign': {
        const vals=(yield* this.evalList(st.exps,sc));
        for (let i=0;i<st.targets.length;i++){
          const tgt=st.targets[i];
          const v=i<vals.length? vals[i] : undefined;
          if (tgt.k==='name'){
            const s=scopeLookup(sc,tgt.v);
            if (s) s.vars.set(tgt.v,v); else this.G.set(tgt.v,v);
          } else if (tgt.k==='member'){
            const obj=(yield* this.evalOne(tgt.o,sc));
            yield* this.rawNewindex(obj,tgt.prop,v);
          } else if (tgt.k==='index'){
            const obj=(yield* this.evalOne(tgt.o,sc));
            const key=(yield* this.evalOne(tgt.idx,sc));
            yield* this.rawNewindex(obj,key,v);
          } else fail('cannot assign to '+tgt.k);
        }
        return null;
      }
      case 'callstat': { yield* this.evalOne(st.e,sc); return null; }
      case 'if': {
        for (const arm of st.arms){
          if (truthy((yield* this.evalOne(arm.cond,sc))))
            return yield* this.execBlock(arm.b,newScope(sc));
        }
        if (st.els) return yield* this.execBlock(st.els,newScope(sc));
        return null;
      }
      case 'while': {
        let n=0;
        for(;;){
          if (!truthy((yield* this.evalOne(st.c,sc)))) break;
          const r=yield* this.execBlock(st.b,newScope(sc));
          if (r&&r.brk) break;
          if (r&&r.ret) return {ret:r.ret};
          if (++n%4096===0) yield {t:'spin'};
        }
        return null;
      }
      case 'repeat': {
        const sc2=newScope(sc);       /* shared so until() sees body locals */
        let n=0;
        for(;;){
          const r=yield* this.execBlock(st.b,sc2);
          if (r&&r.brk) break;
          if (r&&r.ret) return {ret:r.ret};
          if (truthy((yield* this.evalOne(st.c,sc2)))) break;
          if (++n%4096===0) yield {t:'spin'};
        }
        return null;
      }
      case 'fornum': {
        const a=+(yield* this.evalOne(st.a,sc));
        const b=+(yield* this.evalOne(st.b,sc));
        let step=1; if (st.step) step=+(yield* this.evalOne(st.step,sc));
        if (!Number.isFinite(a)||!Number.isFinite(b)||!Number.isFinite(step))
          throw new LuaThrow("'for' bounds must be numbers");
        if (step===0) throw new LuaThrow("'for' step is zero");
        for (let v=a; step>0? v<=b : v>=b; v+=step){
          const isc=newScope(sc);
          isc.vars.set(st.v,v);
          const r=yield* this.execBlock(st.body,isc);
          if (r&&r.brk) break;
          if (r&&r.ret) return {ret:r.ret};
        }
        return null;
      }
      case 'forin': {
        const ex=yield* this.evalList(st.exps,sc);
        const f=ex[0];
        const s=ex.length>1? ex[1] : undefined;
        let ctrl=ex.length>2? ex[2] : undefined;
        for(;;){
          const rv=(yield* this.callValue(f,[s,ctrl]));
          if (!truthy(rv[0])) break;
          ctrl=rv[0];
          const isc=newScope(sc);
          for (let i=0;i<st.names.length;i++) isc.vars.set(st.names[i], i<rv.length? rv[i] : undefined);
          const r=yield* this.execBlock(st.body,isc);
          if (r&&r.brk) break;
          if (r&&r.ret) return {ret:r.ret};
        }
        return null;
      }
      case 'doblock': return yield* this.execBlock(st.b,newScope(sc));
      case 'break': return {brk:true};
      case 'return': {
        const vals=st.exps? (yield* this.evalList(st.exps,sc)) : [];
        return {ret:vals};
      }
      default: fail('stat '+st.k);
    }
  }

  /* ---- expressions ---- */
  *evalList(exps,sc){
    const out=[];
    for (let i=0;i<exps.length;i++){
      const e=exps[i];
      const spreadable=(e.k==='call'||e.k==='selfcall'||e.k==='vararg')&&!e.parens;
      if (i===exps.length-1&&spreadable) out.push(...(yield* this.evalMulti(e,sc)));
      else out.push((yield* this.evalOne(e,sc)));
    }
    return out;
  }
  *evalMulti(e,sc){
    if (e.parens&&(e.k==='call'||e.k==='selfcall'||e.k==='vararg'))
      return [(yield* this.evalOne(e,sc))];
    switch (e.k){
      case 'call': case 'selfcall': return (yield* this.evalCall(e,sc));
      case 'vararg': {
        for (let s2=sc;s2;s2=s2.parent){
          if (s2.dots!==undefined) return s2.dots.slice();
        }
        return [];
      }
      default: return [(yield* this.evalOne(e,sc))];
    }
  }
  *evalOne(e,sc){
    switch (e.k){
      case 'num': return e.v;
      case 'str': return e.v;
      case 'bool': return e.v;
      case 'nil': return undefined;
      case 'name': {
        const s=scopeLookup(sc,e.v);
        if (s) return s.vars.get(e.v);
        const g=this.G.get(e.v);
        return g===undefined? undefined : g;
      }
      case 'vararg': {
        for (let s2=sc;s2;s2=s2.parent){
          if (s2.dots!==undefined) return s2.dots.length? s2.dots[0] : undefined;
        }
        return undefined;
      }
      case 'member': {
        const o=(yield* this.evalOne(e.o,sc));
        return (yield* this.rawIndex(o,e.prop));
      }
      case 'index': {
        const o=(yield* this.evalOne(e.o,sc));
        const k=(yield* this.evalOne(e.idx,sc));
        return (yield* this.rawIndex(o,k));
      }
      case 'call': case 'selfcall': {
        const r=(yield* this.evalCall(e,sc));
        return r.length? r[0] : undefined;
      }
      case 'and': {
        const a=(yield* this.evalOne(e.a,sc));
        return truthy(a)? (yield* this.evalOne(e.b,sc)) : a;
      }
      case 'or': {
        const a=(yield* this.evalOne(e.a,sc));
        return truthy(a)? a : (yield* this.evalOne(e.b,sc));
      }
      case 'not': return truthy((yield* this.evalOne(e.a,sc)))? false : true;
      case 'len': {
        const v=(yield* this.evalOne(e.a,sc));
        if (typeof v==='string') return v.length;
        if (v instanceof LuaTable){
          const mt=v.mt;
          if (mt){
            const l=mtGet(mt,'__len');
            if (l!==undefined) return (yield* this.callValue(l,[v]))[0];
          }
          return v.length;
        }
        if (v&&typeof v==='object'&&v[MT]){
          const imt=v[MT];
          if (imt.__len!==undefined) return (yield* this.callValue(imt.__len,[v]))[0];
        }
        if (Array.isArray(v)) return v.length;   /* bridge arrays (GetChildren etc.) */
        throw new LuaThrow('attempt to get length of a '+typeName(v)+' value');
      }
      case 'neg': {
        const v=(yield* this.evalOne(e.a,sc));
        if (typeof v==='number') return -v;
        const mt=getMT(v);
        const un=mt? mtGet(mt,'__unm') : null;
        if (un) return (yield* this.callValue(un,[v,v]))[0];
        throw new LuaThrow('attempt to negate a '+typeName(v)+' value');
      }
      case 'arith': {
        let a=(yield* this.evalOne(e.a,sc));
        let b=(yield* this.evalOne(e.b,sc));
        if (typeof a==='string'){ const n=tonumber(a); if (n!==null) a=n; }  /* "10"+1 */
        if (typeof b==='string'){ const n=tonumber(b); if (n!==null) b=n; }
        if (typeof a==='number'&&typeof b==='number') return arith(e.op,a,b);
        const mname=MTNAME[e.op];
        const mfa=getMT(a)? mtGet(getMT(a),mname) : null;
        if (mfa){ const r=(yield* this.callValue(mfa,[a,b])); return r.length? r[0] : undefined; }
        const mfb=getMT(b)? mtGet(getMT(b),mname) : null;
        if (mfb){ const r=(yield* this.callValue(mfb,[a,b])); return r.length? r[0] : undefined; }
        throw new LuaThrow('attempt to perform arithmetic ('+e.op+') on a '+
          (typeof a!=='number'? typeName(a) : typeName(b))+' value');
      }
      case 'cmp': {
        const a=(yield* this.evalOne(e.a,sc));
        const b=(yield* this.evalOne(e.b,sc));
        if (e.op==='=='||e.op==='~='){
          let eq=luaEq(a,b);
          if (!eq){
            /* classic value types (Color3, Vector3, CFrame, BrickColor)
             * bind __eq on their bridge wrappers  component compare like
             * the 2007 client's own operator== on those userdata */
            const ma=getMT(a), mb=getMT(b);
            let h=ma? mtGet(ma,'__eq') : undefined;
            if ((h===undefined||h===null)&&mb&&mb!==ma)
              h=mtGet(mb,'__eq');
            if (h!==undefined&&h!==null){
              const r=(yield* this.callValue(h,[a,b]));
              eq=truthy(r.length? r[0] : undefined);
            }
          }
          return e.op==='=='? eq : !eq;
        }
        if ((typeof a==='number'&&typeof b==='number')||
            (typeof a==='string'&&typeof b==='string')){
          switch (e.op){
            case '<': return a<b;
            case '<=': return a<=b;
            case '>': return a>b;
            case '>=': return a>=b;
          }
        }
        const swap=(e.op==='>'||e.op==='>=');
        const x=swap? b : a, y=swap? a : b;
        const mname=(e.op==='<'||e.op==='>')? '__lt' : '__le';
        const mfx=getMT(x)? mtGet(getMT(x),mname) : null;
        if (mfx) return truthy((yield* this.callValue(mfx,[x,y]))[0]);
        const mfy=getMT(y)? mtGet(getMT(y),mname) : null;
        if (mfy) return truthy((yield* this.callValue(mfy,[x,y]))[0]);
        throw new LuaThrow('attempt to compare '+typeName(a)+' with '+typeName(b));
      }
      case 'concat': {
        const a=(yield* this.evalOne(e.a,sc));
        const b=(yield* this.evalOne(e.b,sc));
        const sOK=v=>typeof v==='string'||typeof v==='number';
        if (sOK(a)&&sOK(b))
          return (typeof a==='string'? a : fmtNum(a))+(typeof b==='string'? b : fmtNum(b));
        const mfa=getMT(a)? mtGet(getMT(a),'__concat') : null;
        if (mfa) return (yield* this.callValue(mfa,[a,b]))[0];
        const mfb=getMT(b)? mtGet(getMT(b),'__concat') : null;
        if (mfb) return (yield* this.callValue(mfb,[b,a]))[0];
        throw new LuaThrow('attempt to concatenate a '+typeName(sOK(a)? b : a)+' value');
      }
      case 'func': {
        return {lua:true,params:e.params,body:e.body,env:sc,name:'(anon)'};
      }
      case 'table': {
        const t=new LuaTable();
        let ai=1;
        for (const row of e.rows){
          if (row.array){
            const v=row.vv;
            const spreadable=(v.k==='call'||v.k==='selfcall'||v.k==='vararg')&&!v.parens;
            if (spreadable){
              const ms=(yield* this.evalMulti(v,sc));
              for (const mv of ms) t.set(ai++,mv);
            } else t.set(ai++,(yield* this.evalOne(v,sc)));
          } else {
            const k=(yield* this.evalOne(row.kk,sc));
            const v=(yield* this.evalOne(row.vv,sc));
            t.set(k,v);
          }
        }
        return t;
      }
      default: fail('expr '+e.k);
    }
  }
  *evalCall(e,sc){
    if (e.k==='selfcall'){
      const o=(yield* this.evalOne(e.o,sc));
      const f=(yield* this.rawIndex(o,e.m));
      const args=[o];
      if (e.args&&e.args.length){
        const vs=(yield* this.evalList(e.args,sc));
        args.push(...vs);
      }
      return (yield* this.callValue(f,args));
    }
    const f=(yield* this.evalOne(e.e,sc));
    let args=[];
    if (e.args&&e.args.length){
      const vs=(yield* this.evalList(e.args,sc));
      args.push(...vs);
    }
    return (yield* this.callValue(f,args));
  }
}
function arith(op,a,b){
  switch (op){
    case '+': return a+b;
    case '-': return a-b;
    case '*': return a*b;
    case '/': return a/b;
    case '%': return a-Math.floor(a/b)*b;
    case '^': return Math.pow(a,b);
    default: throw new LuaThrow('bad op '+op);
  }
}

/* --------------------------- scopes ---------------------------- */
function newScope(parent){ return {vars:new Map(),parent}; }
function scopeLookup(sc,name){
  for (let c=sc;c;c=c.parent){ if (c.vars.has(name)) return c; }
  return null;
}

/* --------------------------- Lua 5.1 patterns ----------------------------
 * The classic lstrlib matcher (classes, sets, %b, %f, backrefs, captures)
 * ported so string.find/match/gmatch/gsub accept real patterns  the old
 * plain-text stubs silently returned wrong results for any dragged-in
 * script that uses them. Item model: itemMatch() consumes and returns a
 * length (or -1); quantifier loops are generic over that length. */
const PAT_SPECIAL=new Set(['^','$','(',')','%','.','[',']','*','+','-','?']);
const CLASS_LETTERS=new Set(['a','c','d','l','p','s','u','w','x','z']);
function charClass(c, cl){
  switch (cl){
    case 'a': return /[A-Za-z]/.test(c);
    case 'c': { const k=c.charCodeAt(0); return k<32||k===127; }
    case 'd': return c>='0'&&c<='9';
    case 'l': return c>='a'&&c<='z';
    case 'p': return /[!-/:-@[-`{-~]/.test(c);
    case 's': return /[ \t\n\v\f\r]/.test(c);
    case 'u': return c>='A'&&c<='Z';
    case 'w': return /[A-Za-z0-9]/.test(c);
    case 'x': return /[0-9A-Fa-f]/.test(c);
    case 'z': return c==='\0';
    default:  return c===cl;                  /* %( %] %% … = literals */
  }
}
function classChar(c, ch){                    /* ch may be a negated class letter */
  const lo=ch.toLowerCase();
  if (CLASS_LETTERS.has(lo)){
    const m=charClass(c,lo);
    return (ch>=lo)? m : !m;                  /* uppercase = negated */
  }
  return c===ch;                              /* non-class escape = literal */
}
/* bracket set […]: p[pi]='[' … p[setEnd-1]=']'. Does char c belong? */
function patSet(c, p, pi, ep){
  const sig=p[pi+1]==='^';
  let i=pi+(sig?2:1);
  let found=false;
  if (p[i]===']'){ if (c===']') found=true; i++; }         /* first ] is literal */
  while (i<ep){                                             /* items live in [i, ep) */
    if (p[i]==='%'){
      i++;
      if (i>=ep) break;
      if (classChar(c,p[i])) found=true;
      i++;
    } else if (p[i+1]==='-' && i+2<ep && p[i+2]!==']'){
      if (p[i]<=c && c<=p[i+2]) found=true;
      i+=3;
    } else {
      if (c===p[i]) found=true;
      i++;
    }
  }
  return sig? !found : found;
}
/* end index of a set beginning at pi ('[' → index of its ']') */
function setEnd(p, pi){
  let i=pi+1;
  if (p[i]==='^') i++;
  if (p[i]===']') i++;                         /* first ] literal */
  while (i<p.length&&p[i]!==']'){
    if (p[i]==='%') i++;
    i++;
  }
  return i;
}
/* end index of a whole item (class/set/%b/%f) beginning at pi */
function itemEnd(p, pi){
  const c=p[pi];
  if (c==='[') return setEnd(p,pi)+1;
  if (c==='%'){
    if (p[pi+1]==='b') return pi+4;
    if (p[pi+1]==='f') return setEnd(p,pi+2)+1;
    return pi+2;
  }
  return pi+1;                                 /* '.' or a literal char */
}
/* try the item at pi against s[si]; returns consumed length or -1 */
function itemMatch(s, si, p, pi, caps){
  const c=p[pi];
  if (c==='.') return si<s.length? 1 : -1;
  if (c==='['){
    const ep=setEnd(p,pi);
    if (si>=s.length) return -1;
    return patSet(s[si],p,pi,ep)? 1 : -1;
  }
  if (c==='%'){
    const cl=p[pi+1];
    if (cl===undefined) throw new LuaThrow('malformed pattern (ends with %)');
    if (cl==='b'){                             /* %bxy balanced */
      if (si>=s.length || s[si]!==p[pi+2]) return -1;
      let d=1, j=si+1;
      while (j<s.length){
        if (s[j]===p[pi+3]) d--;
        else if (s[j]===p[pi+2]) d++;
        if (d===0) return j-si+1;
        j++;
      }
      return -1;
    }
    if (cl==='f'){                             /* %f[set] frontier */
      const ep=setEnd(p,pi+2);
      const prev=si===0? '\0' : s[si-1];
      const cur=si<s.length? s[si] : '\0';
      return (patSet(cur,p,pi+2,ep)&&!patSet(prev,p,pi+2,ep))? 0 : -1;
    }
    if (cl>='0'&&cl<='9'){                     /* backreference %1..%9 */
      const cap=caps[+cl-1];
      if (!cap||cap.pos!==undefined) throw new LuaThrow('invalid capture index');
      const str=s.slice(cap[0],cap[1]);
      return s.startsWith(str,si)? str.length : -1;
    }
    if (si>=s.length) return -1;
    return classChar(s[si],cl)? 1 : -1;
  }
  return (si<s.length&&s[si]===c)? 1 : -1;
}
/* the recursive matcher: returns {end, caps} on success, null on failure.
 * caps entries are [start,end) spans or {pos} position captures. */
function doMatch(s, p, si, pi, caps, depth){
  if ((depth=(depth||0)+1)>4000) throw new LuaThrow('pattern too complex');
  for(;;){
    if (pi>=p.length) return {end:si, caps};
    const c=p[pi];
    if (c==='('){
      if (p[pi+1]===')')
        return doMatch(s,p,si,pi+2,caps.concat([{pos:si}]),depth);
      return doMatch(s,p,si,pi+1,caps.concat([[si,-1]]),depth);
    }
    if (c===')'){
      const open=caps[caps.length-1];
      if (!open||open.pos!==undefined||open[1]!==-1)
        throw new LuaThrow('invalid pattern capture');
      return doMatch(s,p,si,pi+1,caps.slice(0,-1).concat([[open[0],si]]),depth);
    }
    if (c==='$'){
      if (pi===p.length-1) return si===s.length? {end:si,caps} : null;
      /* '$' mid-pattern is a literal item (lstrlib fallthrough) */
    }
    if (c==='^'){
      if (pi===0){ pi=1; continue; }
      /* '^' mid-pattern is a literal item too */
    }
    /* everything else is an item: '.', '%', '[', or ANY literal char
     * including - * + ? , which are only quantifiers when they FOLLOW an
     * item (a leading '*' is the literal '*', like real Lua) */
    const e=itemEnd(p,pi);
    const q=p[e];
    if (q==='*'||q==='+'){                     /* greedy (min 0 / min 1) */
      const min=(q==='+')?1:0;
      let cnt=0;
      while (si+cnt<s.length){
        const m=itemMatch(s,si+cnt,p,pi,e,caps);
        if (m<=0) break;
        cnt+=m;
      }
      for (;cnt>=min;cnt--){
        const r=doMatch(s,p,si+cnt,e+1,caps,depth);
        if (r) return r;
      }
      return null;
    }
    if (q==='-'){                              /* lazy */
      let pos=si;
      for(;;){
        const r=doMatch(s,p,pos,e+1,caps,depth);
        if (r) return r;
        if (pos>=s.length) return null;
        const m=itemMatch(s,pos,p,pi,e,caps);
        if (m<=0) return null;
        pos+=m;
      }
    }
    if (q==='?'){
      const m=itemMatch(s,si,p,pi,e,caps);
      if (m>0){
        const r=doMatch(s,p,si+m,e+1,caps,depth);
        if (r) return r;
      }
      return doMatch(s,p,si,e+1,caps,depth);
    }
    const m=itemMatch(s,si,p,pi,e,caps);
    if (m>0){ si+=m; pi=e; continue; }
    return null;
  }
}
/* find from init: returns {start,end,caps} (0-based, end exclusive) or null */
function patternFind(s, p, init, plain){
  init=init==null? 0 : Math.max(0,Math.min(init,s.length));
  if (plain){
    const i=s.indexOf(p,init);
    return i<0? null : {start:i,end:i+p.length,caps:[]};
  }
  const anchored=p[0]==='^';
  for (let i=init; i<=s.length; i++){
    const r=doMatch(s,p,i,anchored?1:0,[]);
    if (r) return {start:i,end:r.end,caps:r.caps};
    if (anchored) break;
  }
  return null;
}
function capValues(s, m){
  const out=[];
  for (const c of m.caps){
    if (c.pos!==undefined) out.push(c.pos+1);  /* 1-based positions */
    else out.push(s.slice(c[0],c[1]));
  }
  return out;
}

/* --------------------------- stdlib ---------------------------- */
function installStd(interp){
  const G=interp.G;
  const N=(name,fn,gen)=>{ G.set(name,mkNative(fn,gen)); };
  const toNum=v=>{ const x=tonumber(v); return x===null? undefined : x; };

  G.set('_G',G);
  N('print',args=>{
    const line=args.map(v=>tostring(v)).join('\t');
    if (window.RBLXlua&&window.RBLXlua.logSink) window.RBLXlua.logSink(line);
    else console.log('[lua]',line);
    return [];
  });
  N('type',args=>[typeName(args[0])]);
  N('tostring',args=>[tostring(args[0])]);
  N('tonumber',args=>{ const v=tonumber(args[0]); return [v===null? undefined : v]; });
  N('select',args=>{
    const s0=args[0];
    if (s0==='#') return [args.length-1];
    const idx=toNum(s0);
    if (idx===undefined) throw new LuaThrow("bad argument #1 to 'select'");
    return idx<0? args.slice(args.length+idx) : args.slice(idx);
  });
  N('unpack',args=>{
    const t=args[0]; if (!(t instanceof LuaTable)) return [];
    const a=toNum(args[1])||1, b=args[2]!=null? (toNum(args[2])||t.length) : t.length;
    const out=[]; for (let i=a;i<=b;i++) out.push(t.get(i));
    return out;
  });
  N('rawget',args=>[args[0] instanceof LuaTable? args[0].get(args[1]) : undefined]);
  N('rawset',args=>{
    if (args[0] instanceof LuaTable) args[0].set(args[1],args[2]);
    return [args[0]];
  });
  N('rawequal',args=>[luaEq(args[0],args[1])]);
  N('setmetatable',args=>{
    const t=args[0];
    if (!(t instanceof LuaTable)) throw new LuaThrow('bad argument #1 to setmetatable (table expected)');
    t.mt=(args[1] instanceof LuaTable)? args[1] : null;
    return [t];
  });
  N('getmetatable',args=>[args[0] instanceof LuaTable? (args[0].mt||undefined) : undefined]);
  N('error',args=>{ throw new LuaThrow(args.length&&args[0]!==undefined? args[0] : undefined); });
  N('assert',args=>{
    if (!truthy(args[0])) throw new LuaThrow(args.length>1? args[1] : 'assertion failed!');
    return args;
  });
  G.set('pcall',mkNative(function*(ip,args){
    const f=args[0], rest=args.slice(1);
    try { const r=(yield* ip.callValue(f,rest)); return [true,...r]; }
    catch (e){
      if (e instanceof LuaThrow) return [false,e.value];
      return [false,'[luaport] '+(e.message||String(e))];
    }
  },true));

  /* ---- math ---- */
  const mathT=new LuaTable(); G.set('math',mathT);
  mathT.set('pi',Math.PI);
  mathT.set('huge',Infinity);
  const mj=(k,f)=>mathT.set(k,mkNative(f));
  mj('floor',a=>[Math.floor(toNum(a[0]))]);
  mj('ceil',a=>[Math.ceil(toNum(a[0]))]);
  mj('abs',a=>[Math.abs(toNum(a[0]))]);
  mj('max',a=>{ let m=-Infinity; for (const v of a){ const x=toNum(v); if (x!==undefined&&x>m) m=x; } return [m]; });
  mj('min',a=>{ let m=Infinity; for (const v of a){ const x=toNum(v); if (x!==undefined&&x<m) m=x; } return [m]; });
  mj('sqrt',a=>[Math.sqrt(toNum(a[0]))]);
  mj('log',a=>{ const x=toNum(a[0]); return a[1]!==undefined? [Math.log(x)/Math.log(toNum(a[1]))] : [Math.log(x)]; });
  mj('log10',a=>[Math.log10(toNum(a[0]))]);
  mj('exp',a=>[Math.exp(toNum(a[0]))]);
  mj('sin',a=>[Math.sin(toNum(a[0]))]);
  mj('cos',a=>[Math.cos(toNum(a[0]))]);
  mj('tan',a=>[Math.tan(toNum(a[0]))]);
  mj('asin',a=>[Math.asin(toNum(a[0]))]);
  mj('acos',a=>[Math.acos(toNum(a[0]))]);
  mj('atan',a=>[Math.atan(toNum(a[0]))]);
  mj('atan2',a=>[Math.atan2(toNum(a[0]),toNum(a[1]))]);
  mj('rad',a=>[toNum(a[0])*Math.PI/180]);
  mj('deg',a=>[toNum(a[0])*180/Math.PI]);
  mj('pow',a=>[Math.pow(toNum(a[0]),toNum(a[1]))]);
  mj('fmod',a=>[toNum(a[0])%toNum(a[1])]);
  mj('randomseed',()=>[]);
  mj('random',a=>{
    if (a.length===0) return [Math.random()];
    const hi0=toNum(a[0]);
    if (hi0===undefined) return [Math.random()];
    if (a.length===1) return [1+Math.floor(Math.random()*hi0)];
    const lo=hi0, hi=toNum(a[1]);
    return [Math.floor(lo+Math.random()*(hi-lo+1))];
  });

  /* ---- string ---- */
  const strT=new LuaTable(); G.set('string',strT);
  STR_TABLE=strT;                    /* module-level: string metatable index */
  const sj=(k,f)=>strT.set(k,mkNative(f));
  sj('len',a=>[typeof a[0]==='string'? a[0].length : (typeof a[0]==='number'? fmtNum(a[0]).length : 0)]);
  sj('sub',a=>{
    const s=tostring(a[0]);
    let i=a[1]===undefined? 1 : toNum(a[1]);
    let j=a[2]===undefined? -1 : toNum(a[2]);
    if (i<0) i=Math.max(s.length+i+1,1); else if (i===0) i=1;
    if (j<0) j=s.length+j+1;
    if (i>j) return [''];
    return [s.slice(i-1,j)];
  });
  sj('rep',a=>[tostring(a[0]).repeat(Math.max(0,Math.floor(toNum(a[1])||0)))]);
  sj('lower',a=>[tostring(a[0]).toLowerCase()]);
  sj('upper',a=>[tostring(a[0]).toUpperCase()]);
  sj('byte',a=>{ const s=tostring(a[0]); const i=toNum(a[1])||1; const c=s.charCodeAt(i-1); return [c? c : undefined]; });
  sj('char',a=>[a.map(c=>String.fromCharCode(toNum(c)||0)).join('')]);
  sj('reverse',a=>[tostring(a[0]).split('').reverse().join('')]);
  sj('format',a=>{
    const f=tostring(a[0]); let ai=1;
    const out=f.replace(/%%|%(?:([-+ #0]*)(\d+|\*)?)?(?:\.(\d+|\*))?([dsfxXgeEgcs])/g,(m,flags,width,prec,conv)=>{
      if (m==='%%') return '%';
      if (width==='*') width=String(toNum(a[ai++]));
      if (prec==='*') prec=String(toNum(a[ai++]));
      const arg=a[ai++];
      const W=width!=null? parseInt(width,10) : null;
      const P=prec!=null? parseInt(prec,10) : null;
      let s0;
      switch (conv){
        case 'd': case 'i': {
          const v=Math.round(toNum(arg)||0);
          s0=Math.abs(v).toString();
          if (P!=null) s0=s0.padStart(P,'0');
          s0=(v<0?'-':'')+s0;
          break;
        }
        case 'f': { const v=toNum(arg)||0; s0=v.toFixed(P!=null?P:6); break; }
        case 'g': { s0=fmtNum(toNum(arg)||0); break; }
        case 'e': case 'E': { s0=(toNum(arg)||0).toExponential(P!=null?P:6); if (conv==='E') s0=s0.toUpperCase(); break; }
        case 'x': { const v=Math.round(toNum(arg))||0; s0=Math.abs(v).toString(16); if (v<0) s0='-'+s0; break; }
        case 'X': { const v=Math.round(toNum(arg))||0; s0=Math.abs(v).toString(16).toUpperCase(); if (v<0) s0='-'+s0; break; }
        case 's': { s0=tostring(arg); if (P!=null) s0=s0.slice(0,P); break; }
        case 'c': return String.fromCharCode(toNum(arg)||0);
        default: return m;
      }
      if (W!=null){
        if (flags&&flags.includes('-')) return s0.padEnd(W);
        if (flags&&flags.includes('0')&&conv!=='s') return s0.padStart(W,'0');
        return s0.padStart(W);
      }
      return s0;
    });
    return [out];
  });
  sj('find',a=>{
    const s=tostring(a[0]), pat=tostring(a[1]);
    let init=toNum(a[2]);
    init=(init==null||init===0)? 0 : (init<0? s.length+init+1 : init-1);
    const m=patternFind(s,pat,init,a[3]===true);
    if (!m) return [undefined];
    const out=[m.start+1, m.end];              /* Lua end index is inclusive */
    const caps=capValues(s,m);
    if (caps.length) out.push(...caps);
    return out;
  });
  sj('match',a=>{
    const s=tostring(a[0]), pat=tostring(a[1]);
    let init=toNum(a[2]);
    init=(init==null||init===0)? 0 : (init<0? s.length+init+1 : init-1);
    const m=patternFind(s,pat,init,false);
    if (!m) return [undefined];
    const caps=capValues(s,m);
    return caps.length? caps : [s.slice(m.start,m.end)];
  });
  sj('gmatch',a=>{
    const s=tostring(a[0]), pat=tostring(a[1]);
    let pos=0;
    return [mkNative(()=>{
      const m=patternFind(s,pat,pos,false);
      if (!m) return [undefined];
      pos=m.end;
      const caps=capValues(s,m);
      return caps.length? caps : [s.slice(m.start,m.end)];
    })];
  });
  strT.set('gsub',mkNative(function*(ip,a){
    const s=tostring(a[0]), pat=tostring(a[1]);
    const repl=a[2];
    const maxN=(a[3]!=null&&toNum(a[3])!=null)? toNum(a[3]) : Infinity;
    const anchored=pat[0]==='^';
    let src=0, last=0, out='', n=0;
    while (n<maxN){
      const m=patternFind(s,pat,src,false);
      if (!m) break;
      n++;
      out+=s.slice(last,m.start);
      const caps=capValues(s,m);
      const whole=s.slice(m.start,m.end);
      let rep, keep=false;
      if (typeof repl==='string'||typeof repl==='number'){
        rep=tostring(repl).replace(/%([%0-9])/g,(x,d)=>{
          if (d==='%') return '%';
          if (d==='0') return whole;
          return caps[+d-1]!=null? caps[+d-1] : x;
        });
      } else if (repl instanceof LuaTable){
        const v=repl.get(whole);
        if (v===undefined||v===null) keep=true;
        else rep=tostring(v);
      } else if (typeof repl==='function'||(repl&&repl.lua)){
        const args=caps.length? caps : [whole];
        const r=(yield* ip.callValue(repl,args));
        const v=(r&&r.length)? r[0] : undefined;
        if (v===undefined||v===null||v===false) keep=true;
        else rep=tostring(v);
      } else {
        throw new LuaThrow('bad argument #3 to gsub (string/function/table expected)');
      }
      out += keep? whole : rep;
      last=m.end;
      src = (m.end===m.start)? m.end+1 : m.end;   /* empty match → advance 1 */
      if (anchored) break;
    }
    out+=s.slice(Math.min(last,s.length));
    return [out,n];
  },true));

  /* ---- table ---- */
  const tabT=new LuaTable(); G.set('table',tabT);
  const tjn=(k,f)=>tabT.set(k,mkNative(f));
  tjn('insert',args=>{
    const t=args[0];
    if (!(t instanceof LuaTable)) throw new LuaThrow('bad argument #1 to insert (table expected)');
    if (args.length>=3){
      const pos=Math.floor(toNum(args[1])||0);
      if (!(pos>=1&&pos<=t.length+1))
        throw new LuaThrow('bad argument #2 to insert (position out of bounds)');
      const arr=t.a;
      arr.push(undefined);
      for (let i=arr.length-2;i>=pos;i--) arr[i+1]=arr[i];
      arr[pos]=args[2];
    } else t.set(t.length+1,args[1]);
    return [];
  });
  tjn('remove',args=>{
    const t=args[0];
    if (!(t instanceof LuaTable)) throw new LuaThrow('bad argument #1 to remove (table expected)');
    const len=t.length;                          /* logical length (hole-aware) */
    const pos=args[1]!==undefined? Math.floor(toNum(args[1])||len) : len;
    if (pos<1||pos>len) return [undefined];
    const v=t.get(pos);
    for (let i=pos;i<len;i++) t.a[i]=t.a[i+1];
    t.a[len]=undefined;
    while (t.a.length>1&&t.a[t.a.length-1]===undefined) t.a.pop();
    return [v];
  });
  tjn('getn',args=>[args[0] instanceof LuaTable? args[0].length : 0]);
  tjn('concat',args=>{
    const t=args[0];
    if (!(t instanceof LuaTable)) throw new LuaThrow('bad argument #1 to concat (table expected)');
    const sep=args[1]!==undefined? tostring(args[1]) : '';
    return [t.Arr().map(v=>tostring(v)).join(sep)];
  });
  tabT.set('sort',mkNative(function*(ip,args){
    const t=args[0];
    if (!(t instanceof LuaTable)) throw new LuaThrow('bad argument #1 to sort (table expected)');
    const cmp=args.length>1? args[1] : null;
    const items=t.Arr();
    for (let i=1;i<items.length;i++){
      for (let j=i;j>0;j--){
        let less;
        if (cmp){
          const r=(yield* ip.callValue(cmp,[items[j],items[j-1]]));
          less=truthy(r[0]);
        } else {
          const a=items[j], b=items[j-1];
          if (typeof a==='number'&&typeof b==='number') less=a<b;
          else if (typeof a==='string'&&typeof b==='string') less=a<b;
          else throw new LuaThrow('invalid order function for sort');
        }
        if (!less) break;
        const tmp=items[j]; items[j]=items[j-1]; items[j-1]=tmp;
      }
    }
    for (let i=0;i<items.length;i++) t.set(i+1,items[i]);
    return [];
  },true));

  /* ---- iterators ---- */
  N('next',args=>{
    const t=args[0];
    if (!(t instanceof LuaTable)) return [undefined];
    return LuaTable.next(t,args[1]);
  });
  N('pairs',args=>{
    const t=args[0];
    if (t instanceof LuaTable)
      return [mkNative(a=>LuaTable.next(t,a[1])),t,undefined];
    if (Array.isArray(t))                                /* bridge arrays */
      return [mkNative(a=>{
        const i=(toNum(a[1])||0)+1;
        return i<=t.length? [i,t[i-1]] : [undefined];
      }),t,0];
    throw new LuaThrow("bad argument #1 to 'pairs' (table expected)");
  });
  N('ipairs',args=>{
    const t=args[0];
    if (!(t instanceof LuaTable)&&!Array.isArray(t))
      throw new LuaThrow("bad argument #1 to 'ipairs' (table expected)");
    const list=t;
    return [mkNative(a=>{
      const i=(toNum(a[1])||0)+1;
      const v=(list instanceof LuaTable)? list.get(i) : list[i-1];
      return v===undefined? [undefined] : [i,v];
    }),t,0];
  });

  /* ---- async primitives ---- */
  G.set('wait',mkNative(function*(ip,args){
    const d=Math.max(0,toNum(args[0])||0);
    yield {t:'wait',d};
    return [ip.sched.time];
  },true));
  G.set('spawn',mkNative(function*(ip,args){
    if (args.length) ip.sched.launchFiber(args[0],[],null,null,ip);
    return [];
  },true));
  G.set('delay',mkNative(function*(ip,args){
    const d=Math.max(0,toNum(args[0])||0);
    const f=args[1];
    yield {t:'wait',d};
    if (f!==undefined) ip.sched.launchFiber(f,[],null,null,ip);
    return [];
  },true));

  /* ---- coroutine ---- */
  const coT=new LuaTable(); G.set('coroutine',coT);
  coT.set('create',mkNative(args=>{
    const f=args[0];
    if (!(f&&(f.lua||typeof f==='function'))) throw new LuaThrow('bad argument #1 to create (function expected)');
    return [{__co:true,id:tableSeq++,f,status:'suspended',gen:null,fiber:null,resumeVal:null}];
  }));
  coT.set('resume',mkNative(function*(ip,args){
    const co=args[0];
    if (!co||!co.__co) throw new LuaThrow('bad argument #1 to resume (coroutine expected)');
    const rest=args.slice(1);
    if (co.status==='dead') return [false,'cannot resume dead coroutine'];
    if (co.status!=='suspended') return [false,'cannot resume non-suspended coroutine'];
    if (!co.gen){
      co.gen=(function*(){ return (yield* ip.callValue(co.f,rest)); })();
      co.resumeVal=null;
    } else {
      co.resumeVal=rest;
    }
    return ip.sched.stepInline(co);
  },true));
  coT.set('yield',mkNative(function*(ip,args){
    const resolved=(yield {t:'coyield',ret:args});
    return resolved&&resolved.length? resolved : [];
  },true));
  coT.set('status',mkNative(args=>{
    const c=args[0];
    return [c&&c.__co? c.status : undefined];
  }));
  coT.set('running',mkNative(()=>[undefined,false]));

  /* ---- os / classic clock globals ---- */
  const osT=new LuaTable(); G.set('os',osT);
  osT.set('time',mkNative(()=>[Math.floor(Date.now()/1000)]));
  osT.set('clock',mkNative(()=>[ (typeof performance!=='undefined'? performance.now() : Date.now())/1000 ]));
  G.set('tick',mkNative(()=>[Date.now()/1000]));
  G.set('time',mkNative(()=>[interp.sched.time]));       /* game elapsed (RunService clock) */
  G.set('ElapsedTime',mkNative(()=>[interp.sched.time]));
}

/* --------------------------- scheduler ------------------------- */
class Scheduler{
  constructor(){
    this.time=0; this.lastDt=0;
    this.interp=null;
    this.active=[];        /* fibers to step now */
    this.waiters=[];       /* {at, fiber} */
    this.onUnhandled=null;
    this.steps=0;
  }
  launchFiber(f,args,onDone,onUnsupported,ipCtx){
    const ip=ipCtx||this.interp;
    if (!ip) throw new Unsupported('no lua env  call makeEnv() first');
    const gen=(function*(){ return (yield* ip.callValue(f,args||[])); })();
    return this.launchGen(gen,onDone,onUnsupported);
  }
  launchGen(gen,onDone,onUnsupported){
    const fiber={gen,resumeVal:[],state:'ready',onDone:onDone||null,onUnsupported:onUnsupported||null,co:null};
    this.active.push(fiber);
    return fiber;
  }
  /* step a coroutine fiber inline; returns [ok, ...values] per Lua resume */
  stepInline(co){
    const fiber=co.fiber||(co.fiber={gen:co.gen,resumeVal:[],state:'running',co,onDone:null,onUnsupported:null});
    if (fiber.state==='dead') return [false,'cannot resume dead coroutine'];
    let res;
    try { res=fiber.gen.next(co.resumeVal===null||co.resumeVal===undefined? [] : co.resumeVal); }
    catch (e){
      fiber.state='dead'; co.status='dead'; co.resumeVal=null;
      if (e instanceof LuaThrow) return [false,e.value];
      return [false,'[luaport] '+(e.message||String(e))];
    }
    co.resumeVal=null;
    if (res.done){ fiber.state='dead'; co.status='dead'; return [true,...(res.value||[])]; }
    const y=res.value||{};
    if (y.t==='coyield'){
      fiber.state='suspended'; co.status='suspended';
      return [true,...(y.ret||[])];
    }
    if (y.t==='wait'){
      fiber.state='wait'; co.status='suspended';
      this.waiters.push({at:this.time+Math.max(0,y.d||0),fiber});
      return [true];
    }
    if (y.t==='spin'){
      fiber.state='ready';
      this.waiters.push({at:this.time,fiber});
      return [true];
    }
    fiber.state='dead'; co.status='dead';
    return [false,'[luaport] fiber yielded an unknown value'];
  }
  tick(dt){
    this.time+=dt; this.lastDt=dt;
    /* wake due waiters */
    let i=0;
    while (i<this.waiters.length){
      const w=this.waiters[i];
      if (w.at<=this.time){
        this.waiters.splice(i,1);
        if (w.fiber.state==='wait'||w.fiber.state==='ready'){
          w.fiber.state='ready';
          this.active.push(w.fiber);
        }
      } else i++;
    }
    this.steps=0;
    while (this.active.length){
      const f=this.active.shift();
      if (f.state==='dead') continue;
      this.steps++;
      if (this.steps>8000){ this.waiters.push({at:this.time,fiber:f}); continue; }  /* next tick */
      const rv=f.resumeVal; f.resumeVal=[];
      let res;
      try { res=f.gen.next(rv&&rv.length? rv : []); }
      catch (e){
        f.state='dead';
        if (f.co) f.co.status='dead';
        const isSup=(e instanceof Unsupported)||(e&&e.unsupported);
        if (isSup&&f.onUnsupported){ f.onUnsupported(e); if (f.onDone) f.onDone([]); continue; }
        const msg=(e instanceof LuaThrow)
          ? 'script error: '+tostring(e.value)
          : '[luaport] '+(e.message||String(e));
        console.error(msg);
        if (this.onUnhandled) this.onUnhandled(msg,f,e);
        continue;
      }
      if (res.done){
        f.state='dead';
        if (f.co) f.co.status='dead';
        if (f.onDone) f.onDone(res.value||[]);
        continue;
      }
      const y=res.value||{};
      if (y.t==='wait'){
        f.state='wait';
        this.waiters.push({at:this.time+Math.max(0,y.d||0),fiber:f});
      } else if (y.t==='spin'||y.t==='coyield'){
        if (y.t==='coyield'&&f.co){ f.co.status='suspended'; }
        f.state='ready';
        this.waiters.push({at:this.time,fiber:f});   /* continue next tick */
      } else {
        f.state='dead';
        const msg='[luaport] fiber yielded an unknown value';
        console.error(msg);
        if (this.onUnhandled) this.onUnhandled(msg,f,null);
      }
    }
  }
}

/* --------------------------- top-level API --------------------- */
const SCHED=new Scheduler();
let CALL_IP=null;       /* interp currently invoking a native (rbxenv bridge) */

function makeEnv(extra){
  const G=new LuaTable();
  const interp=new Interp(G,SCHED);
  SCHED.interp=interp;
  installStd(interp);
  if (extra) for (const k of Object.keys(extra)) G.set(k,extra[k]);
  return interp;
}

function compile(src){
  if (typeof src!=='string'||!src.trim()) fail('empty script');
  return parse(src);
}

/* run a compiled chunk as a scheduled fiber in the current env */
function run(prog,onDone,onUnsupported){
  if (!SCHED.interp) fail('no lua env  call makeEnv() first');
  const interp=SCHED.interp;
  const gen=(function*(){
    const sc=newScope(null);
    return (yield* interp.execBlock(prog,sc));
  })();
  return SCHED.launchGen(gen,onDone,onUnsupported);
}

window.RBLXlua={
  MT, LuaTable, Unsupported, LuaThrow,
  lex, parse, compile, run, makeEnv,
  mkNative, tostring, tonumber, truthy, typeName, fmtNum, getMT, mtGet, luaEq,
  newScope, currentIp:()=>CALL_IP,
  sched:SCHED,
  logSink:null,
};
})();

