/* UI state-machine checks for web/js/multiplayer.js.
 * Run with: node test/multiplayer.js
 * No browser: a tiny DOM and a fake WebSocket/fetch are enough. */
"use strict";

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

class El {
  constructor(id) {
    this.id = id || '';
    this.style = { display: 'none' };
    this.children = [];
    this._text = '';
    this.className = '';
    this.disabled = false;
    this.title = '';
    this.type = '';
    this.onclick = null;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return ''; }
  set innerHTML(v) { if (v === '') this.children = []; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute() {}
}

const ids = [
  'modePicker', 'modePlace', 'modeSolo', 'modePlay', 'modeCancel', 'modeHint',
  'serverBrowser', 'sbPlace', 'sbHost', 'sbHostNoPlayer', 'sbRefresh', 'sbStatus', 'sbList', 'sbBack',
  'roomLobby', 'lobbyPlace', 'lobbyRoom', 'lobbyHost', 'lobbyPlayers',
  'lobbyStatus', 'lobbyLeave'
];
const elements = {};
for (const id of ids) elements[id] = new El(id);
function E(id) { return elements[id]; }

const document = {
  readyState: 'complete',
  getElementById(id) { return elements[id] || null; },
  createElement() { return new El(); },
  addEventListener() {}
};

let fetchImpl = async () => ({
  ok: true,
  json: async () => ({
    v: 1,
    rooms: [{
      id: 'room1234567890abcdefgh',
      place: 'Crossroads',
      hostName: 'Alice',
      players: 1,
      max: 16
    }]
  })
});
let fetchCalls = 0;

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }
  message(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
}
FakeWebSocket.instances = [];

global.window = global;
global.document = document;
global.addEventListener = () => {};
global.location = { hostname: '127.0.0.1' };
global.WebSocket = FakeWebSocket;
global.fetch = (url, opts) => { fetchCalls++; return fetchImpl(url, opts); };
global.RBLXplayer = { name: 'Tester' };
global.PLACE_REGISTRY = ['Crossroads'];

const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
global.setInterval = () => 1;
global.clearInterval = () => {};

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../web/js/netconfig.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../web/js/multiplayer.js'), 'utf8'));

