/* ============================================================
 * safechat.js  the classic Super Safe Chat GUI.
 *
 * Mined (Roblox.exe.c):
 *  - Fonts\safechat.xml is the menu (FUN_0060ebc0, :512332); the
 *    nested <utterance> tree is categories → sub-categories → phrases.
 *  - ChatHud (FUN_005d6230) is the typed-chat fold; ChatMenuPanel
 *    (FUN_005d6640) is this GUI and owns a ChatButton child plus the
 *    recursive menu built by FUN_005d63d0.
 *  - ChatButton is an RBX::UnifiedImageWidget (FUN_005d4cd0 /
 *    FUN_005d4bb0).  FUN_005e8740 loads its four states from one base
 *    path: Chat.png, then Chat_ovr.png (hover), Chat_dn.png (pressed)
 *    and Chat_ds.png (disabled)  all 32×23 in the shipped client.
 *
 * Phrase labels stay verbatim: the shipped typos ("eveyone",
 * "Seaons greetings!", "barbecque") are what the classic menu showed.
 * A picked phrase goes through the exact same chat path as typed text.
 * ============================================================ */
(function(){
"use strict";

/* Stack-parse the nested <utterance> elements; every other tag
 * (<roblox>, <External>) is skipped.  DOM-free so the headless suite
 * exercises the same parser the menu uses. */
function parseSafeChat(text){
  const root={label:'', children:[], parent:null};
  const stack=[root];
  const re=/<\s*(\/?)\s*utterance\b[^>]*>|([^<]+)/gi;
  let m;
  while ((m=re.exec(text))){
    if (m[1]){                                  /* </utterance> */
      if (stack.length>1) stack.pop();
    } else if (m[0].charAt(0)==='<'){           /* <utterance ...> */
      const node={label:'', children:[], parent:stack[stack.length-1]};
      stack[stack.length-1].children.push(node);
      stack.push(node);
    } else {                                    /* text content */
      const cur=stack[stack.length-1];
      if (cur!==root && !cur.label)
        cur.label=m[2].replace(/\s+/g,' ').trim();
    }
  }
  return root;
}
function safeChatTree(){
  const t=window.CORE_ASSETS&&window.CORE_ASSETS['content/fonts/safechat.xml'];
  return t? parseSafeChat(t) : null;
}
function treeSize(n){ let s=1; for (const c of n.children) s+=treeSize(c); return s; }
function pathOf(node){
  const out=[];
  for (let n=node; n&&n.parent; n=n.parent) out.unshift(n.label);
  return out;
}
/* menu rows for a node: a back row when nested, then one row per child
 * (leaf rows carry the phrase to send) */
function menuRows(node){
  const rows=[];
  if (node.parent)
    rows.push({back:true, leaf:false, label:'\u00AB Back', node:node.parent});
  for (const c of node.children)
    rows.push({back:false, leaf:c.children.length===0,
               label:c.label, node:c});
  return rows;
}

/* ---------- ChatButton art (FUN_005e8740 state suffixes) ---------- */
const BUTTON_IMAGES={
  normal:  'content/textures/Chat.png',
  hover:   'content/textures/Chat_ovr.png',
  down:    'content/textures/Chat_dn.png',
  disabled:'content/textures/Chat_ds.png'
};
const BUTTON_SIZE={ width:32, height:23 };      /* shipped PNG dimensions */
/* embedded data URL first (file:// WebGL/CSS parity), path fallback */
function imageFor(state){
  const p=BUTTON_IMAGES[state]||BUTTON_IMAGES.normal;
  return (window.IMAGE_DATA&&window.IMAGE_DATA[p])||p;
}

/* a picked phrase sends through the same ui.chat path as typed text
 * (main.js's Enter handler)  name colour cycles the classic palette */
function sendPhrase(phrase){
  const ui=window.RBLXui_instance_open;
  if (ui&&ui.chat) ui.chat(phrase, (window.RBLXplayer&&window.RBLXplayer.name)||'Player1');
}

/* ---------- DOM chrome (browser only) ---------- */
let mounted=null;
function mount(){
  if (typeof document==='undefined'||!document.body) return null;
  if (mounted) return mounted;
  const input=document.getElementById('chatInput');
  const tree=safeChatTree();
  if (!input||!tree||!tree.children.length) return null;
  const host=input.parentElement;

  /* ChatButton: 32×23 speech bubble, four engine states */
  const btn=document.createElement('button');
  btn.id='safeChatBtn';
  btn.type='button';
  btn.title='Safe Chat';
  btn.setAttribute('aria-haspopup','menu');
  btn.setAttribute('aria-expanded','false');
  const img=document.createElement('img');
  img.src=imageFor('normal');
  img.alt='Safe Chat';
  img.draggable=false;
  btn.appendChild(img);
  host.insertBefore(btn, input);

  /* ChatMenuPanel: the utterance tree, one page at a time */
  const panel=document.createElement('div');
  panel.id='safeChatPanel';
  panel.setAttribute('role','menu');
  panel.style.display='none';
  host.appendChild(panel);

  let cur=tree, state='normal', enabled=true, open=false;

  function setState(s){
    state=enabled?s:'disabled';
    img.src=imageFor(state);
    btn.dataset.state=state;
  }
  function setEnabled(on){
    enabled=!!on;
    btn.disabled=!enabled;
    if (!enabled) close();
    setState(enabled?'normal':'disabled');
  }
  function header(){
    const h=document.createElement('div');
    h.className='scTitle';
    const p=pathOf(cur);
    h.textContent=p.length? p.join(' \u203A ') : 'Safe Chat';
    return h;
  }
  function render(){
    panel.innerHTML='';
    panel.appendChild(header());
    for (const row of menuRows(cur)){
      const el=document.createElement('button');
      el.type='button';
      el.className='scRow'+(row.back?' scBack':'')+(row.leaf?' scLeaf':' scCat');
      el.setAttribute('role','menuitem');
      el.textContent=row.label+(row.leaf?'':row.back?'':'\u2002\u25B8');
      el.onclick=(e)=>{
        e.stopPropagation();
        if (row.back){ cur=row.node; render(); return; }
        if (row.leaf){ sendPhrase(row.label); close(); return; }
        cur=row.node; render();
      };
      panel.appendChild(el);
    }
  }
  function openMenu(){
    if (!enabled||open) return;
    open=true; cur=tree; render();
    panel.style.display='block';
    btn.setAttribute('aria-expanded','true');
    setState('hover');
    setTimeout(()=>{ if (open) document.addEventListener('click', outside); }, 0);
  }
  function close(){
    if (!open) return;
    open=false;
    panel.style.display='none';
    btn.setAttribute('aria-expanded','false');
    setState(enabled?'normal':'disabled');
    document.removeEventListener('click', outside);
  }
  function toggle(){ open? close() : openMenu(); }
  function outside(e){
    if (!panel.contains(e.target)&&e.target!==btn&&!btn.contains(e.target)) close();
  }

  btn.addEventListener('mouseenter', ()=>{ if (enabled&&!open) setState('hover'); });
  btn.addEventListener('mouseleave', ()=>{ if (enabled&&!open) setState('normal'); });
  btn.addEventListener('mousedown', ()=>{ if (enabled) setState('down'); });
  btn.addEventListener('mouseup', ()=>{ if (enabled) setState('hover'); });
  btn.addEventListener('click', (e)=>{ e.stopPropagation(); toggle(); });
  panel.addEventListener('keydown', (e)=>{ if (e.key==='Escape'){ close(); btn.focus(); } });
  document.addEventListener('keydown', (e)=>{
    if (e.key==='Escape'&&open){ close(); btn.focus(); }
  });

  setState('normal');
  mounted={ openMenu, close, toggle, render, setState, setEnabled,
            get state(){ return state; }, get isOpen(){ return open; },
            button:btn, panel, tree };
  return mounted;
}

window.RBLXsafechat={ parse:parseSafeChat, tree:safeChatTree,
                      size:treeSize, path:pathOf, rows:menuRows,
                      send:sendPhrase, mount, imageFor, BUTTON_IMAGES,
                      BUTTON_SIZE,
                      close:()=>{ if (mounted) mounted.close(); },
                      instance:()=>mounted };
})();
