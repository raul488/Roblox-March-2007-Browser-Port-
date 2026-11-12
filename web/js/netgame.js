/* ============================================================
 * netgame.js  host-authoritative characters and chat over the relay.
 *
 * Host & Play: the host's browser is the authority. It runs the place,
 * simulates every joined player's character, and sends filtered snapshots
 * through the relay. Joiners only run local prediction and render remote
 * avatars; they never run the place's server Scripts.
 *
 * Tools, dynamic parts and place scripts across players are the next
 * stage. This file deliberately owns only player state and chat.
 * ============================================================ */
(function () {
  "use strict";

  var THREE = window.THREE;
  var ZERO_INPUT = { moveDir: new THREE.Vector3(), jump: false, climbAxis: 0 };
  var SNAPSHOT_HZ = 20;
  var INPUT_HZ = 30;
  var INPUT_TIMEOUT = 500;
  var RESPAWN_MS = 5000;
  var AVATAR_SHIRT_LIMIT = 48 * 1024;
  var MAX_SNAPSHOT_ENTRIES = 64;
  var MAX_REMOTES = 32;
  var MAX_PROFILES = 32;
  var MAX_NET_PARTS = 4096;         /* runtime parts above the loaded place */
  var MAX_NET_PARTS_PER_SEC = 1024; /* regen models can coincide in a burst */

  function finiteNum(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clampNum(value, min, max, fallback) {
    var n = Number(value);
    if (!Number.isFinite(n)) n = fallback;
    return Math.min(max, Math.max(min, n));
  }

  function wrapYaw(value) {
    var n = finiteNum(value, 0);
    return ((n % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  }

  function filterChat(text) {
    if (window.RBLXchatfilter && window.RBLXchatfilter.clean) {
      return window.RBLXchatfilter.clean(text);
    }
    var s = String(text == null ? '' : text);
    if (!s || /[^\x20-\x7E]/.test(s)) {
      return { ok: false, error: 'Chat is ASCII only.' };
    }
    s = s.replace(/\s+/g, ' ').trim().slice(0, 100);
    return s ? { ok: true, text: s } : { ok: false, error: 'Message is empty.' };
  }

  function readColors(src) {
    var out = {};
    if (!src || typeof src !== 'object') return out;
    for (var key of ['head', 'torso', 'arms', 'legs']) {
      var n = Number(src[key]);
      if (!Number.isFinite(n)) continue;
      if (window.BrickColorFromId && !window.BrickColorFromId(n)) continue;
      out[key] = n;
    }
    return out;
  }

  function sanitizeAvatar(d) {
    if (!d || typeof d !== 'object') return null;
    var colors = readColors(d.c);
    var shirt = null;
    if (typeof d.t === 'string' &&
        /^data:image\/png;base64,/i.test(d.t) &&
        d.t.length <= AVATAR_SHIRT_LIMIT &&
        pngSizeOk(d.t)) {
      shirt = d.t;
    }
    if (!Object.keys(colors).length && !shirt) return null;
    return { colors: colors, shirt: shirt };
  }

  /* Only accept a small PNG with sane dimensions from the network. Normal
   * clients send a 128px PNG produced by shrinkShirt below. */
  function pngSizeOk(url) {
    try {
      var comma = url.indexOf(',');
      if (comma < 0) return false;
      var head = atob(url.slice(comma + 1, comma + 1 + 40));
      if (head.slice(0, 8) !== '\x89PNG\r\n\x1a\n') return false;
      var w = ((head.charCodeAt(16) & 255) << 24) |
              ((head.charCodeAt(17) & 255) << 16) |
              ((head.charCodeAt(18) & 255) << 8) |
              (head.charCodeAt(19) & 255);
      var h = ((head.charCodeAt(20) & 255) << 24) |
              ((head.charCodeAt(21) & 255) << 16) |
              ((head.charCodeAt(22) & 255) << 8) |
              (head.charCodeAt(23) & 255);
      return w > 0 && h > 0 && w <= 256 && h <= 256;
    } catch (_) {
      return false;
    }
  }

  /* Downscale the local T-shirt once so the relay's 64 KB frame limit is
   * never a problem and remote clients get a small PNG. */
  function shrinkShirt(url) {
    return new Promise(function (resolve) {
      if (!url || typeof url !== 'string' ||
          !/^data:image\/(png|jpeg|webp);base64,/i.test(url) ||
          typeof document === 'undefined' || typeof Image === 'undefined') {
        resolve(null);
        return;
      }
      var img = new Image();
      img.onload = function () {
        try {
          var sizes = [128, 96, 64];
          for (var i = 0; i < sizes.length; i++) {
            var c = document.createElement('canvas');
            c.width = c.height = sizes[i];
            var g = c.getContext('2d');
            g.clearRect(0, 0, c.width, c.height);
            g.drawImage(img, 0, 0, c.width, c.height);
            var out = c.toDataURL('image/png');
            if (out.length <= AVATAR_SHIRT_LIMIT) return resolve(out);
          }
          resolve(null);
        } catch (_) {
          resolve(null);
        }
      };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
  }

  class NetGame {
    constructor(opts) {
      this.mode = opts.mode;                 // 'host' | 'client'
      this.session = opts.session;
      this.scene = opts.scene;
      this.world = opts.world;
      this.ui = opts.ui;
      this.character = opts.character;
      this.controller = opts.controller;
      this.parsed = opts.parsed;

      this.players = [];
      this.remotes = new Map();
      this.profiles = new Map();
      this.avatarSeen = new Set();
      this.active = true;
      this.input = ZERO_INPUT;
      this.inputAcc = 0;
      this.snapAcc = 0;
      this.tick = 0;
      this.selfSynced = false;
      this.localRespawnAt = 0;
      this.partAcc = 0;
      this.fx = [];
      this.mouse = null;
      this.cameraView = null;
      this.selectedTool = null;
      this.toolAcc = 0;
      this.localTool = null;
      this.selfColorId = 0;
      this.chatAt = 0;
      this.chatLog = new Map();
      this.remoteChatTimes = [];
      /* client-side limits against a malicious host */
      this.netBase = (window.RBLXenv && window.RBLXenv.state && window.RBLXenv.state.netMap)
        ? window.RBLXenv.state.netMap.size : 0;
      this.netCreateWin = null;

      var localPlayer = window.RBLXplayer || {};
      this.avatar = { colors: readColors(localPlayer.colors), shirt: null };
      this.avatarReady = shrinkShirt(localPlayer.tshirt).then(url => {
        this.avatar.shirt = url;
      });

      this.selfId = String(this.session.self || '');
      this.hostId = String(this.session.host || '');
      this.players = Array.isArray(this.session.players) ? this.session.players : [];
      this.selfName = this.nameOf(this.selfId);

      this.session.onMessage = msg => this.onMessage(msg);
      this.session.onRoster = list => this.onRoster(list);
      this.session.onClose = reason => this.onClose(reason);
      this.applySelfName();
      this.updatePlayersUI();
    }

    start() {
      this.syncRoster(this.players).catch(() => {});
      this.updatePlayersUI();
      this.avatarReady.then(() => {
        if (!this.active) return;
        if (this.mode === 'client') this.sendAvatar();
        else if (this.session.send) this.session.send({ k: 'who' });
      }).catch(() => {});
      if (this.mode === 'host') this.sendSnapshot();
    }

    nameOf(id) {
      for (var i = 0; i < this.players.length; i++) {
        if (this.players[i] && this.players[i].id === id) return this.players[i].name;
      }
      return 'Player';
    }

    applySelfName() {
      if (!this.character) return;
      var name = this.nameOf(this.selfId);
      if (name && name !== 'Player' && this.character.playerName !== name) {
        this.character.playerName = name;
        if (this.character._drawTag) this.character._drawTag();
      }
    }

    setMouse(mouse, camera) {
      this.mouse = mouse || null;
      this.cameraView = camera || this.cameraView;
    }

    teamCSS(id) {
      id = id | 0;
      if (!id) return '#ffffff';
      var e = window.BrickColorFromId ? window.BrickColorFromId(id) : null;
      return e && e.rgb
        ? 'rgb(' + e.rgb[0] + ',' + e.rgb[1] + ',' + e.rgb[2] + ')'
        : '#ffffff';
    }

    selfTeamColor() {
      if (this.mode === 'client') return this.selfColorId || 0;
      var E = window.RBLXenv;
      var id = E && E.state ? E.state.playerTeamColor : null;
      return id != null ? (id | 0) : 0;
    }

    equipTool(t) {
      if (this.mode !== 'client') return;
      if (!t) {
        this.selectedTool = null;
        this.session.send({ k:'tool', e:2 });
        if (this.character && this.character.setToolVisual) this.character.setToolVisual(null);
        if (this.character) this.character.toolEquipped = false;
        return;
      }
      var b = Number(t.binType) || 0;
      if (!(b >= 1 && b <= 7)) {
        this.equipTool(null);
        if (this.ui && this.ui.notify) this.ui.notify('That custom gear is host-only.');
        return;
      }
      this.selectedTool = { binType:b, name:t.name };
      this.session.send({ k:'tool', e:1, b:b, name:t.name });
      if (this.character && this.character.setToolVisual) this.character.setToolVisual(b);
      if (this.character) this.character.toolEquipped = true;
      if (this.ui && this.ui.chat) this.ui.chat('Equipped: ' + t.name, null, '#ffff00');
    }

    remoteTool(from, d) {
      var rec = this.remotes.get(from);
      if (!rec || !rec.character) return;
      var e = Number(d.e);
      if (e !== 0 && e !== 1 && e !== 2) return;
      var now = performance.now();
      if (e !== 0) {
        if (rec.toolAt && now - rec.toolAt < 250) return;
        rec.toolAt = now;
      }
      if (e === 2) {
        rec.tool = null;
        rec.toolBin = null;
        rec.character.setToolVisual(null);
        rec.character.toolEquipped = false;
        return;
      }
      if (e === 1) {
        var b = Number(d.b);
        if (!Number.isInteger(b) || b < 1 || b > 7) return;
        if (rec.toolBin === b) return;              // already held
        var inv = (this.world && this.world.inventory) || [];
        if (!inv.some(function (h) {
          return (Number(h.props && h.props.BinType) || 0) === b;
        })) return;
        if (!window.RBLXtools || !window.RBLXtools.ToolManager) return;
        var tm = new window.RBLXtools.ToolManager(this.scene, this.world, null);
        tm.remote = true;
        tm.character = rec.character;
        tm.activeInst = null;
        tm.activeKind = 'HopperBin';
        tm.binType = b;
        tm.hasScript = false;
        tm.coolDown = 0;
        rec.tool = { tm:tm, binType:b, name:String(d.name || '').slice(0, 40),
                     mouse:{ leftPressed:false, leftDown:false, x:0, y:0, ray:null } };
        rec.toolBin = b;
        rec.character.setToolVisual(b);
        rec.character.toolEquipped = true;
        return;
      }
      if (!rec.tool) return;
      var m = rec.tool.mouse;
      if (Array.isArray(d.o) && Array.isArray(d.d) && d.o.length >= 3 && d.d.length >= 3){
        var ox=Number(d.o[0]), oy=Number(d.o[1]), oz=Number(d.o[2]);
        var dx=Number(d.d[0]), dy=Number(d.d[1]), dz=Number(d.d[2]);
        var len=Math.hypot(dx,dy,dz);
        var p=rec.character.group.position;
        if (isFinite(ox)&&isFinite(oy)&&isFinite(oz)&&len>0.001 &&
            Math.hypot(ox-p.x,oy-p.y,oz-p.z) <= 120){
          m.ray = {
            origin: new THREE.Vector3(ox,oy,oz),
            dir: new THREE.Vector3(dx/len,dy/len,dz/len)
          };
        }
      }
      var mx=Number(d.x), my=Number(d.y);
      if (isFinite(mx)) m.x=mx;
      if (isFinite(my)) m.y=my;
      if (d.p) m.leftPressed=true;
      m.leftDown=!!d.f;
    }

    updatePlayersUI() {
      if (!this.ui || !this.ui.setPlayers) return;
      this.ui.setPlayers(this.players.map(p => {
        var rc = this.remotes.get(p.id);
        var color = p.id === this.selfId
          ? this.selfTeamColor()
          : (rc && rc.teamColor) || 0;
        return {
          name: p.name,
          self: p.id === this.selfId,
          host: p.id === this.hostId,
          color: color ? this.teamCSS(color) : null
        };
      }));
    }

    onRoster(list) {
      this.players = Array.isArray(list) ? list : [];
      this.selfName = this.nameOf(this.selfId);
      this.applySelfName();
      this.updatePlayersUI();
      this.syncRoster(this.players).catch(() => {});
    }

    spawnPos() {
      var pads = (this.world.spawnPoints || []).filter(s => !s.destroyed);
      if (pads.length) {
        var sp = pads[Math.floor(Math.random() * pads.length)];
        return new THREE.Vector3(sp.cf.pos.x, sp.cf.pos.y + 7, sp.cf.pos.z);
      }
      return new THREE.Vector3(0, 100, 0);
    }

    sendAvatar() {
      if (!this.session || !this.session.send) return;
      this.session.send({
        k: 'avatar',
        c: this.avatar.colors,
        t: this.avatar.shirt
      });
    }

    applyAvatar(rec) {
      if (!rec || !rec.character || !rec.avatar) return;
      if (rec.avatar.colors) rec.character.applyBodyColors(rec.avatar.colors);
      if (rec.avatar.shirt) rec.character.applyTshirt(rec.avatar.shirt);
    }

    receiveAvatar(from, d) {
      if (!from || from === this.selfId || this.avatarSeen.has(from)) return;
      if (this.profiles.size >= MAX_PROFILES) return;
      var profile = sanitizeAvatar(d);
      if (!profile) return;
      this.avatarSeen.add(from);
      this.profiles.set(from, profile);
      var rec = this.remotes.get(from);
      if (rec) {
        rec.avatar = profile;
        this.applyAvatar(rec);
      }
      if (this.session.send) {
        this.session.send({
          k: 'avatar', id: from,
          c: profile.colors, t: profile.shirt
        });
      }
      this.sendProfilesTo(from);
    }

    sendProfilesTo(id) {
      if (!this.session || !this.session.sendTo) return;
      this.avatarReady.then(() => {
        if (!this.active) return;
        this.session.sendTo([id], {
          k: 'avatar', id: this.selfId,
          c: this.avatar.colors, t: this.avatar.shirt
        });
        for (var entry of this.profiles) {
          if (entry[0] === id) continue;
          this.session.sendTo([id], {
            k: 'avatar', id: entry[0],
            c: entry[1].colors, t: entry[1].shirt
          });
        }
      }).catch(() => {});
    }

    applyAvatarMessage(d) {
      if (!d || typeof d.id !== 'string' || !d.id || d.id.length > 64 || d.id === this.selfId) return;
      if (this.avatarSeen.has(d.id)) return;
      if (this.profiles.size >= MAX_PROFILES) return;
      var profile = sanitizeAvatar(d);
      if (!profile) return;
      this.avatarSeen.add(d.id);
      this.profiles.set(d.id, profile);
      var rec = this.remotes.get(d.id);
      if (rec) {
        rec.avatar = profile;
        this.applyAvatar(rec);
      }
    }

    resetController(c) {
      if (!c) return;
      c.onGround = false;
      c.jumping = false;
      c.jumpLatch = false;
      c.jumpTime = 0;
      c.climbing = false;
      c.climbVol = null;
      c.climbN = { x: 0, z: 0 };
      c.groundLook = null;
    }

    respawnLocal() {
      if (!this.character) return;
      var at = this.spawnPos();
      this.character.group.position.copy(at);
      this.character.group.rotation.y = 0;
      this.character.velocity.set(0, 0, 0);
      this.character.respawn();
      this.character.onGround = false;
      this.resetController(this.controller);
      this.localRespawnAt = 0;
      this.sendSnapshot();
    }

    respawnRemote(rec) {
      if (!rec || !rec.character) return;
      var at = this.spawnPos();
      rec.character.group.position.copy(at);
      rec.character.group.rotation.y = 0;
      rec.character.velocity.set(0, 0, 0);
      rec.character.respawn();
      rec.character.onGround = false;
      this.resetController(rec.humanoid);
      rec.respawnAt = 0;
    }

    /* Create/remove remote avatars from the relay roster. The host also
     * owns a Humanoid per remote so it can simulate their input. */
    async syncRoster(players) {
      var seen = new Set();
      for (var i = 0; i < players.length; i++) {
        var p = players[i];
        if (!p || typeof p.id !== 'string') continue;
        seen.add(p.id);
        if (p.id === this.selfId) continue;

        var rec = this.remotes.get(p.id);
        if (!rec) {
          if (this.mode !== 'host') continue;   /* clients create from snapshots */
          if (this.remotes.size >= MAX_REMOTES) continue;
          rec = {
            id: p.id,
            name: p.name || 'Player',
            character: null,
            humanoid: null,
            target: new THREE.Vector3(),
            targetYaw: 0,
            velocity: new THREE.Vector3(),
            onGround: false,
            health: 100,
            alive: true,
            hasTarget: false,
            avatar: null,
            input: { moveDir: new THREE.Vector3(), jump: false, climbAxis: 0 },
            lastInput: 0,
            carryLook: null,
            carryPos: null,
            toolBin: 0,
            toolAt: 0,
            teamColor: 0
          };
          this.remotes.set(p.id, rec);
          rec.avatar = this.profiles.get(p.id) || null;
          this.loadRemote(rec).catch(err => {
            console.warn('[netgame] remote avatar failed: ' + (err && err.message));
          });
        } else if (p.name && p.name !== rec.name) {
          rec.name = p.name;
          if (rec.character) {
            rec.character.playerName = p.name;
            if (rec.character._drawTag) rec.character._drawTag();
          }
          if (this.mode === 'host' && rec.character && window.RBLXenv && window.RBLXenv.addNetPlayer) {
            window.RBLXenv.addNetPlayer(rec.id, rec.name, rec.character);
          }
        }
      }

      for (var id of Array.from(this.remotes.keys())) {
        if (!seen.has(id)) this.removeRemote(id);
      }
    }

    async loadRemote(rec) {
      var ch = new window.RBLXcharacter.Character(this.scene, this.world, rec.name);
      ch.remote = true;
      await ch.load();
      if (!this.active || this.remotes.get(rec.id) !== rec) {
        this.disposeCharacter(ch);
        return;
      }
      rec.character = ch;
      ch.group.position.copy(this.spawnPos());
      ch.group.rotation.y = rec.targetYaw;
      if (rec.hasTarget) {
        ch.group.position.copy(rec.target);
        ch.group.rotation.y = rec.targetYaw;
      }
      if (this.mode === 'host') {
        rec.humanoid = new window.RBLXphysics.Humanoid(ch, this.world, { remote: true });
        rec.humanoid.onGround = false;
      }
      if (rec.avatar) this.applyAvatar(rec);
      if (rec.toolBin && ch.setToolVisual) ch.setToolVisual(rec.toolBin);
      if (this.mode === 'host' && window.RBLXenv && window.RBLXenv.addNetPlayer) {
        var np = window.RBLXenv.addNetPlayer(rec.id, rec.name, ch);
        if (np && np.teamColor != null) rec.teamColor = np.teamColor;
      }
      this.updatePlayersUI();
    }

    disposeCharacter(ch) {
      if (!ch) return;
      if (ch.nameTag) {
        if (ch.nameTag.material) {
          if (ch.nameTag.material.map) ch.nameTag.material.map.dispose();
          ch.nameTag.material.dispose();
        }
      }
      this.scene.remove(ch.group);
    }

    removeRemote(id) {
      var rec = this.remotes.get(id);
      if (!rec) return;
      this.remotes.delete(id);
      this.profiles.delete(id);
      this.avatarSeen.delete(id);
      this.chatLog.delete(id);
      if (this.mode === 'host' && window.RBLXenv && window.RBLXenv.removeNetPlayer) {
        window.RBLXenv.removeNetPlayer(id);
      }
      if (rec.character) this.disposeCharacter(rec.character);
    }

    onMessage(msg) {
      if (!msg || !msg.d || typeof msg.d !== 'object') return;
      var d = msg.d;

      if (this.mode === 'host') {
        if (d.k === 'i') {
          var rec = this.remotes.get(msg.from);
          if (!rec) return;
          rec.input.moveDir.set(
            clampNum(d.x, -1, 1, 0), 0, clampNum(d.z, -1, 1, 0)
          );
          if (rec.input.moveDir.lengthSq() > 1) rec.input.moveDir.normalize();
          rec.input.jump = d.j === true;
          rec.input.climbAxis = clampNum(d.c, -1, 1, 0);
          rec.lastInput = performance.now();
        } else if (d.k === 'c') {
          this.hostChat(msg.from, d.text);
        } else if (d.k === 'avatar') {
          this.receiveAvatar(msg.from, d);
        } else if (d.k === 'tool') {
          this.remoteTool(msg.from, d);
        }
        return;
      }

      if (d.k === 's') this.applySnapshot(d);
      else if (d.k === 'c') this.clientChat(d);
      else if (d.k === 'parts') this.applyParts(d);
      else if (d.k === 'who') {
        this.avatarReady.then(() => {
          if (this.active) this.sendAvatar();
        }).catch(() => {});
      } else if (d.k === 'avatar') {
        this.applyAvatarMessage(d);
      }
    }

    chat(text) {
      if (!this.active) return;
      var result = filterChat(text);
      if (!result.ok) {
        if (this.ui && this.ui.notify) this.ui.notify(result.error);
        return;
      }
      var now = performance.now();
      if (this.chatAt && now - this.chatAt < 600) {
        if (this.ui && this.ui.notify) this.ui.notify('Chat is rate-limited.');
        return;
      }
      this.chatAt = now;
      if (this.mode === 'host') {
        if (this.ui && this.ui.chat) this.ui.chat(result.text, this.nameOf(this.selfId));
        this.session.send({ k: 'c', from: this.selfId, text: result.text });
      } else {
        this.session.send({ k: 'c', text: result.text });
      }
    }

    hostChat(from, text) {
      var now = performance.now();
      var log = this.chatLog.get(from);
      if (!log) {
        log = { last: 0, times: [] };
        this.chatLog.set(from, log);
      }
      if (log.last && now - log.last < 600) return;
      log.times = log.times.filter(t => now - t < 5000);
      if (log.times.length >= 5) return;

      var result = filterChat(text);
      if (!result.ok) return;

      log.last = now;
      log.times.push(now);
      var name = this.nameOf(from);
      if (this.ui && this.ui.chat) this.ui.chat(result.text, name);
      this.session.send({ k: 'c', from: from, text: result.text });
    }

    clientChat(d) {
      var result = filterChat(d.text);
      if (!result.ok) return;
      var now = performance.now();
      this.remoteChatTimes = this.remoteChatTimes.filter(t => now - t < 2000);
      if (this.remoteChatTimes.length >= 8) return;
      this.remoteChatTimes.push(now);
      if (this.ui && this.ui.chat) this.ui.chat(result.text, this.nameOf(d.from));
    }

    step(dt, input, character, controller) {
      if (!this.active) return;
      this.input = input || ZERO_INPUT;
      if (character) this.character = character;
      if (this.controller) this.controller = controller || this.controller;

      if (this.mode === 'host') {
        var now = performance.now();
        if (this.character && !this.character.alive) {
          if (!this.localRespawnAt) this.localRespawnAt = now + RESPAWN_MS;
          else if (now >= this.localRespawnAt) this.respawnLocal();
        } else {
          this.localRespawnAt = 0;
        }
        for (var rec of this.remotes.values()) {
          if (!rec.character || !rec.humanoid) continue;
          if (!rec.character.alive) {
            if (!rec.respawnAt) rec.respawnAt = now + RESPAWN_MS;
            else if (now >= rec.respawnAt) this.respawnRemote(rec);
          } else {
            rec.respawnAt = 0;
          }
          if (now - rec.lastInput > INPUT_TIMEOUT) {
            rec.input.moveDir.set(0, 0, 0);
            rec.input.jump = false;
            rec.input.climbAxis = 0;
          }
          /* Remote characters are not part of the host's single-character
           * dynamics carry.  Compare the support they stood on last tick
           * with its current pose and carry them with a moving assembly. */
          var support = rec.character.groundLook;
          if (support && !support.destroyed && support.cf){
            if (rec.carryLook === support && rec.carryPos){
              var dx = support.cf.pos.x - rec.carryPos.x;
              var dy = support.cf.pos.y - rec.carryPos.y;
              var dz = support.cf.pos.z - rec.carryPos.z;
              if (Math.hypot(dx, dy, dz) < 12){
                rec.character.group.position.x += dx;
                rec.character.group.position.y += dy;
                rec.character.group.position.z += dz;
              }
            }
            rec.carryLook = support;
            rec.carryPos = { x:support.cf.pos.x, y:support.cf.pos.y, z:support.cf.pos.z };
          } else {
            rec.carryLook = null;
            rec.carryPos = null;
          }
          rec.humanoid.step(dt, rec.input);
          rec.character.step(dt, rec.input);
          if (rec.tool && rec.tool.tm){
            rec.tool.tm.update(dt, rec.tool.mouse, rec.character);
            rec.tool.mouse.leftPressed = false;
          }
        }
        this.snapAcc += dt;
        if (this.snapAcc >= 1 / SNAPSHOT_HZ) {
          this.snapAcc = 0;
          this.sendSnapshot();
        }
        this.partAcc += dt;
        if (this.partAcc >= 1 / 10) {
          this.partAcc = 0;
          this.sendParts();
        }
        return;
      }

      /* client: send input, interpolate remote avatars, correct own body */
      this.inputAcc += dt;
      if (this.inputAcc >= 1 / INPUT_HZ) {
        this.inputAcc = 0;
        this.sendInput();
      }
      if (this.selectedTool && this.mouse && this.world){
        this.toolAcc += dt;
        var edge = !!this.mouse.leftPressed;
        if (edge || this.toolAcc >= 1 / INPUT_HZ){
          this.toolAcc = 0;
          var ray = null;
          try {
            if (this.cameraView && this.cameraView.updateMatrixWorld) this.cameraView.updateMatrixWorld(true);
            if (this.world.rayFromCamera) ray = this.world.rayFromCamera(this.mouse.x, this.mouse.y);
          } catch (_) {}
          var tm = { k:'tool', e:0, p:edge, f:!!this.mouse.leftDown,
                     x:this.mouse.x, y:this.mouse.y };
          if (ray && ray.origin && ray.dir){
            tm.o = [ray.origin.x, ray.origin.y, ray.origin.z];
            tm.d = [ray.dir.x, ray.dir.y, ray.dir.z];
          }
          this.session.send(tm);
        }
      }
      var k = Math.min(1, 12 * dt);
      for (var r of this.remotes.values()) {
        var ch = r.character;
        if (!ch) continue;
        if (r.hasTarget) {
          ch.group.position.lerp(r.target, k);
          var dy = wrapYaw(r.targetYaw) - ch.group.rotation.y;
          dy = ((dy % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          if (dy > Math.PI) dy -= Math.PI * 2;
          if (!isFinite(dy)) dy = 0;
          ch.group.rotation.y += dy * k;
        }
        ch.velocity.copy(r.velocity);
        ch.onGround = r.onGround;
        ch.health = r.health;
        ch.alive = r.alive;
        if (ch.nameTag) ch.nameTag.visible = r.alive;
        ch.step(dt, ZERO_INPUT);
      }
      this.stepFx(dt);
    }

    sendParts() {
      var E = window.RBLXenv;
      if (!E || !E.netDrain) return;
      var data = E.netDrain();
      var parts = Array.isArray(data.p) ? data.p : [];
      var dead = Array.isArray(data.d) ? data.d : [];
      var fx = Array.isArray(data.f) ? data.f : [];
      if (!parts.length && !dead.length && !fx.length) return;

      if (!parts.length){
        this.session.send({ k: 'parts', p: [], d: dead, f: fx });
        return;
      }
      var chunk = 40;
      for (var i = 0; i < parts.length; i += chunk){
        this.session.send({
          k: 'parts',
          p: parts.slice(i, i + chunk),
          d: i === 0 ? dead : [],
          f: i === 0 ? fx : []
        });
      }
    }

    applyParts(d) {
      var E = window.RBLXenv;
      if (!E || !E.state || !E.state.world) return;
      var list = Array.isArray(d.p) ? d.p : [];
      if (list.length > 256) list = list.slice(0, 256);
      var now = performance.now();
      if (!this.netCreateWin || now - this.netCreateWin.t >= 1000) {
        this.netCreateWin = { t: now, n: 0 };
      }
      for (var i = 0; i < list.length; i++){
        var p = list[i];
        if (!p || !p.i) continue;
        var inst = E.state.netMap.get(p.i);
        if (p.n && !inst){
          var made = E.state.netMap.size - this.netBase;
          if (made >= MAX_NET_PARTS || this.netCreateWin.n >= MAX_NET_PARTS_PER_SEC) continue;
          if (E.createNetPart(p)) this.netCreateWin.n++;
        } else if (inst){
          E.applyNetPart(inst, p);
        }
      }
      var dead = Array.isArray(d.d) ? d.d : [];
      if (dead.length > 512) dead = dead.slice(0, 512);
      for (var id of dead){
        var gone = E.state.netMap.get(id);
        if (!gone) continue;
        E.detachFromWorld(gone, true);
        if (gone.parent){
          var at = gone.parent.children.indexOf(gone);
          if (at >= 0) gone.parent.children.splice(at, 1);
          gone.parent = null;
        }
        E.state.netMap.delete(id);
      }
      var fx = Array.isArray(d.f) ? d.f : [];
      if (fx.length > 16) fx = fx.slice(0, 16);
      for (var j = 0; j < fx.length; j++) this.spawnFx(fx[j]);
    }

    spawnFx(f) {
      if (!f) return;
      if (this.fx.length >= 32) return;
      if (f.t === 'l'){
        if (!Array.isArray(f.a) || !Array.isArray(f.b) || f.a.length < 3 || f.b.length < 3) return;
        var ax=Number(f.a[0]), ay=Number(f.a[1]), az=Number(f.a[2]);
        var bx=Number(f.b[0]), by=Number(f.b[1]), bz=Number(f.b[2]);
        if (![ax,ay,az,bx,by,bz].every(Number.isFinite)) return;
        try {
          var lg = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(ax, ay, az),
            new THREE.Vector3(bx, by, bz)
          ]);
          var lm = new THREE.LineBasicMaterial({ color:0xff3010, transparent:true, opacity:0.85 });
          var line = new THREE.Line(lg, lm);
          this.scene.add(line);
          this.fx.push({ mesh:line, mat:lm, geo:lg, age:0, life:0.12 });
        } catch (_) {}
        return;
      }
      if (f.t !== 'e' || !Array.isArray(f.p) || f.p.length < 3) return;
      var ex=Number(f.p[0]), ey=Number(f.p[1]), ez=Number(f.p[2]);
      if (![ex,ey,ez].every(Number.isFinite)) return;
      var radius = clampNum(f.r, 0.5, 64, 4);
      try {
        var geo = new THREE.SphereGeometry(1, 15, 15);
        var mat = new THREE.MeshBasicMaterial({
          color: 0xffb000, transparent: true, opacity: 0.9, depthWrite: false
        });
        var mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(ex, ey, ez);
        mesh.scale.setScalar(0.1);
        this.scene.add(mesh);
        this.fx.push({ mesh: mesh, mat: mat, geo: geo, age: 0, radius: radius, life: 0.5 });
      } catch (_) { /* no THREE in a test */ }
      if (window.Sounds && window.Sounds.sound) {
        try { window.Sounds.sound('collide.wav', { volume: 0.8 }); } catch (_){}
      }
    }

    stepFx(dt) {
      for (var i = this.fx.length - 1; i >= 0; i--){
        var e = this.fx[i];
        e.age += dt;
        var k = Math.min(1, e.age / e.life);
        if (e.radius) e.mesh.scale.setScalar(e.radius * (0.2 + 0.8 * k));
        e.mat.opacity = 0.9 * (1 - k);
        if (k >= 1){
          if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
          if (e.geo) e.geo.dispose();
          if (e.mat) e.mat.dispose();
          this.fx.splice(i, 1);
        }
      }
    }

    sendInput() {
      if (!this.session || !this.session.send) return;
      var md = this.input && this.input.moveDir;
      this.session.send({
        k: 'i',
        x: md ? +md.x.toFixed(3) : 0,
        z: md ? +md.z.toFixed(3) : 0,
        j: !!(this.input && this.input.jump),
        c: (this.input && this.input.climbAxis) || 0
      });
    }

    playerState(id, ch, toolBin, teamColor) {
      var p = ch.group.position;
      var v = ch.velocity;
      return {
        i: id,
        p: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)],
        r: +(ch.group.rotation.y || 0).toFixed(3),
        v: [+(v.x || 0).toFixed(2), +(v.y || 0).toFixed(2), +(v.z || 0).toFixed(2)],
        g: ch.onGround ? 1 : 0,
        h: Math.max(0, Math.min(200, Number(ch.health) || 0)),
        a: ch.alive ? 1 : 0,
        t: Math.max(0, Math.min(7, Number(toolBin) || 0)),
        c: Math.max(0, Math.min(4096, Number(teamColor) || 0))
      };
    }

    sendSnapshot() {
      if (!this.session || !this.session.send) return;
      var list = [];
      if (this.character) list.push(this.playerState(this.selfId, this.character, this.localTool, this.selfTeamColor()));
      for (var rec of this.remotes.values()) {
        if (rec.character) list.push(this.playerState(rec.id, rec.character, rec.toolBin, rec.teamColor));
      }
      this.session.send({ k: 's', t: ++this.tick, p: list });
    }

    applySnapshot(d) {
      if (!Array.isArray(d.p)) return;
      var entries = Math.min(d.p.length, MAX_SNAPSHOT_ENTRIES);
      for (var i = 0; i < entries; i++) {
        var e = d.p[i];
        if (!e || typeof e.i !== 'string' || !e.i || e.i.length > 64 ||
            !Array.isArray(e.p) || e.p.length < 3) continue;
        var x = Number(e.p[0]), y = Number(e.p[1]), z = Number(e.p[2]);
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
        var yaw = wrapYaw(e.r);

        if (e.i === this.selfId) {
          if (!this.character) continue;
          var wasAlive = this.character.alive;
          var p = this.character.group.position;
          var err = Math.hypot(p.x - x, p.y - y, p.z - z);
          if (e.a === 0) {
            this.character.alive = false;
            if (this.character.nameTag) this.character.nameTag.visible = false;
          } else if (!wasAlive) {
            this.character.respawn();
            this.character.group.position.set(x, y, z);
            this.character.velocity.set(0, 0, 0);
            this.character.onGround = false;
            this.resetController(this.controller);
            this.selfSynced = true;
          }
          if (!this.selfSynced || err > 2.5 || Math.abs(p.y - y) > 3) p.set(x, y, z);
          this.selfSynced = true;
          /* A host-side impulse (jumppad, explosion, beacon throw) must
           * reach the local predictor: adopt the host velocity only when
           * it differs by more than normal walk/jump drift. */
          if (Array.isArray(e.v) && e.v.length >= 3 && this.character.velocity) {
            var hvx = clampNum(e.v[0], -1000, 1000, 0);
            var hvy = clampNum(e.v[1], -1000, 1000, 0);
            var hvz = clampNum(e.v[2], -1000, 1000, 0);
            var cv = this.character.velocity;
            if (Math.abs(hvy - cv.y) > 8 || Math.abs(hvx - cv.x) > 8 || Math.abs(hvz - cv.z) > 8)
              cv.set(hvx, hvy, hvz);
          }
          var h = Number(e.h);
          if (isFinite(h)) this.character.health = Math.max(0, Math.min(200, h));
          var sc = Math.max(0, Math.min(4096, Number(e.c) || 0));
          if (sc !== this.selfColorId) {
            this.selfColorId = sc;
            if (this.character.setTagColor) this.character.setTagColor(this.teamCSS(sc));
            this.updatePlayersUI();
          }
          continue;
        }

        var rec = this.remotes.get(e.i);
        if (!rec) {
          if (this.remotes.size >= MAX_REMOTES) continue;
          var name = this.nameOf(e.i);
          rec = {
            id: e.i,
            name: name,
            character: null,
            humanoid: null,
            target: new THREE.Vector3(),
            targetYaw: 0,
            velocity: new THREE.Vector3(),
            onGround: false,
            health: 100,
            alive: true,
            hasTarget: false,
            avatar: null,
            input: { moveDir: new THREE.Vector3(), jump: false, climbAxis: 0 },
            lastInput: 0,
            carryLook: null,
            carryPos: null,
            toolBin: 0,
            toolAt: 0,
            teamColor: 0
          };
          this.remotes.set(e.i, rec);
          rec.avatar = this.profiles.get(e.i) || null;
          this.loadRemote(rec).catch(err => {
            console.warn('[netgame] remote avatar failed: ' + (err && err.message));
          });
        }

        rec.target.set(x, y, z);
        rec.targetYaw = yaw;
        if (Array.isArray(e.v) && e.v.length >= 3) {
          rec.velocity.set(
            clampNum(e.v[0], -1000, 1000, 0),
            clampNum(e.v[1], -1000, 1000, 0),
            clampNum(e.v[2], -1000, 1000, 0)
          );
        }
        rec.onGround = !!e.g;
        rec.health = clampNum(e.h, 0, 200, 0);
        var wasDead = !rec.alive;
        rec.alive = e.a !== 0;
        var tb = clampNum(e.t, 0, 7, 0);
        if (tb !== rec.toolBin){
          rec.toolBin = tb;
          if (rec.character && rec.character.setToolVisual) rec.character.setToolVisual(tb || null);
        }
        var tc = clampNum(e.c, 0, 4096, 0);
        if (tc !== rec.teamColor){
          rec.teamColor = tc;
          if (rec.character && rec.character.setTagColor) rec.character.setTagColor(this.teamCSS(tc));
          this.updatePlayersUI();
        }
        if (wasDead && rec.alive) {
          rec.hasTarget = true;
          if (rec.character) {
            rec.character.respawn();
            rec.character.group.position.copy(rec.target);
            rec.character.group.rotation.y = yaw;
          }
        }
        if (!rec.hasTarget) {
          rec.hasTarget = true;
          if (rec.character) {
            rec.character.group.position.copy(rec.target);
            rec.character.group.rotation.y = yaw;
          }
        }
      }
    }

    onClose(reason) {
      if (!this.active) return;
      this.active = false;
      if (this.ui && this.ui.notify) {
        this.ui.notify(reason === 'hostLeft'
          ? 'Host left the room. Returning to the menu.'
          : 'Disconnected from the room. Returning to the menu.');
      }
      setTimeout(function () {
        try { location.reload(); } catch (_) { /* no location in tests */ }
      }, 1800);
    }

    dispose() {
      this.active = false;
      this.session.onMessage = null;
      this.session.onRoster = null;
      this.session.onClose = null;
      for (var id of Array.from(this.remotes.keys())) this.removeRemote(id);
    }
  }

  window.RBLXnetgame = { NetGame: NetGame };
})();
