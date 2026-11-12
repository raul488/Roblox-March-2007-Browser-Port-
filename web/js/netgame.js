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

  function cleanChat(text) {
    return String(text == null ? '' : text)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 100);
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
      this.active = true;
      this.input = ZERO_INPUT;
      this.inputAcc = 0;
      this.snapAcc = 0;
      this.tick = 0;
      this.selfSynced = false;

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
            input: { moveDir: new THREE.Vector3(), jump: false, climbAxis: 0 },
            lastInput: 0
          };
          this.remotes.set(p.id, rec);
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
        }
        return;
      }

      if (d.k === 's') this.applySnapshot(d);
      else if (d.k === 'c') this.clientChat(d);
    }

    chat(text) {
      if (!this.active) return;
      var clean = cleanChat(text);
      if (!clean) return;
      if (this.mode === 'host') {
        if (this.ui && this.ui.chat) this.ui.chat(clean, this.nameOf(this.selfId));
        this.session.send({ k: 'c', from: this.selfId, text: clean });
      } else {
        this.session.send({ k: 'c', text: clean });
      }
    }

    hostChat(from, text) {
      var clean = cleanChat(text);
      if (!clean) return;
      var name = this.nameOf(from);
      if (this.ui && this.ui.chat) this.ui.chat(clean, name);
      this.session.send({ k: 'c', from: from, text: clean });
    }

    clientChat(d) {
      var clean = cleanChat(d.text);
      if (!clean) return;
      if (this.ui && this.ui.chat) this.ui.chat(clean, this.nameOf(d.from));
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
            input: { moveDir: new THREE.Vector3(), jump: false, climbAxis: 0 },
            lastInput: 0
          };
          this.remotes.set(e.i, rec);
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
