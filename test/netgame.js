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
  applyBodyColors(colors) { this.bodyColors = colors; }
  applyTshirt(url) { this.tshirt = url; }
  applyFace(url) { this.face = url; }
  setToolVisual(binType) { this.toolVisual = binType; }
  setTagColor(css) { this.tagColor = css; }
  respawn() {
    this.alive = true;
    this.health = 100;
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    if (this.nameTag) this.nameTag.visible = true;
  }
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
global.THREE = {
  Vector3: V3,
  BufferGeometry: class { setFromPoints() { return this; } dispose() {} },
  LineBasicMaterial: class { constructor(o) { Object.assign(this, o); } dispose() {} },
  Line: class { constructor() { this.parent = null; } }
};
global.RBLXcharacter = { Character: FakeCharacter };
global.RBLXphysics = { Humanoid: FakeHumanoid };
global.BrickColorFromId = id => ({
  id: id,
  rgb: id === 21 ? [245, 205, 47] : id === 22 ? [200, 90, 10] : [255, 255, 255]
});
global.location = { reload() {} };
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../web/js/safewords.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../web/js/chatfilter.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../web/js/netgame.js'), 'utf8'));
const NetGame = window.RBLXnetgame.NetGame;

const tick = () => new Promise(resolve => setImmediate(resolve));
const scene = { add() {}, remove() {} };
const world = { spawnPoints: [{ cf: { pos: { x: 0, y: 0, z: 0 } } }],
  inventory: [{ props: { BinType: 6 } }] };

function makeUi() {
  const chats = [];
  return {
    chats,
    system: null,
    setPlayers(list) { this.players = list; },
    chat(text, who) { chats.push({ text, who }); },
    notify(text) { this.note = text; },
    showSystemMessage(text) { this.system = text; }
  };
}

