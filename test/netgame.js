/* Focused host/client protocol checks for web/js/netgame.js.
 * Run with: node test/netgame.js
 * Characters/Humanoids/THREE are tiny stubs; this tests the wire logic. */
"use strict";

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  lerp(v, k) {
    this.x += (v.x - this.x) * k;
    this.y += (v.y - this.y) * k;
    this.z += (v.z - this.z) * k;
    return this;
  }
  lengthSq() { return this.x * this.x + this.z * this.z; }
  normalize() {
    const m = Math.hypot(this.x, this.y, this.z) || 1;
    this.x /= m; this.y /= m; this.z /= m;
    return this;
  }
}

class FakeCharacter {
  constructor(scene, world, name) {
    this.scene = scene;
    this.world = world;
    this.playerName = name;
    this.group = { position: new V3(), rotation: { y: 0 } };
    this.velocity = new V3();
    this.onGround = false;
    this.health = 100;
    this.alive = true;
    this.remote = false;
    this.nameTag = { visible: true, material: { map: { dispose() {} }, dispose() {} } };
  }
  async load() { return this; }
  step() {}
  _drawTag() {}
}

class FakeHumanoid {
  constructor(ch, world, opts) {
    this.ch = ch;
    this.world = world;
    this.remote = !!(opts && opts.remote);
    this.onGround = true;
  }
  step(dt, input) {
    const md = input && input.moveDir;
    if (md) {
      this.ch.group.position.x += md.x * 16 * dt;
      this.ch.group.position.z += md.z * 16 * dt;
    }
    this.ch.onGround = this.onGround;
  }
}

global.window = global;
global.THREE = { Vector3: V3 };
global.RBLXcharacter = { Character: FakeCharacter };
global.RBLXphysics = { Humanoid: FakeHumanoid };
global.location = { reload() {} };
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../web/js/netgame.js'), 'utf8'));
const NetGame = window.RBLXnetgame.NetGame;

const tick = () => new Promise(resolve => setImmediate(resolve));
const scene = { remove() {} };
const world = { spawnPoints: [{ cf: { pos: { x: 0, y: 0, z: 0 } } }] };

function makeUi() {
  const chats = [];
  return {
    chats,
    setPlayers(list) { this.players = list; },
    chat(text, who) { chats.push({ text, who }); },
    notify(text) { this.note = text; }
  };
}

function makeSession(mode, players) {
  const sent = [];
  return {
    sent,
    self: mode === 'host' ? 'host' : 'join',
    host: 'host',
    players,
    send(data) { sent.push(data); return true; }
  };
}

async function main() {
  const players = [
    { id: 'host', name: 'Alice', host: true },
    { id: 'join', name: 'Bob', host: false }
  ];

  /* Host: creates the remote avatar and sends authoritative snapshots. */
  const hostSession = makeSession('host', players);
  const hostUi = makeUi();
  const hostChar = new FakeCharacter(scene, world, 'Alice');
  const host = new NetGame({
    mode: 'host', session: hostSession, scene, world, ui: hostUi,
    character: hostChar, controller: new FakeHumanoid(hostChar, world), parsed: null
  });
  host.start();
  await tick();
  assert.ok(host.remotes.has('join'), 'host did not create a remote');
  const remote = host.remotes.get('join');
  assert.ok(remote.character, 'host remote character did not load');
  assert.ok(remote.humanoid && remote.humanoid.remote, 'host remote humanoid missing');

  hostSession.onMessage({ from: 'join', d: { k: 'i', x: 1, z: 0, j: false, c: 0 } });
  const before = remote.character.group.position.x;
  host.step(1 / 60, { moveDir: new V3(), jump: false, climbAxis: 0 }, hostChar, null);
  host.step(1 / 60, { moveDir: new V3(), jump: false, climbAxis: 0 }, hostChar, null);
  host.step(1 / 60, { moveDir: new V3(), jump: false, climbAxis: 0 }, hostChar, null);
  assert.ok(remote.character.group.position.x > before, 'host did not simulate remote input');

  const snap = hostSession.sent.filter(m => m.k === 's').pop();
  assert.ok(snap && Array.isArray(snap.p), 'host did not send a snapshot');
  assert.ok(snap.p.some(p => p.i === 'host'), 'snapshot missing host player');
  assert.ok(snap.p.some(p => p.i === 'join'), 'snapshot missing joiner');

  host.chat('hello');
  assert.ok(hostUi.chats.some(c => c.text === 'hello' && c.who === 'Alice'));
  assert.ok(hostSession.sent.some(m => m.k === 'c' && m.from === 'host'));

  hostSession.onMessage({ from: 'join', d: { k: 'c', text: 'hi host' } });
  assert.ok(hostUi.chats.some(c => c.text === 'hi host' && c.who === 'Bob'));
  assert.ok(hostSession.sent.some(m => m.k === 'c' && m.from === 'join'));

  /* Client: applies the host snapshot, creates the host avatar, corrects
   * its own body, sends input and receives chat. */
  const clientSession = makeSession('client', players);
  const clientUi = makeUi();
  const clientChar = new FakeCharacter(scene, world, 'Bob');
  const client = new NetGame({
    mode: 'client', session: clientSession, scene, world, ui: clientUi,
    character: clientChar, controller: new FakeHumanoid(clientChar, world), parsed: null
  });
  client.start();
  await tick();

  clientSession.onMessage({
    from: 'host',
    d: {
      k: 's', t: 1, p: [
        { i: 'host', p: [5, 3, 0], r: 0.5, v: [0, 0, 0], g: 1, h: 100, a: 1 },
        { i: 'join', p: [10, 3, 0], r: 0, v: [0, 0, 0], g: 1, h: 80, a: 1 }
      ]
    }
  });
  assert.ok(client.remotes.has('host'), 'client did not create the host avatar');
  await tick();
  const hostAvatar = client.remotes.get('host');
  assert.ok(hostAvatar.character, 'client host avatar did not load');
  assert.ok(hostAvatar.hasTarget, 'client host target missing');
  assert.strictEqual(clientChar.group.position.x, 10, 'own-body correction did not snap');
  assert.strictEqual(clientChar.health, 80, 'own health did not update');

  clientSession.onMessage({
    from: 'host',
    d: {
      k: 's', t: 2, p: [
        { i: 'host', p: [6, 3, 0], r: 0.5, v: [0, 0, 0], g: 1, h: 100, a: 1 },
        { i: 'join', p: [10, 3, 0], r: 0, v: [0, 0, 0], g: 1, h: 80, a: 1 }
      ]
    }
  });
  const beforeLerp = hostAvatar.character.group.position.x;
  client.step(1 / 30, { moveDir: new V3(1, 0, 0), jump: false, climbAxis: 0 }, clientChar, null);
  assert.ok(hostAvatar.character.group.position.x > beforeLerp, 'remote interpolation did not move');
  assert.ok(clientSession.sent.some(m => m.k === 'i' && m.x === 1), 'client did not send input');

  clientSession.onMessage({ from: 'host', d: { k: 'c', from: 'host', text: 'welcome' } });
  assert.ok(clientUi.chats.some(c => c.text === 'welcome' && c.who === 'Alice'));
  client.chat('hi');
  assert.ok(clientSession.sent.some(m => m.k === 'c' && m.text === 'hi' && !('from' in m)));

  /* Roster removal drops the remote avatar. */
  host.onRoster([{ id: 'host', name: 'Alice', host: true }]);
  await tick();
  assert.ok(!host.remotes.has('join'), 'host did not remove a departed joiner');

  host.dispose();
  client.dispose();
  console.log('ALL NETGAME TESTS PASSED');
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
