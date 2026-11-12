/* ============================================================
 * multiplayer.js  Play Solo / Play chooser, server browser, and the
 * private relay session handshake.
 *
 * The relay is a star: this client either hosts a room or joins one. It
 * never opens a peer-to-peer connection and never receives a peer address.
 * Gameplay state replication is layered on top of this session later; this
 * file owns the lobby and room lifecycle.
 * ============================================================ */
(function () {
  "use strict";

  var els = {};
  var state = {
    place: null,
    onSolo: null,
    browsing: false,
    fetching: false,
    pollTimer: null,
    ws: null,
    session: null,
    mode: null,
    connectTimer: null,
    leaving: false
  };

  function $(id) { return document.getElementById(id); }
  function setText(el, text) { if (el) el.textContent = text == null ? '' : String(text); }
  function show(el, on) { if (el) el.style.display = on ? 'flex' : 'none'; }

  function relayBase() {
    var cfg = window.RBLX_NET_CONFIG || {};
    return String(cfg.relay || '').replace(/\/+$/, '');
  }

  function httpBase(base) {
    return base.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
  }

  function wsBase(base) {
    return base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  }

  function clientName() {
    var name = (window.RBLXplayer && window.RBLXplayer.name) || 'Player1';
    if (window.RBLXnamepolicy) name = window.RBLXnamepolicy.sanitize(name);
    return name;
  }

  function cleanPlayer(p) {
    if (!p || typeof p !== 'object') return null;
    if (typeof p.id !== 'string' || typeof p.name !== 'string') return null;
    return { id: p.id, name: p.name.slice(0, 40), host: p.host === true };
  }

  function cleanPlayers(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length && out.length < 16; i++) {
      var p = cleanPlayer(list[i]);
      if (p) out.push(p);
    }
    return out;
  }

  function stopPoll() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function closeSocket() {
    if (state.connectTimer) {
      clearTimeout(state.connectTimer);
      state.connectTimer = null;
    }
    var ws = state.ws;
    state.ws = null;
    if (ws) {
      try { ws.close(); } catch (_) { /* already closed */ }
    }
  }

  function hideAll() {
    show(els.modePicker, false);
    show(els.serverBrowser, false);
    show(els.roomLobby, false);
  }

  function setStatus(el, text) {
    setText(el, text);
  }

  /* ------------------------- mode chooser ------------------------- */
  function chooseMode(place, onSolo) {
    state.place = String(place || '');
    state.onSolo = typeof onSolo === 'function' ? onSolo : null;
    state.browsing = false;
    stopPoll();

    setText(els.modePlace, state.place);
    var configured = !!relayBase();
    if (els.modePlay) {
      els.modePlay.disabled = !configured;
      els.modePlay.title = configured
        ? 'Browse peer-hosted rooms for this place'
        : 'Multiplayer is not configured in this build. Play Solo still works.';
    }
    setText(els.modeHint, configured
      ? 'Peer-hosted rooms. The host can cheat; no player IPs are exchanged.'
      : 'Multiplayer is not configured in this build. Play Solo still works.');

    show(els.modePicker, true);
  }

  function playSolo() {
    hideAll();
    state.place = null;
    var fn = state.onSolo;
    state.onSolo = null;
    if (fn) fn();
  }

  function cancelMode() {
    hideAll();
    state.place = null;
    state.onSolo = null;
  }

  /* ------------------------- server browser ------------------------- */
  function openBrowser() {
    if (!state.place) return;
    state.browsing = true;
    setText(els.sbPlace, state.place);
    setStatus(els.sbStatus, 'Loading rooms...');
    els.sbList.innerHTML = '';
    show(els.serverBrowser, true);
    refreshRooms();
    stopPoll();
    state.pollTimer = setInterval(refreshRooms, 2500);
  }

  function refreshRooms() {
    if (!state.browsing || state.fetching) return;
    var base = relayBase();
    if (!base) {
      setStatus(els.sbStatus, 'Multiplayer is not configured in this build. Play Solo still works.');
      return;
    }
    state.fetching = true;
    var controller = window.AbortController ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;
    var place = state.place;

    fetch(httpBase(base) + '/rooms?place=' + encodeURIComponent(place), {
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!state.browsing || state.place !== place) return;
        if (!data || data.v !== 1 || !Array.isArray(data.rooms)) {
          throw new Error('bad room list');
        }
        renderRooms(data.rooms);
        setStatus(els.sbStatus, '');
      })
      .catch(function () {
        if (state.browsing) {
          setStatus(els.sbStatus, 'Multiplayer relay is offline. Play Solo still works.');
        }
      })
      .finally(function () {
        if (timer) clearTimeout(timer);
        state.fetching = false;
      });
  }

  function renderRooms(rooms) {
    els.sbList.innerHTML = '';
    var shown = 0;
    for (var i = 0; i < rooms.length; i++) {
      var room = rooms[i];
      if (!room || typeof room.id !== 'string' || room.place !== state.place) continue;
      var players = Math.max(0, Math.min(16, Number(room.players) || 0));
      var max = Math.max(2, Math.min(16, Number(room.max) || 16));

      var row = document.createElement('div');
      row.className = 'sbRow';

      var info = document.createElement('div');
      info.className = 'sbInfo';
      var name = document.createElement('b');
      name.textContent = String(room.hostName || 'Host');
      var meta = document.createElement('span');
      meta.textContent = players + '/' + max + ' players';
      info.appendChild(name);
      info.appendChild(meta);

      var join = document.createElement('button');
      join.type = 'button';
      join.className = 'netBtn';
      join.textContent = 'Join';
      if (players >= max) {
        join.disabled = true;
        join.textContent = 'Full';
      }
      (function (roomId) {
        join.onclick = function () { connect('join', roomId); };
      })(room.id);

      row.appendChild(info);
      row.appendChild(join);
      els.sbList.appendChild(row);
      shown++;
    }

    if (!shown) {
      var empty = document.createElement('div');
      empty.className = 'sbEmpty';
      empty.textContent = 'No rooms yet. Host one.';
      els.sbList.appendChild(empty);
    }
  }

  function backToMode() {
    stopPoll();
    state.browsing = false;
    show(els.serverBrowser, false);
    chooseMode(state.place, state.onSolo);
  }

  /* ------------------------- room session ------------------------- */
  function connect(mode, roomId) {
    if (state.ws || state.session) return;
    var base = relayBase();
    if (!base) {
      setStatus(els.sbStatus, 'Multiplayer is not configured in this build.');
      return;
    }
    state.mode = mode;
    state.leaving = false;

    var params = new URLSearchParams();
    params.set('v', '1');
    params.set('mode', mode);
    params.set('name', clientName());
    params.set('place', state.place);
    if (mode === 'join') params.set('room', roomId || '');
    var url = wsBase(base) + '/play?' + params.toString();

    var ws;
    try {
      ws = new WebSocket(url);
    } catch (_) {
      setStatus(els.sbStatus, 'Could not open the relay connection.');
      return;
    }
    state.ws = ws;
    if (els.sbHost) els.sbHost.disabled = true;
    setStatus(els.sbStatus, mode === 'host' ? 'Creating room...' : 'Joining room...');

    state.connectTimer = setTimeout(function () {
      if (state.ws === ws && !state.session) {
        closeSocket();
        if (state.browsing) setStatus(els.sbStatus, 'The relay did not answer. Play Solo still works.');
        if (els.sbHost) els.sbHost.disabled = false;
      }
    }, 8000);

    ws.onopen = function () {
      if (state.ws === ws && !state.session) {
        setStatus(els.sbStatus, 'Connected. Waiting for the room...');
      }
    };

    ws.onmessage = function (ev) {
      if (state.ws !== ws) return;
      var message;
      try { message = JSON.parse(ev.data); } catch (_) { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      handleMessage(message);
    };

    ws.onerror = function () {
      if (state.ws === ws && !state.session) {
        setStatus(els.sbStatus, 'Could not reach the relay. Play Solo still works.');
      }
    };

    ws.onclose = function () {
      if (state.connectTimer) {
        clearTimeout(state.connectTimer);
        state.connectTimer = null;
      }
      if (state.ws === ws) state.ws = null;
      if (els.sbHost) els.sbHost.disabled = false;
      if (state.session) {
        if (!state.leaving) {
          if (typeof state.session.onClose === 'function') {
            state.leaving = true;
            state.session.onClose('close');
          } else {
            setStatus(els.lobbyStatus, 'Disconnected from the relay.');
          }
        }
      } else if (state.browsing) {
        setStatus(els.sbStatus, 'The relay closed the connection. Play Solo still works.');
      }
    };
  }

  function handleMessage(message) {
    if (message.t === 'welcome') {
      if (state.session) return;
      if (state.connectTimer) {
        clearTimeout(state.connectTimer);
        state.connectTimer = null;
      }
      state.session = {
        room: String(message.room || ''),
        place: String(message.place || state.place || ''),
        self: String(message.self || ''),
        host: String(message.host || ''),
        max: Math.max(2, Math.min(16, Number(message.max) || 16)),
        players: cleanPlayers(message.players),
        onMessage: null,
        onRoster: null,
        onClose: null
      };
      state.session.send = function (data) {
        if (!state.ws || state.ws.readyState !== 1) return false;
        try {
          if (state.mode === 'host') {
            state.ws.send(JSON.stringify({ t: 'state', to: 'all', d: data }));
          } else {
            state.ws.send(JSON.stringify({ t: 'cmd', d: data }));
          }
          return true;
        } catch (_) {
          return false;
        }
      };
      state.session.sendTo = function (to, data) {
        if (state.mode !== 'host' || !state.ws || state.ws.readyState !== 1) return false;
        try {
          state.ws.send(JSON.stringify({
            t: 'state',
            to: Array.isArray(to) ? to : [to],
            d: data
          }));
          return true;
        } catch (_) {
          return false;
        }
      };
      state.session.close = function () { leaveRoom(); };

      state.browsing = false;
      stopPoll();

      if (typeof window.RBLXstartNetworkGame === 'function') {
        hideAll();
        try {
          var started = window.RBLXstartNetworkGame({
            mode: state.mode === 'host' ? 'host' : 'client',
            session: state.session
          });
          if (started && typeof started.catch === 'function') {
            started.catch(function (err) {
              console.error('[multiplayer] game start failed:', err);
            });
          }
        } catch (err) {
          console.error('[multiplayer] game start failed:', err);
        }
        return;
      }

      show(els.modePicker, false);
      show(els.serverBrowser, false);
      show(els.roomLobby, true);
      renderLobby();
      setStatus(els.lobbyStatus, state.mode === 'host'
        ? 'Room created. Waiting for players.'
        : 'Joined the room.');
      return;
    }

    if (message.t === 'roster') {
      if (!state.session) return;
      state.session.players = cleanPlayers(message.players);
      if (typeof state.session.onRoster === 'function') {
        state.session.onRoster(state.session.players);
      }
      if (els.roomLobby && els.roomLobby.style.display !== 'none') renderLobby();
      return;
    }

    if (message.t === 'error') {
      var text = 'Relay: ' + String(message.code || 'error');
      if (message.message) text += ' — ' + String(message.message);
      if (state.session) setStatus(els.lobbyStatus, text);
      else if (state.browsing) setStatus(els.sbStatus, text);
      return;
    }

    if (message.t === 'hostLeft') {
      if (state.session) {
        state.leaving = true;
        if (typeof state.session.onClose === 'function') state.session.onClose('hostLeft');
        setStatus(els.lobbyStatus, 'Host left. This room is closed.');
      }
      closeSocket();
      return;
    }

    if (message.t === 'cmd') {
      if (state.session && typeof state.session.onMessage === 'function') {
        state.session.onMessage({ from: message.from, d: message.d });
      }
      return;
    }

    if (message.t === 'state') {
      if (state.session && typeof state.session.onMessage === 'function') {
        state.session.onMessage({ from: state.session.host, d: message.d });
      }
      return;
    }

    /* pong and future relay messages are ignored by this layer. */
  }

  function renderLobby() {
    var session = state.session;
    if (!session) return;
    setText(els.lobbyPlace, session.place);
    var shortRoom = session.room ? session.room.slice(0, 6) : '??????';
    setText(els.lobbyRoom, 'Room ' + shortRoom + ' · ' +
      session.players.length + '/' + session.max + ' players');

    var host = null;
    for (var i = 0; i < session.players.length; i++) {
      if (session.players[i].id === session.host) host = session.players[i];
    }
    setText(els.lobbyHost, 'Host: ' + (host ? host.name : 'unknown'));

    els.lobbyPlayers.innerHTML = '';
    for (var j = 0; j < session.players.length; j++) {
      var player = session.players[j];
      var row = document.createElement('div');
      row.className = 'lobbyPlayer';
      var name = document.createElement('b');
      name.textContent = player.name;
      row.appendChild(name);
      var suffix = document.createElement('span');
      var bits = [];
      if (player.id === session.host) bits.push('host');
      if (player.id === session.self) bits.push('you');
      suffix.textContent = bits.length ? '(' + bits.join(', ') + ')' : '';
      row.appendChild(suffix);
      els.lobbyPlayers.appendChild(row);
    }
  }

  function leaveRoom() {
    state.leaving = true;
    stopPoll();
    closeSocket();
    state.session = null;
    state.mode = null;
    state.browsing = false;
    state.place = null;
    state.onSolo = null;
    hideAll();
    if (els.sbHost) els.sbHost.disabled = false;
  }

  /* ------------------------- bindings ------------------------- */
  function init() {
    var ids = [
      'modePicker', 'modePlace', 'modeSolo', 'modePlay', 'modeCancel', 'modeHint',
      'serverBrowser', 'sbPlace', 'sbHost', 'sbRefresh', 'sbStatus', 'sbList', 'sbBack',
      'roomLobby', 'lobbyPlace', 'lobbyRoom', 'lobbyHost', 'lobbyPlayers',
      'lobbyStatus', 'lobbyLeave'
    ];
    for (var i = 0; i < ids.length; i++) els[ids[i]] = $(ids[i]);
    if (!els.modePicker || !els.serverBrowser || !els.roomLobby) return;

    els.modeSolo.onclick = playSolo;
    els.modePlay.onclick = function () {
      hideAll();
      openBrowser();
    };
    els.modeCancel.onclick = cancelMode;
    els.sbBack.onclick = backToMode;
    els.sbRefresh.onclick = refreshRooms;
    els.sbHost.onclick = function () { connect('host'); };
    els.lobbyLeave.onclick = leaveRoom;

    window.addEventListener('pagehide', function () {
      closeSocket();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.RBLXmultiplayer = {
    chooseMode: chooseMode,
    leave: leaveRoom
  };
})();
