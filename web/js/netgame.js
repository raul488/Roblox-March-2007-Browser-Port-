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
  var AVATAR_SHIRT_LIMIT = 48 * 1024;

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
      this.chatAt = 0;
      this.chatLog = new Map();
      this.remoteChatTimes = [];

      var localPlayer = window.RBLXplayer || {};
      this.avatar = { colors: readColors(localPlayer.colors), shirt: null };
      this.avatarReady = shrinkShirt(localPlayer.tshirt).then(url => {
        this.avatar.shirt = url;
      });

      this.selfId = String(this.session.self || '');
      this.hostId = String(this.session.host || '');
      this.players = Array.isArray(this.session.players) ? this.session.players : [];

      this.session.onMessage = msg => this.onMessage(msg);
      this.session.onRoster = list => this.onRoster(list);
      this.session.onClose = reason => this.onClose(reason);
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

    updatePlayersUI() {
      if (!this.ui || !this.ui.setPlayers) return;
      this.ui.setPlayers(this.players.map(p => ({
        name: p.name,
        self: p.id === this.selfId,
        host: p.id === this.hostId
      })));
    }

    onRoster(list) {
      this.players = Array.isArray(list) ? list : [];
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
      if (!d || !d.id || d.id === this.selfId) return;
      if (this.avatarSeen.has(d.id)) return;
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
            lastInput: 0
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
      if (rec.character) this.disposeCharacter(rec.character);
    }

    onMessage(msg) {
      if (!msg || !msg.d || typeof msg.d !== 'object') return;
      var d = msg.d;

      if (this.mode === 'host') {
        if (d.k === 'i') {
          var rec = this.remotes.get(msg.from);
          if (!rec) return;
          rec.input.moveDir.set(Number(d.x) || 0, 0, Number(d.z) || 0);
          if (rec.input.moveDir.lengthSq() > 1) rec.input.moveDir.normalize();
          rec.input.jump = !!d.j;
          rec.input.climbAxis = Number(d.c) || 0;
          rec.lastInput = performance.now();
        } else if (d.k === 'c') {
          this.hostChat(msg.from, d.text);
        } else if (d.k === 'avatar') {
          this.receiveAvatar(msg.from, d);
        }
        return;
      }

      if (d.k === 's') this.applySnapshot(d);
      else if (d.k === 'c') this.clientChat(d);
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
        for (var rec of this.remotes.values()) {
          if (!rec.character || !rec.humanoid) continue;
          if (now - rec.lastInput > INPUT_TIMEOUT) {
            rec.input.moveDir.set(0, 0, 0);
            rec.input.jump = false;
            rec.input.climbAxis = 0;
          }
          rec.humanoid.step(dt, rec.input);
          rec.character.step(dt, rec.input);
        }
        this.snapAcc += dt;
        if (this.snapAcc >= 1 / SNAPSHOT_HZ) {
          this.snapAcc = 0;
          this.sendSnapshot();
        }
        return;
      }

      /* client: send input, interpolate remote avatars, correct own body */
      this.inputAcc += dt;
      if (this.inputAcc >= 1 / INPUT_HZ) {
        this.inputAcc = 0;
        this.sendInput();
      }
      var k = Math.min(1, 12 * dt);
      for (var r of this.remotes.values()) {
        var ch = r.character;
        if (!ch) continue;
        if (r.hasTarget) {
          ch.group.position.lerp(r.target, k);
          var dy = r.targetYaw - ch.group.rotation.y;
          while (dy > Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          ch.group.rotation.y += dy * k;
        }
        ch.velocity.copy(r.velocity);
        ch.onGround = r.onGround;
        ch.health = r.health;
        ch.alive = r.alive;
        if (ch.nameTag) ch.nameTag.visible = r.alive;
        ch.step(dt, ZERO_INPUT);
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

    playerState(id, ch) {
      var p = ch.group.position;
      var v = ch.velocity;
      return {
        i: id,
        p: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)],
        r: +(ch.group.rotation.y || 0).toFixed(3),
        v: [+(v.x || 0).toFixed(2), +(v.y || 0).toFixed(2), +(v.z || 0).toFixed(2)],
        g: ch.onGround ? 1 : 0,
        h: Math.max(0, Math.min(200, Number(ch.health) || 0)),
        a: ch.alive ? 1 : 0
      };
    }

    sendSnapshot() {
      if (!this.session || !this.session.send) return;
      var list = [];
      if (this.character) list.push(this.playerState(this.selfId, this.character));
      for (var rec of this.remotes.values()) {
        if (rec.character) list.push(this.playerState(rec.id, rec.character));
      }
      this.session.send({ k: 's', t: ++this.tick, p: list });
    }

    applySnapshot(d) {
      if (!Array.isArray(d.p)) return;
      for (var i = 0; i < d.p.length; i++) {
        var e = d.p[i];
        if (!e || typeof e.i !== 'string' || !Array.isArray(e.p) || e.p.length < 3) continue;
        var x = Number(e.p[0]), y = Number(e.p[1]), z = Number(e.p[2]);
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
        var yaw = Number(e.r) || 0;

        if (e.i === this.selfId) {
          if (!this.character) continue;
          var p = this.character.group.position;
          var err = Math.hypot(p.x - x, p.y - y, p.z - z);
          if (!this.selfSynced || err > 2.5 || Math.abs(p.y - y) > 3) p.set(x, y, z);
          this.selfSynced = true;
          var h = Number(e.h);
          if (isFinite(h)) this.character.health = Math.max(0, Math.min(200, h));
          if (e.a === 0) this.character.alive = false;
          continue;
        }

        var rec = this.remotes.get(e.i);
        if (!rec) {
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
            lastInput: 0
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
          rec.velocity.set(Number(e.v[0]) || 0, Number(e.v[1]) || 0, Number(e.v[2]) || 0);
        }
        rec.onGround = !!e.g;
        rec.health = Math.max(0, Math.min(200, Number(e.h) || 0));
        rec.alive = e.a !== 0;
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