const mp = window.RBLXmultiplayer;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function main() {
  assert.ok(mp, 'multiplayer module missing');
  assert.strictEqual(window.RBLX_NET_CONFIG.relay, 'http://127.0.0.1:8788');

  /* Play Solo still gets the old flow. */
  let solo = false;
  mp.chooseMode('Crossroads', () => { solo = true; });
  assert.strictEqual(E('modePicker').style.display, 'flex');
  assert.strictEqual(E('modePlay').disabled, false);
  assert.strictEqual(E('modePlace').textContent, 'Crossroads');
  E('modeSolo').onclick();
  assert.ok(solo, 'Play Solo callback did not run');
  assert.strictEqual(E('modePicker').style.display, 'none');

  /* Server browser lists a room and joins it. */
  mp.chooseMode('Crossroads', () => {});
  E('modePlay').onclick();
  await tick();
  await tick();
  assert.strictEqual(E('serverBrowser').style.display, 'flex');
  assert.strictEqual(fetchCalls, 1);
  assert.strictEqual(E('sbList').children.length, 1);
  const row = E('sbList').children[0];
  assert.strictEqual(row.children[0].children[0].textContent, 'Alice');
  assert.match(row.children[0].children[1].textContent, /1\/16/);
  row.children[1].onclick();

  assert.strictEqual(FakeWebSocket.instances.length, 1);
  const joinWs = FakeWebSocket.instances[0];
  assert.match(joinWs.url, /\/play\?/);
  assert.match(joinWs.url, /mode=join/);
  assert.match(joinWs.url, /room=room1234567890abcdefgh/);
  assert.match(joinWs.url, /place=Crossroads/);
  assert.match(joinWs.url, /name=Tester/);

  joinWs.open();
  joinWs.message({
    t: 'welcome', v: 1, room: 'room1234567890abcdefgh', place: 'Crossroads',
    self: 'me', host: 'host1', max: 16,
    players: [
      { id: 'host1', name: 'Alice', host: true },
      { id: 'me', name: 'Tester', host: false }
    ]
  });
  assert.strictEqual(E('roomLobby').style.display, 'flex');
  assert.strictEqual(E('lobbyPlayers').children.length, 2);
  assert.match(E('lobbyStatus').textContent, /Joined/);
  assert.match(E('lobbyHost').textContent, /Alice/);

  joinWs.message({
    t: 'roster',
    players: [
      { id: 'host1', name: 'Alice', host: true },
      { id: 'me', name: 'Tester', host: false },
      { id: 'third', name: 'Carol', host: false }
    ]
  });
  assert.strictEqual(E('lobbyPlayers').children.length, 3);
  assert.match(E('lobbyRoom').textContent, /3\/16/);

  joinWs.message({ t: 'hostLeft' });
  assert.match(E('lobbyStatus').textContent, /Host left/);
  assert.strictEqual(joinWs.readyState, 3);

  E('lobbyLeave').onclick();
  assert.strictEqual(E('roomLobby').style.display, 'none');

  /* Host creates a room. */
  mp.chooseMode('Crossroads', () => {});
  E('modePlay').onclick();
  await tick();
  await tick();
  E('sbHost').onclick();
  const hostWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  assert.match(hostWs.url, /mode=host/);
  assert.match(hostWs.url, /place=Crossroads/);
  hostWs.open();
  hostWs.message({
    t: 'welcome', v: 1, room: 'hostroom1234567890abcd', place: 'Crossroads',
    self: 'host1', host: 'host1', max: 16,
    players: [{ id: 'host1', name: 'Tester', host: true }]
  });
  assert.strictEqual(E('roomLobby').style.display, 'flex');
  assert.strictEqual(E('lobbyPlayers').children.length, 1);
  assert.match(E('lobbyStatus').textContent, /Room created/);
  E('lobbyLeave').onclick();

  /* Relay offline: browser stays usable and says so. */
  fetchImpl = async () => { throw new Error('down'); };
  mp.chooseMode('Crossroads', () => {});
  E('modePlay').onclick();
  await tick();
  await tick();
  assert.match(E('sbStatus').textContent, /offline/);
  E('sbBack').onclick();
  assert.strictEqual(E('modePicker').style.display, 'flex');

  /* Unconfigured build: Play is disabled, Solo is not. */
  window.RBLX_NET_CONFIG.relay = '';
  mp.chooseMode('Crossroads', () => {});
  assert.strictEqual(E('modePlay').disabled, true);
  assert.match(E('modeHint').textContent, /not configured/);
  assert.strictEqual(E('modeSolo').disabled, false);
  E('modeCancel').onclick();

  /* The game hook receives the live session and can send/receive frames. */
  window.RBLX_NET_CONFIG.relay = 'http://127.0.0.1:8788';
  fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      v: 1,
      rooms: [{
        id: 'room1234567890abcdefgh',
        place: 'Crossroads',
        hostName: 'Alice',
        players: 1,
        max: 16
      }]
    })
  });
  let started = null;
  window.RBLXstartNetworkGame = payload => { started = payload; };

  mp.chooseMode('Crossroads', () => {});
  E('modePlay').onclick();
  await tick();
  await tick();
  E('sbHost').onclick();
  const gameWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  gameWs.open();
  gameWs.message({
    t: 'welcome', v: 1, room: 'gameroom1234567890abcd', place: '../evil',
    self: 'host1', host: 'host1', max: 16,
    players: [{ id: 'host1', name: 'Tester', host: true }]
  });
  assert.ok(started, 'game hook was not called');
  assert.strictEqual(started.mode, 'host');
  assert.strictEqual(started.session.place, 'Crossroads',
    'relay place was trusted over the locally selected place');
  assert.strictEqual(started.session.room, 'gameroom1234567890abcd');
  assert.strictEqual(started.session.self, 'host1');
  assert.strictEqual(E('roomLobby').style.display, 'none');
  assert.strictEqual(E('serverBrowser').style.display, 'none');
  assert.strictEqual(E('modePicker').style.display, 'none');

  let roster = null;
  let gameMessage = null;
  started.session.onRoster = list => { roster = list; };
  started.session.onMessage = msg => { gameMessage = msg; };
  started.session.send({ k: 's', p: [] });
  assert.deepStrictEqual(gameWs.sent.at(-1), { t: 'state', to: 'all', d: { k: 's', p: [] } });

  gameWs.message({
    t: 'roster',
    players: [
      { id: 'host1', name: 'Tester', host: true },
      { id: 'join1', name: 'Bob', host: false }
    ]
  });
  assert.strictEqual(roster.length, 2);
  gameWs.message({ t: 'cmd', from: 'join1', d: { k: 'i', x: 1 } });
  assert.deepStrictEqual(gameMessage, { from: 'join1', d: { k: 'i', x: 1 } });

  started.session.close();
  assert.strictEqual(gameWs.readyState, 3);

  /* Join maps to the client role and sends commands, not host state. */
  started = null;
  mp.chooseMode('Crossroads', () => {});
  E('modePlay').onclick();
  await tick();
  await tick();
  const joinRow = E('sbList').children[0];
  joinRow.children[1].onclick();
  const clientWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  clientWs.open();
  clientWs.message({
    t: 'welcome', v: 1, room: 'gameroom1234567890abcd', place: 'Crossroads',
    self: 'join1', host: 'host1', max: 16,
    players: [
      { id: 'host1', name: 'Tester', host: true },
      { id: 'join1', name: 'Bob', host: false }
    ]
  });
  assert.ok(started, 'join game hook was not called');
  assert.strictEqual(started.mode, 'client');
  started.session.send({ k: 'i', x: 1 });
  assert.deepStrictEqual(clientWs.sent.at(-1), { t: 'cmd', d: { k: 'i', x: 1 } });

  let joinMessage = null;
  started.session.onMessage = msg => { joinMessage = msg; };
  clientWs.message({ t: 'state', d: { k: 's', p: [] } });
  assert.strictEqual(joinMessage.from, 'host1');
  started.session.close();

  /* Host (No Player) asks the game hook to enter without a local body. */
  started = null;
  mp.chooseMode('Crossroads', () => {});
  E('modePlay').onclick();
  await tick();
  await tick();
  E('sbHostNoPlayer').onclick();
  const noPlayerWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  noPlayerWs.open();
  noPlayerWs.message({
    t: 'welcome', v: 1, room: 'dedicated1234567890abcd', place: 'Crossroads',
    self: 'host1', host: 'host1', max: 16,
    players: [{ id: 'host1', name: 'Tester', host: true }]
  });
  assert.ok(started, 'no-player host hook was not called');
  assert.strictEqual(started.mode, 'host');
  assert.strictEqual(started.headless, true);
  started.session.close();

  global.setInterval = realSetInterval;
  global.clearInterval = realClearInterval;
  console.log('ALL MULTIPLAYER UI TESTS PASSED');
}

main().catch(err => {
  global.setInterval = realSetInterval;
  global.clearInterval = realClearInterval;
  console.error(err);
  process.exitCode = 1;
});
