/* ============================================================
 * scriptport.js  ports of the actual Lua Scripts shipped inside
 * the place files (their Source strings are the single source):
 *
 *  Crossroads.rbxl (25 scripts):
 *   - 5× "Regenerate X"      → world snapshot/remove/restore cycle,
 *                              Message instance → center overlay
 *   - 13× onTouched pads     → Torso.Velocity = (0,200,0) after 0.5s
 *   - LeaderboardV3          → deaths counter (single-player port)
 *   - AndYetItMoves          → Lighting:SetMinutesAfterMidnight(+1)/s
 *                              (ported as a day tint cycle)
 *   - 4× team beacon scripts  → not ported (they drive team play and
 *                              BodyPosition movers; single-player no-op
 *                               see PORT.md)
 *  BattleArmorScript         → touch doubles MaxHealth + full heal
 * ============================================================ */
(function(){
"use strict";

function classify(src){
  if (/Torso\.Velocity\s*=\s*Vector3\.new\(0,\s*200,\s*0\)/.test(src)) return 'jumppad';
  if (/putOnArmor|Battle Armor/.test(src)) return 'armor';
  if (/RegenerationTime/.test(src) || (src.indexOf('messageText')>=0 && src.indexOf('backup')>=0)) return 'regen';
  if (/SetMinutesAfterMidnight/.test(src)) return 'daycycle';
  if (/leaderstats/.test(src)) return 'leaderboard';
  return 'skip';
}

/* extract the regen model names:  model = game.Workspace.LostTemple
 *                                   ramp = game.Workspace:findFirstChild("Overhead Ramp") */
function regenModels(src){
  const out=[];
  const re=/(\w+)\s*=\s*game\.Workspace(?::findFirstChild\("([^"]+)"\)|\.([\w]+))/g;
  let m;
  while ((m=re.exec(src))){
    out.push(m[2]||m[3]);
  }
  const seen=new Set();
  return out.filter(n=>n && !seen.has(n) && seen.add(n));
}

class PlaceScriptRunner {
  constructor(world, ui, character){
    this.world=world; this.ui=ui; this.character=character;
    this.jobs=[];        // {kind, ...}
    this.dayPhase=0;
    this.wipeouts=0;
    this.interpreted=false;   // true → scripts run on the Lua layer
  }

  init(parsed){
    this.parsed=parsed;
    /* interpreter-first: run the shipped Source strings on the Lua
     * translation layer (RBLXenv). Every script connects/dispatches
     * exactly like 2007  the hardcoded jobs below are only the
     * fallback for a headless env without the bridge. */
    if (window.RBLXlua && window.RBLXenv){
      try {
        window.RBLXenv.forPlace(parsed, this.world, this.ui, this.character);
        const n=window.RBLXenv.launchPlaceScripts(err=>{
          console.warn('[scriptport] unsupported in script: '+(err&&err.message));
        });
        console.log('[scriptport] lua translation layer running '+n+' script(s) from Source');
        this.interpreted=(n>0);
        if (this.interpreted) return;
      } catch (err){
        console.error('[scriptport] bridge init failed  hardcoded ports: '+err.message);
      }
    }
    this.initHardcoded(parsed);
  }

  /* pre-interpreter hardcoded ports (kept as fallback) */
  initHardcoded(parsed){
    for (const inst of parsed.instances){
      if (inst.cls!=='Script') continue;
      const src=inst.props.Source||'';
      const kind=classify(src);
      const name=inst.props.Name||'Script';
      switch (kind){
        case 'regen': {
          const names=regenModels(src);
          if (!names.length) break;
          const parent=inst.parent;
          const rt=parent && (parent.findFirst('RegenerationTime')||parent.findFirst('regenerationTime'));
          const rd=parent && (parent.findFirst('RegenerationDelay')||parent.findFirst('regenerationDelay'));
          this.jobs.push({ kind:'regen', names,
            message:(/messageText\s*=\s*"([^"]*)"/.exec(src)||[])[1]||'',
            regenTime: rt? (rt.props.Value||60) : 60,
            regenDelay: rd? (rd.props.Value||4) : 4,
            phase:'wait', t:60, busy:false });
          break;
        }
        case 'jumppad': {
          // script.Parent part = the pad
          const part=inst.parent;
          if (part && (part.cls==='Part')){
            this.jobs.push({ kind:'jumppad', part, cooldown:0 });
          }
          break;
        }
        case 'armor': {
          const part=inst.parent;
          if (part){
            this.jobs.push({ kind:'armor', part, cooldown:0 });
          }
          break;
        }
        case 'daycycle':
          this.jobs.push({ kind:'daycycle', acc:0 });
          break;
        case 'leaderboard':
          this.jobs.push({ kind:'leaderboard' });
          break;
        default:
          console.log('[scriptport] no port for "'+name+'" (nop)');
      }
    }
    console.log('[scriptport] jobs:', this.jobs.length,
      this.jobs.filter(j=>j.kind==='regen').length+' regen,',
      this.jobs.filter(j=>j.kind==='jumppad').length+' jumppads,',
      this.jobs.filter(j=>j.kind==='armor').length+' armor');
  }

  setCharacter(c){
    this.character=c;
    if (this.interpreted&&window.RBLXenv) window.RBLXenv.setCharacter(c);
  }

  /* NOTE: interpreted scripts are stepped from main.js through
   * RBLXenv.fireStepped(dt)+RBLXlua.sched.tick(dt)  this step() only
   * owns the hardcoded fallback jobs. */
  step(dt){
    if (this.interpreted) return;
    const c=this.character, w=this.world;
    if (!c) return;
    const p=c.group.position;
    for (const j of this.jobs){
      if (j.kind==='regen'){
        j.t-=dt;
        if (j.phase==='wait' && j.t<=0 && !j.busy){
          j.busy=true;
          if (j.message && w.messageWindow!==j){ this.ui.showSystemMessage(j.message); w.messageWindow=j; }
          j.snapshots=(j.snapshots||[]);
          for (const nm of j.names){
            const inst=w.findModelByName(nm);
            if (inst) j.snapshots.push(w.removeModel(inst).snap);
          }
          j.phase='delay'; j.t=j.regenDelay;
        } else if (j.phase==='delay' && j.t<=0){
          let restored=0;
          for (const s of (j.snapshots||[])) restored+=w.restoreModel(s);
          j.snapshots=[];
          if (j.message){ this.ui.hideSystemMessage(); w.messageWindow=null; }
          j.busy=false; j.phase='wait';
          j.t=j.regenTime*(1-Math.random()*0.8);           // the literal jitter
        }
      } else if (j.kind==='jumppad'){
        if (j.cooldown>0){ j.cooldown-=dt; continue; }
        const look=w.partLook.get(j.part);
        if (look && look.aabb && !look.destroyed && this._touching(look.aabb)){
          j.cooldown=0.6;
          /* literal port: wait(0.5) → h.Parent.Torso.Velocity=(0,200,0) */
          setTimeout(()=>{ if (c.alive) c.velocity.set(0,200,0); }, 500);
        }
      } else if (j.kind==='armor'){
        if (j.cooldown>0){ j.cooldown-=dt; continue; }
        const look=w.partLook.get(j.part);
        if (look && look.aabb && !look.destroyed && this._touching(look.aabb)){
          j.cooldown=2.0;
          if (c.alive){
            c.maxHealth=c.maxHealth*2;                     // "doubles your MaxHealth"
            c.health=c.maxHealth;                          // "heals you to full power"
            this.ui.chat('Battle Armor: MaxHealth doubled to '+c.maxHealth, null, '#ffd27f');
            window.Sounds.sound('victory.wav', {volume:0.55});
          }
        }
      } else if (j.kind==='daycycle'){
        // AndYetItMoves: +1 minute per second  a full 24h day loop.
        j.acc+=dt;
        if (j.acc>=1){
          j.acc-=1;
          this.dayPhase=(this.dayPhase+1)%1440;
          if (w.applyTimeOfDay){ w.applyTimeOfDay(this.dayPhase); }
        }
      }
    }
  }

  _touching(aabb){
    const c=this.character, p=c.group.position;
    return (p.x+2.2 > aabb.min.x && p.x-2.2 < aabb.max.x &&
            p.z+0.75 > aabb.min.z && p.z-0.75 < aabb.max.z &&
            p.y+2.2 > aabb.min.y && p.y-3.2 < aabb.max.y);
  }

  /* LeaderboardV3 port front-end */
  registerWipeout(){
    this.wipeouts++;
    this.ui.chat('Wipeout #'+this.wipeouts+' (Wipeouts)', 'Leaderboard', '#bbb');
  }
}

window.RBLXscript={ classify, regenModels, PlaceScriptRunner };
})();