function makeSession(mode, players) {
  const sent = [];
  return {
    sent,
    self: mode === 'host' ? 'host' : 'join',
    host: 'host',
    players,
    send(data) { sent.push(data); return true; },
    sendTo(to, data) { sent.push(Object.assign({ to }, data)); return true; }
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

  hostSession.onMessage({
    from: 'join',
    d: {
      k: 'avatar',
      c: { head: 24, torso: 23, arms: 24, legs: 119 },
      t: null
    }
  });
  assert.strictEqual(remote.character.bodyColors.head, 24, 'host did not apply joiner colors');
  assert.ok(hostSession.sent.some(m => m.k === 'avatar' && m.id === 'join'), 'host did not broadcast avatar');

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

  host.localTool = 6;
  host.sendSnapshot();
  const snapTool = hostSession.sent.filter(m => m.k === 's').pop();
  assert.strictEqual(snapTool.p.find(p => p.i === 'host').t, 6,
    'host held tool missing from the snapshot');

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
        { i: 'host', p: [5, 3, 0], r: 0.5, v: [0, 0, 0], g: 1, h: 100, a: 1, t: 6 },
        { i: 'join', p: [10, 3, 0], r: 0, v: [0, 0, 0], g: 1, h: 80, a: 1 }
      ]
    }
  });
  assert.ok(client.remotes.has('host'), 'client did not create the host avatar');
  await tick();
  const hostAvatar = client.remotes.get('host');
  assert.ok(hostAvatar.character, 'client host avatar did not load');
  assert.ok(hostAvatar.hasTarget, 'client host target missing');
  assert.strictEqual(hostAvatar.character.toolVisual, 6, 'client did not show the host held tool');

  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  clientSession.onMessage({
    from: 'host',
    d: {
      k: 'avatar', id: 'host',
      c: { head: 24, torso: 23, arms: 24, legs: 119 }, t: tinyPng,
      f: 'content/faces/miked-face.png'
    }
  });
  assert.strictEqual(hostAvatar.character.bodyColors.torso, 23, 'client did not apply host colors');
  assert.strictEqual(hostAvatar.character.tshirt, tinyPng, 'client did not apply host T-shirt');
  assert.strictEqual(hostAvatar.character.face, 'content/faces/miked-face.png',
    'client did not apply host face');
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

  const remoteRec = client.remotes.get('host');
  remoteRec.velocity.set(0, 0, 0);
  const glideFrom = hostAvatar.character.group.position.x;
  remoteRec.target.set(glideFrom + 20, hostAvatar.character.group.position.y, hostAvatar.character.group.position.z);
  client.step(1 / 60, { moveDir: new V3(), jump: false, climbAxis: 0 }, clientChar, null);
  const glided = hostAvatar.character.group.position.x - glideFrom;
  assert.ok(glided > 0.4 && glided < 0.6,
    'a large remote target jump was not capped (' + glided + ')');

  clientSession.onMessage({ from: 'host', d: { k: 'c', from: 'host', text: 'welcome' } });
  assert.ok(clientUi.chats.some(c => c.text === 'welcome' && c.who === 'Alice'));
  client.chat('hi');
  assert.ok(clientSession.sent.some(m => m.k === 'c' && m.text === 'hi' && !('from' in m)));

  /* Safe-only is per player: only exact Super Safe Chat phrases can be
   * sent or displayed. */
  window.RBLXsafechat = {
    /* "Peace dudes!" is a shipped phrase whose "dudes" is one edit from
     * the banned "nudes"; an exact phrase must never be masked. */
    isPhrase: t => t === 'Hello' || t === 'Hi there!' || t === 'Peace dudes!'
  };
  window.RBLXsafeOnlyMode = true;
  client.setSafeOnly(true);
  client.chatAt = 0;
  const beforeSafe = clientSession.sent.filter(m => m.k === 'c').length;
  client.chat('Hello');
  const safeSent = clientSession.sent.filter(m => m.k === 'c').pop();
  assert.strictEqual(safeSent.text, 'Hello');
  assert.strictEqual(safeSent.safe, 1, 'safe phrase was not flagged');
  client.chatAt = 0;
  client.chat('Peace dudes!', true);
  const peaceSent = clientSession.sent.filter(m => m.k === 'c').pop();
  assert.strictEqual(peaceSent.text, 'Peace dudes!', 'safe phrase was masked');
  assert.strictEqual(peaceSent.safe, 1);
  client.chatAt = 0;
  client.chat('not a phrase');
  assert.strictEqual(clientSession.sent.filter(m => m.k === 'c').length, beforeSafe + 2,
    'unsafe chat was sent in safe-only mode');
  const beforeUnsafeChats = clientUi.chats.length;
  clientSession.onMessage({ from: 'host', d: { k: 'c', from: 'host', text: 'not a phrase' } });
  assert.strictEqual(clientUi.chats.length, beforeUnsafeChats,
    'unsafe chat was displayed in safe-only mode');
  clientSession.onMessage({ from: 'host', d: { k: 'c', from: 'host', text: 'Hi there!' } });
  assert.ok(clientUi.chats.some(c => c.text === 'Hi there!'));

  host.setSafeOnly(true);
  host.chatLog.clear();
  hostSession.onMessage({ from: 'join', d: { k: 'c', text: 'not a phrase' } });
  assert.ok(!hostUi.chats.some(c => c.text === 'not a phrase'),
    'safe-only host displayed unsafe chat');
  const beforeHostSafe = hostSession.sent.filter(m => m.k === 'c' && m.from === 'join').length;
  hostSession.onMessage({ from: 'join', d: { k: 'c', text: 'Hi there!' } });
  assert.ok(hostUi.chats.some(c => c.text === 'Hi there!'));
  assert.strictEqual(hostSession.sent.filter(m => m.k === 'c' && m.from === 'join').length,
    beforeHostSafe + 1);
  assert.strictEqual(hostSession.sent.filter(m => m.k === 'c' && m.from === 'join').pop().safe, 1);

  /* Two short messages that form a slur when joined are blocked. */
  window.RBLXsafeOnlyMode = false;
  client.setSafeOnly(false);
  host.setSafeOnly(false);
  host.chatPrev = '';
  host.chatPrevAt = 0;
  host.chatAt = 0;
  host.chat('fuc');
  host.chatAt = 0;
  host.chat('k');
  assert.ok(hostUi.chats.some(c => c.text === 'fuc'));
  assert.ok(!hostUi.chats.some(c => c.text === 'k'),
    'cross-message slur was displayed');
  assert.ok(!hostSession.sent.some(m => m.k === 'c' && m.text === 'k'),
    'cross-message slur was sent');
  client.chatPrev = '';
  client.chatPrevAt = 0;
  client.remoteChatTimes = [];
  clientSession.onMessage({ from: 'host', d: { k: 'c', from: 'host', text: 'fuc' } });
  clientSession.onMessage({ from: 'host', d: { k: 'c', from: 'host', text: 'k' } });
  assert.ok(!clientUi.chats.some(c => c.text === 'k'),
    'client displayed a cross-message slur');

  /* Joiner tool controls are proxy managers on the host; only built-in
   * BinTypes 1..7 are accepted, and the client sends equip/aim commands. */
  class FakeToolManager {
    constructor(){ this.updates = 0; }
    update(){ this.updates++; }
  }
  window.RBLXtools = { ToolManager: FakeToolManager };
  hostSession.onMessage({ from:'join', d:{ k:'tool', e:1, b:6, name:'Rocket' } });
  assert.strictEqual(remote.toolBin, 6);
  assert.strictEqual(remote.character.toolVisual, 6);
  assert.ok(remote.tool && remote.tool.tm, 'host did not create a remote tool manager');
  hostSession.onMessage({
    from:'join',
    d:{ k:'tool', e:0, p:true, f:true, x:100, y:100,
        o:[0,3,0], d:[0,0,-1] }
  });
  host.step(1 / 60, { moveDir:new V3(), jump:false, climbAxis:0 }, hostChar, null);
  assert.ok(remote.tool.tm.updates > 0, 'host did not update the remote tool');
  assert.strictEqual(remote.tool.mouse.leftPressed, false);

  client.equipTool({ binType:6, name:'Rocket' });
  assert.ok(clientSession.sent.some(m => m.k === 'tool' && m.e === 1 && m.b === 6));
  assert.strictEqual(clientChar.toolVisual, 6);
  client.setMouse({ x:100, y:100, leftPressed:true, leftDown:true }, null);
  client.step(1 / 30, { moveDir:new V3(), jump:false, climbAxis:0 }, clientChar, null);
  assert.ok(clientSession.sent.some(m => m.k === 'tool' && m.e === 0 && m.p === true));

  /* Custom BinType 0 gear cannot be proxied; selecting it clears the
   * previous tool and tells the player instead of faking it. */
  client.equipTool({ binType:0, name:'Ghostwalk' });
  assert.strictEqual(client.selectedTool, null);
  assert.ok(clientSession.sent.some(m => m.k === 'tool' && m.e === 2));
  assert.ok(/host-only/.test(clientUi.note || ''));

  /* A malicious host cannot hang a joiner with a non-finite yaw, and the
   * input clamp keeps a joiner's Infinity out of the host simulation. */
  clientSession.onMessage({
    from: 'host',
    d: {
      k: 's', t: 2.5, p: [
        { i: 'host', p: [5, 3, 0], r: '1e999', v: [0, 0, 0], g: 1, h: 100, a: 1 }
      ]
    }
  });
  assert.ok(Number.isFinite(hostAvatar.targetYaw), 'non-finite yaw survived the snapshot');
  hostSession.onMessage({
    from: 'join',
    d: { k: 'i', x: '1e999', z: -5, c: 'Infinity', j: 'yes' }
  });
  assert.ok(Number.isFinite(remote.input.moveDir.x), 'input x was not finite');
  assert.ok(Math.hypot(remote.input.moveDir.x, remote.input.moveDir.z) <= 1.0001,
    'input vector was not clamped');
  assert.strictEqual(remote.input.climbAxis, 0);
  assert.strictEqual(remote.input.jump, false, 'truthy non-boolean jump was accepted');

  /* Invalid tool events are ignored; the equipped tool stays as it was. */
  hostSession.onMessage({ from: 'join', d: { k: 'tool', e: '1e999', b: 6 } });
  assert.strictEqual(remote.toolBin, 6);
  client.spawnFx({ t: 'e', p: ['1e999', 0, 0], r: 4 });
  assert.strictEqual(client.fx.length, 0, 'non-finite FX position was accepted');

  /* Avatar/profile and snapshot/remote caps. */
  for (let i = 0; i < 48; i++) {
    client.applyAvatarMessage({ id: 'profile' + i, c: { head: 24 }, t: null });
  }
  assert.ok(client.profiles.size <= 32, 'avatar profiles exceeded the cap');
  client.applySnapshot({
    p: Array.from({ length: 40 }, (_, i) => ({
      i: 'extra' + i, p: [0, 3, 0], r: 0, v: [0, 0, 0], g: 1, h: 100, a: 1
    }))
  });
  assert.ok(client.remotes.size <= 32, 'snapshot remotes exceeded the cap');

  /* Host-authoritative respawn: host local player, remote joiner, and the
   * joiner's own local body all come back after the 5 s timer. */
  hostChar.alive = false;
  hostChar.health = 0;
  host.step(1 / 60, { moveDir: new V3(), jump: false, climbAxis: 0 }, hostChar, null);
  assert.ok(host.localRespawnAt > 0, 'host did not schedule a local respawn');
  host.localRespawnAt = performance.now() - 1;
  host.step(1 / 60, { moveDir: new V3(), jump: false, climbAxis: 0 }, hostChar, null);
  assert.strictEqual(hostChar.alive, true, 'host local respawn failed');
  assert.strictEqual(hostChar.health, 100);

  remote.character.alive = false;
  remote.character.health = 0;
  host.step(1 / 60, { moveDir: new V3(), jump: false, climbAxis: 0 }, hostChar, null);
  assert.ok(remote.respawnAt > 0, 'host did not schedule a remote respawn');
  remote.respawnAt = performance.now() - 1;
  host.step(1 / 60, { moveDir: new V3(), jump: false, climbAxis: 0 }, hostChar, null);
  assert.strictEqual(remote.character.alive, true, 'host remote respawn failed');
  assert.strictEqual(remote.character.health, 100);

  /* A remote standing on a moving assembly is carried by its support. */
  const supportLook = { destroyed:false, cf:{ pos:{x:0,y:0,z:0}, rot:[1,0,0,0,1,0,0,0,1] } };
  remote.character.groundLook = supportLook;
  host.step(1 / 60, { moveDir: new V3(), jump: false, climbAxis: 0 }, hostChar, null);
  const carryStart = remote.character.group.position.x;
  supportLook.cf.pos.x = 5;
  host.step(1 / 60, { moveDir: new V3(), jump: false, climbAxis: 0 }, hostChar, null);
  assert.ok(remote.character.group.position.x > carryStart, 'remote did not ride the moving support');

  clientChar.alive = false;
  clientChar.health = 0;
  client.selfSynced = true;
  clientSession.onMessage({
    from: 'host',
    d: {
      k: 's', t: 3, p: [
        { i: 'host', p: [5, 3, 0], r: 0.5, v: [0, 0, 0], g: 1, h: 100, a: 1, c: 22 },
        { i: 'join', p: [0, 7, 0], r: 0, v: [0, 0, 0], g: 1, h: 100, a: 1, c: 21 }
      ]
    }
  });
  assert.strictEqual(clientChar.alive, true, 'client did not apply its own respawn');
  assert.strictEqual(clientChar.health, 100);
  assert.strictEqual(clientChar.group.position.x, 0);
  assert.strictEqual(client.selfColorId, 21);
  assert.strictEqual(clientChar.tagColor, 'rgb(245,205,47)');
  assert.strictEqual(hostAvatar.character.tagColor, 'rgb(200,90,10)');
  assert.ok(client.ui.players.some(p => p.name === 'Alice' && p.color === 'rgb(200,90,10)'),
    'player list did not take the team colour');

  /* A host-side launch (jumppad/explosion) reaches the joiner's local
   * predictor through the snapshot velocity. */
  clientSession.onMessage({
    from: 'host',
    d: {
      k: 's', t: 3.5, p: [
        { i: 'host', p: [5, 3, 0], r: 0.5, v: [0, 0, 0], g: 1, h: 100, a: 1 },
        { i: 'join', p: [0, 7, 0], r: 0, v: [0, 60, 0], g: 0, h: 100, a: 1 }
      ]
    }
  });
  assert.strictEqual(clientChar.velocity.y, 60, 'joiner did not take the host launch velocity');

  clientSession.onMessage({
    from: 'host',
    d: {
      k: 's', t: 4, p: [
        { i: 'host', p: [5, 3, 0], r: 0.5, v: [0, 0, 0], g: 1, h: 0, a: 0 },
        { i: 'join', p: [0, 7, 0], r: 0, v: [0, 0, 0], g: 1, h: 100, a: 1 }
      ]
    }
  });
  client.step(1 / 30, { moveDir: new V3(), jump: false, climbAxis: 0 }, clientChar, null);
  assert.strictEqual(hostAvatar.character.alive, false, 'client remote death failed');
  clientSession.onMessage({
    from: 'host',
    d: {
      k: 's', t: 5, p: [
        { i: 'host', p: [0, 7, 0], r: 0, v: [0, 0, 0], g: 1, h: 100, a: 1 },
        { i: 'join', p: [0, 7, 0], r: 0, v: [0, 0, 0], g: 1, h: 100, a: 1 }
      ]
    }
  });
  assert.strictEqual(hostAvatar.character.alive, true, 'client remote respawn failed');
  assert.strictEqual(hostAvatar.character.group.position.x, 0);

  /* Roster removal drops the remote avatar. */
  host.onRoster([{ id: 'host', name: 'Alice', host: true }]);
  await tick();
  assert.ok(!host.remotes.has('join'), 'host did not remove a departed joiner');

  /* A slur attempt mutes the sender for a minute and shows "Stop". */
  const hostSentBeforeSlur = hostSession.sent.length;
  host.chatAt = 0;
  host.chat('n i g g e r');
  assert.ok(host.muteUntil > performance.now(), 'slur did not mute the host');
  assert.strictEqual(hostUi.system, 'Stop', 'Stop box did not appear');
  assert.strictEqual(hostSession.sent.length, hostSentBeforeSlur, 'slur was sent');
  host.chatAt = 0;
  host.chat('hello');
  assert.strictEqual(hostSession.sent.length, hostSentBeforeSlur, 'muted host sent chat');
  host.muteUntil = performance.now() - 1;
  host.chatAt = 0;
  host.chatPrev = '';
  host.chat('hello');
  assert.ok(hostSession.sent.some(m => m.k === 'c' && m.text === 'hello'),
    'host stayed muted after the window');

  /* Hosts enforce the mute for joined players and target their client. */
  host.muteLog.clear();
  hostSession.onMessage({ from: 'join', d: { k: 'c', text: 'f a g g o t' } });
  assert.ok((host.muteLog.get('join') || 0) > performance.now(),
    'host did not mute the joiner');
  const muteMsg = hostSession.sent.filter(m => m.k === 'mute').pop();
  assert.ok(muteMsg && muteMsg.to[0] === 'join' && muteMsg.ms === 60000,
    'no targeted mute message');
  assert.ok(!hostUi.chats.some(c => c.text.indexOf('f a g g o t') >= 0),
    'slur was displayed by the host');
  const beforeMutedJoin = hostSession.sent.filter(m => m.k === 'c').length;
  hostSession.onMessage({ from: 'join', d: { k: 'c', text: 'hello' } });
  assert.strictEqual(hostSession.sent.filter(m => m.k === 'c').length, beforeMutedJoin,
    'muted joiner was relayed');
  host.muteLog.clear();
  hostSession.onMessage({ from: 'join', d: { k: 'c', text: 'hello again' } });
  assert.ok(hostSession.sent.some(m => m.k === 'c' && m.text === 'hello again'));

  /* The muted client shows the same box and cannot send until it expires. */
  client.setSafeOnly(false);
  client.chatPrev = '';
  client.chatPrevAt = 0;
  clientSession.onMessage({ from: 'host', d: { k: 'mute', ms: 60000 } });
  assert.ok(client.muteUntil > performance.now(), 'client mute not applied');
  assert.strictEqual(clientUi.system, 'Stop');
  const beforeMutedClient = clientSession.sent.length;
  client.chatAt = 0;
  client.chat('hello there');
  assert.strictEqual(clientSession.sent.length, beforeMutedClient, 'muted client sent');
  client.muteUntil = performance.now() - 1;
  client.chatAt = 0;
  client.chat('hello there');
  assert.ok(clientSession.sent.some(m => m.k === 'c' && m.text === 'hello there'),
    'client stayed muted after the window');

  /* Ack reconciliation: the host's current position trails by latency, so
   * only the state at the last processed input may correct the predictor. */
  client.selfSynced = true;
  client.lastAck = 10;
  client.inputHist = [{ s: 10, x: 100, y: 0, z: 0 }];
  client.character.group.position.set(104, 0, 0);
  const snapBase = { r: 0, v: [0, 0, 0], g: 1, h: 100, a: 1, t: 0, c: 0 };
  client.applySnapshot({ p: [Object.assign({ i: client.selfId, p: [104, 0, 0], k: 10, kp: [100.1, 0, 0] }, snapBase)] });
  assert.strictEqual(client.character.group.position.x, 104,
    'latency lead was mistaken for prediction error');

  client.lastAck = 10;
  client.inputHist = [{ s: 11, x: 100, y: 0, z: 0 }];
  client.character.group.position.set(104, 0, 0);
  client.applySnapshot({ p: [Object.assign({ i: client.selfId, p: [104, 0, 0], k: 11, kp: [101, 0, 0] }, snapBase)] });
  assert.strictEqual(client.character.group.position.x, 105,
    'acked prediction error was not corrected relative to the current pose');
  client.applySnapshot({ p: [Object.assign({ i: client.selfId, p: [104, 0, 0], k: 11, kp: [101, 0, 0] }, snapBase)] });
  assert.strictEqual(client.character.group.position.x, 105,
    'the same ack was applied twice');

  client.lastAck = 11;
  client.inputHist = [{ s: 12, x: 105, y: 0, z: 0 }];
  client.character.group.position.set(105, 0, 0);
  client.applySnapshot({ p: [Object.assign({ i: client.selfId, p: [115, 0, 0], k: 12, kp: [105, 0, 0] }, snapBase)] });
  assert.strictEqual(client.character.group.position.x, 105,
    'a 10-stud latency gap triggered a snap');

  host.dispose();
  client.dispose();

  /* A host with no local character still simulates and snapshots joiners. */
  const noPlayerSession = makeSession('host', players);
  const noPlayerHost = new NetGame({
    mode: 'host', session: noPlayerSession, scene, world, ui: makeUi(),
    character: null, controller: null, parsed: null
  });
  noPlayerHost.start();
  await tick();
  assert.ok(noPlayerHost.remotes.has('join'), 'no-player host did not create remote');
  noPlayerHost.sendSnapshot();
  const noPlayerSnap = noPlayerSession.sent.filter(m => m.k === 's').pop();
  assert.ok(noPlayerSnap && noPlayerSnap.p.length === 1, 'no-player snapshot included a local body');
  assert.strictEqual(noPlayerSnap.p[0].i, 'join');
  noPlayerHost.dispose();

  /* Part/FX replication plumbing: host drains rbxenv and sends, client
   * creates/updates/removes and spawns the explosion visual. */
  const partMsg = { k:'parts', p:[
    { i:101, n:1, c:'Part', s:[1,1,1], f:[0,0,0,1,0,0,0,1,0,0,0,1], a:0, k:1, h:1 },
    { i:102, n:1, c:'Part', s:[2,2,2], f:[5,0,0,1,0,0,0,1,0,0,0,1], a:0, k:1, h:1 }
  ], d:[7], f:[{ t:'e', p:[1,2,3], r:4 }, { t:'l', a:[0,0,0], b:[10,0,0] }] };
  const sent = [];
  window.RBLXenv = {
    state: { netMap: new Map(), world: {} },
    netDrain: () => ({ p: partMsg.p, d: partMsg.d, f: partMsg.f }),
    createNetPart(p) { sent.push('new:' + p.i); const inst={ id:p.i }; this.state.netMap.set(p.i, inst); return inst; },
    applyNetPart(inst, p) { sent.push('upd:' + p.i); },
    detachFromWorld(inst) { sent.push('del:' + inst.id); }
  };
  const partsHost = new NetGame({
    mode: 'host', session: makeSession('host', players), scene, world, ui: makeUi(),
    character: new FakeCharacter(scene, world, 'Alice'), controller: new FakeHumanoid(hostChar, world), parsed: null
  });
  partsHost.sendParts();
  const out = partsHost.session.sent.filter(m => m.k === 'parts').pop();
  assert.ok(out && out.p.length === 2, 'host did not send part batch');
  assert.deepStrictEqual(out.d, [7]);
  assert.strictEqual(out.f[0].t, 'e');
  partsHost.dispose();

  const client2 = new NetGame({
    mode: 'client', session: makeSession('client', players), scene, world, ui: makeUi(),
    character: new FakeCharacter(scene, world, 'Bob'), controller: new FakeHumanoid(clientChar, world), parsed: null
  });
  window.RBLXenv.state.netMap.set(7, { id:7 });
  client2.applyParts(partMsg);
  assert.deepStrictEqual(sent, ['new:101', 'new:102', 'del:7']);
  assert.strictEqual(client2.fx.length, 1, 'laser line FX did not spawn');
  client2.stepFx(0.2);
  assert.strictEqual(client2.fx.length, 0, 'laser line FX did not expire');

  /* New-part rate cap: a host cannot make the joiner allocate an
   * unbounded number of meshes in one tick. */
  const spam = Array.from({ length: 256 }, (_, i) => ({
    i: 2000 + i, n: 1, c: 'Part', s: [1,1,1],
    f: [0,0,0,1,0,0,0,1,0,0,0,1], a: 0, k: 1, h: 1
  }));
  const beforeNew = sent.filter(s => s.startsWith('new:')).length;
  for (let n = 0; n < 5; n++) {
    const batch = spam.map((p, i) => Object.assign({}, p, { i: 2000 + n * 256 + i }));
    client2.applyParts({ p: batch, d: [], f: [] });
  }
  const afterNew = sent.filter(s => s.startsWith('new:')).length;
  assert.ok(afterNew - beforeNew <= 1024, 'new-part rate cap was bypassed');
  client2.dispose();

  console.log('ALL NETGAME TESTS PASSED');
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
