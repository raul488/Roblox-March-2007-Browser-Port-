/* ============================================================
 * ui.js  the 2007 client chrome.
 * Office2007Blue-era skin: chat window ("To chat click here or
 * press / key"), green Health bar, center Message instance overlay
 * (used by the Regenerate scripts), bottom tool bar (1..0) with the
 * classic rbxasset icons, notifications, File/Tools/Help menus.
 * ============================================================ */
(function(){
"use strict";

class UI {
  constructor(){
    this.$msgs=document.getElementById('notif');
    this.$chatPanel=document.getElementById('chatPanel');
    this.$messageBox=document.getElementById('messageBox');
    this.$hintBox=document.getElementById('hintBox');
    this.$chatList=document.getElementById('chatLog');
    this.$chatInput=document.getElementById('chatInput');
    this.$hotbar=document.getElementById('hotbar');
    this.$healthHud=document.getElementById('healthHud');
    this.$healthFill=document.getElementById('healthFill');
    this.tools=[];
    this.selected=-1;
    this.onSelectTool=null;
    this._mtHide=null;
  }

  /* chat window (bottom-left fold in the classic HUD).
   * Colors are the palette mined verbatim from the exe getters
   * (FUN_00500770 red, FUN_005007a0 green, FUN_005007d0 blue,
   * FUN_00500800 violet, FUN_00500840 yellow, FUN_00500870 orange) plus the
   * message-class switch FUN_005b8060: 1=blue system, 2=red warn, 6=yellow tip. */
  static PALETTE=['#0000ff','#ff0000','#b200ff','#ffff00','#00ff00','#ff8000']; // classic name-color cycle (order approx  getter family order)
  playerColor(who){
    let h=0;
    for (let i=0;i<who.length;i++) h=(h*31+who.charCodeAt(i))>>>0;
    this._nameColorCache=this._nameColorCache||{};
    if (this._nameColorCache[who]==null)
      this._nameColorCache[who]=this.constructor.PALETTE[h%this.constructor.PALETTE.length];
    return this._nameColorCache[who];
  }
  chat(msg, who, color){
    const line=document.createElement('div');
    line.className='chatLine';
    if (who){
      const b=document.createElement('b');
      b.style.color=color||this.playerColor(who);
      b.textContent=who+':';
      line.appendChild(b);
      const t=document.createElement('span');
      t.textContent=msg; t.style.color='#e2e2e2';
      line.appendChild(t);
    } else {
      line.textContent=msg;
      line.style.color=color||'#b2b2b2';            // default class = gray (0.7,0.7,0.7)
    }
    this.$chatList.appendChild(line);
    /* the 2007 fold keeps six messages (each 14px on the 84px log) */
    while (this.$chatList.children.length>6) this.$chatList.removeChild(this.$chatList.firstChild);
    /* appended lines go below the fold (the log has max-height and hidden
     * overflow), so without pinning the scroll the newest message stayed
     * invisible until enough spam pushed the list up */
    this.$chatList.scrollTop=this.$chatList.scrollHeight;
  }

  /* the native ChatEnter prompt stays visible above the backpack strip;
   * clicking the fold or "/" focuses it.  Enter/Escape only clear/blur. */
  showChatInput(){
    if (this.$chatInput){ try { this.$chatInput.focus(); } catch(_){} }
  }
  hideChatInput(){
    if (this.$chatInput){ try { this.$chatInput.blur(); } catch(_){} }
  }

  /* instance.new("Message") port  big center overlay text */
  showSystemMessage(text){
    this.$messageBox.textContent=text;
    this.$messageBox.style.display='block';
    this.$messageBox.style.opacity='1';
    clearTimeout(this._mtHide);
  }
  hideSystemMessage(){
    this.$messageBox.style.opacity='0';
    clearTimeout(this._mtHide);
    this._mtHide=setTimeout(()=>{ this.$messageBox.style.display='none'; }, 350);
  }

  /* instance.new("Hint") port  the classic one-line hint, top center */
  showHint(text){
    if (!this.$hintBox) return;
    this.$hintBox.textContent=text;
    this.$hintBox.style.display=text? 'block' : 'none';
  }
  hideHint(){
    if (this.$hintBox) this.$hintBox.style.display='none';
  }

  notify(text){
    const div=document.createElement('div');
    div.className='noti';
    div.textContent=text;
    this.$msgs.appendChild(div);
    setTimeout(()=>{ div.style.opacity='0'; setTimeout(()=>div.remove(), 600); }, 3200);
  }

  /* Join-time performance warning.  A place's Workspace part total comes
   * from world.build(); the threshold is the browser port's join budget,
   * not an engine constant (see PORT.md).  Shipped places below it:
   * Crossroads ~1.7k, HappyHome ~2.0k; at/above it: Haunted Mansion ~2.7k,
   * RobloxHQ ~8.1k.  The banner follows the classic hint styling and can
   * be dismissed with a click (index.html onclick). */
  showPerfWarning(text){
    const el=document.getElementById('perfWarn');
    if (!el) return;
    this.hidePerfWarning();
    el.textContent=text||'';
    el.style.display='block';
    el.style.opacity='1';
    this._perfTimers=[setTimeout(()=>{
      el.style.opacity='0';
      this._perfTimers.push(setTimeout(()=>{ el.style.display='none'; },500));
    },8000)];
  }
  hidePerfWarning(){
    for (const t of this._perfTimers||[]) clearTimeout(t);
    this._perfTimers=[];
    const el=document.getElementById('perfWarn');
    if (el){ el.style.display='none'; el.style.opacity='1'; }
  }
  warnIfHighPartCount(parts){
    const n=Number(parts)||0;
    if (n<UI.PERF_WARN_PARTS) return false;
    this.showPerfWarning('High part count ('+n+' parts)! Performance may be slow on older devices!');
    return true;
  }

  /* 2007 HealthHud (FUN_0060d5f0): a 10x100 vertical bar that drains from
   * the top (red lost portion over the green fill), with the blue "Health"
   * caption below it.  `percent` is Health/MaxHealth (0..1). */
  health(percent){
    const p=Math.max(0, Math.min(1, Number(percent)||0));
    if (this.$healthFill) this.$healthFill.style.height=(p*100)+'%';
    if (this.$healthHud && this.$healthHud.setAttribute)
      this.$healthHud.setAttribute('aria-valuenow', String(Math.round(p*100)));
  }

  info(text){
    const el=document.getElementById('infoLine');
    if (el){ el.style.display='block'; el.textContent=text; }
  }

  setTools(list){
    this.$hotbar.innerHTML='';
    this.tools=list;
    this.selected=-1;
    let n=1;
    for (const t of list){
      const slot=document.createElement('div');
      slot.className='tool';
      const img=document.createElement('img');
      img.src=window.RBLXxml.assetMap(t.icon)||'content/textures/GameTool.png';
      img.title=t.name;
      const k=document.createElement('span');
      k.textContent=(n<=9)? String(n) : '0';
      slot.appendChild(img); slot.appendChild(k);
      slot.title=t.name;
      const idx=n-1;
      slot.onclick=()=>this.selectTool(idx);
      this.$hotbar.appendChild(slot);
      n++;
    }
  }

  clearToolSelection(){
    this.selected=-1;
    if (!this.$hotbar) return;
    const slots=this.$hotbar.querySelectorAll('.tool');
    for (const s of slots) s.classList.remove('active');
  }

  selectTool(i){
    if (!this.tools.length || i<0 || i>=this.tools.length) return;
    const slots=this.$hotbar.querySelectorAll('.tool');
    if (this.selected===i){
      this.selected=-1;
      slots[i] && slots[i].classList.remove('active');
      this.onSelectTool && this.onSelectTool(i, null);      // unequip
      window.Sounds.sound('switch.wav', {volume:0.35});
    } else {
      if (this.selected>=0 && slots[this.selected]) slots[this.selected].classList.remove('active');
      this.selected=i;
      slots[i] && slots[i].classList.add('active');
      this.onSelectTool && this.onSelectTool(i, this.tools[i]);
      window.Sounds.sound('switch.wav', {volume:0.35});
    }
  }

  menuOpen(className){
    document.querySelectorAll('.menu').forEach(m=>{
      if (!m.classList.contains(className)) m.style.display='none';
    });
    const m=document.querySelector('.'+className);
    if (m) m.style.display = (m.style.display==='block')? 'none' : 'block';
  }

  /* HUD visibility for the join flow */
  showInGameHUD(){
    document.getElementById('menubar').style.display='flex';
    document.getElementById('playerList').style.display='block';
    document.getElementById('chatPanel').style.display='block';
    this.$hotbar.style.display='flex';
    const cc=document.getElementById('cameraControls');
    if (cc) cc.style.display='grid';
    const rb=document.getElementById('reportBtn');
    if (rb) rb.style.display='block';
    if (this.$healthHud) this.$healthHud.style.display='flex';
  }
  hideInGameHUD(){
    this.hideChatInput();
    if (window.RBLXsafechat) window.RBLXsafechat.close();
    document.getElementById('menubar').style.display='none';
    document.getElementById('playerList').style.display='none';
    document.getElementById('chatPanel').style.display='none';
    this.$hotbar.style.display='none';
    const cc=document.getElementById('cameraControls');
    if (cc) cc.style.display='none';
    const rb=document.getElementById('reportBtn');
    if (rb) rb.style.display='none';
    if (this.$healthHud) this.$healthHud.style.display='none';
  }
}

window.RBLXui=UI;
/* Workspace part count at which joining shows the performance warning.
 * 2500 sits above the shipped places that join cleanly in the browser
 * (Crossroads 1679, HappyHome 1964) and catches the heavy ones
 * (Haunted Mansion 2731, RobloxHQ 8077).  This is a browser-port budget,
 * not a 2007 engine constant. */
UI.PERF_WARN_PARTS=2500;
})();
