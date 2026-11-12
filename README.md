# Roblox 0.3.368.0 (2007) browser port

**[Play it in your browser](https://raul488.github.io/Roblox-March-2007-Browser-Port-/)**

The March 2007 client rebuilt for HTML/JS/WebGL. Engine constants, script
behavior and content come from the decompilation and the shipped content
and place files.

Built with opencode. The original client is MaximumADHD's
[Roblox_0.3.368.0](https://github.com/MaximumADHD/Roblox_0.3.368.0).

There are no online features in the default build. Play Solo works fully
offline. Multiplayer is optional, peer-hosted, and requires your own private
relay; the client never opens a peer-to-peer connection.

## Run it

Open `web/index.html` in any modern browser. It works from `file://`, with
no server.

Pick a place (Crossroads, HappyHomeInRobloxia, HumanoidHarvesterHorror,
RobloxHQ, TabulaRasa, Haunted Mansion) or drag a `.rbxl`/`.rbxm` XML file
onto the window.

Place data, sounds, character.rbxm and three.js r128 are all embedded in
`web/`. Play Solo needs no network and no install.

## Multiplayer

Multiplayer is a peer-hosted listen server: one player's browser runs the
room, everyone else joins through a private relay. The relay keeps the room
list, enforces the 16-player cap, and routes messages; it never exposes a
player's IP to another player. A modified host can still cheat its own room.

The client is configured in `web/js/netconfig.js`:

```js
window.RBLX_RELAY_URL = 'https://relay.example.com';
```

Then add the same relay origins to the `connect-src` directive in
`web/index.html`:

```text
https://relay.example.com wss://relay.example.com
```

When the page is served from `localhost` or `127.0.0.1`, an empty config
defaults to `http://127.0.0.1:8788` so the private relay can be tested
locally. Serve `web/` over HTTP (not `file://`) for local multiplayer.

The current build enters the place as Host & Play: the host's browser
runs the authoritative world, simulates every joined player's character,
and sends snapshots through the relay. Joiners render remote avatars, chat,
and predict their own movement; they do not run the place's server Scripts.
Remote avatars carry the player's body colors and a small downscaled
T-shirt. Chat is ASCII-only, capped at 100 characters, rate-limited and
filtered with an expanded profanity/slur list that sees through spaces,
punctuation, leetspeak, inserted digits and doubled letters. The chat bar
also has a per-player **Safe Chat** toggle: when it is on, the typed box is
disabled and only phrases from the shipped Super Safe Chat tree can be
sent or displayed (received text is validated against that exact phrase
list). The setting persists locally. Obvious slurs are not merely masked:
the sender is muted for a minute and the centre message box says **Stop**.
Usernames are capped at 20 characters
with ASCII letters/numbers, at most one space and one underscore.

The relay sees room names, display names, chat, avatars and game state; it
does not put player IP addresses into the protocol or room list. A T-shirt
you choose is shared with the players in your room. A modified host can
cheat its own room; the relay cannot verify the host's game filtering.

Host changes replicate to joiners: tool-created and moving parts, grabbed
bricks, beacon/regen geometry, explosions, and place-script Touched events
(so remote players trigger jumppads and beacons). Remote characters are
also carried by the moving assembly they stand on. Joiners can use the
built-in BinTypes 1–7 through host-side proxy managers (rocket, slingshot,
laser, GameTool/Grab, clone, hammer); custom BinType 0 Lua gear remains
host-only.

**Host (No Player)** creates the same room without a local character, for
running a dedicated room in a browser tab. It still needs the tab open and
visible (browsers pause background-tab animation); a native headless server
is not implemented. Duplicate display names get a numeric suffix (`Alice`,
`Alice2`); the chat filter uses the expanded starter word list. When the
place ships a Teams service, players are assigned to the fewest-member team
and the overhead tag/player list take that team colour, replicated by the
snapshot.

## Content and trust

The bundled places are archived 2007 Roblox content, included for
preservation. Imported `.rbxl`/`.rbxm` files run their embedded scripts on
the built-in Lua layer, so only load files you trust.

`web/index.html` sets a Content-Security-Policy that allows only local and
embedded (`data:`/`blob:`) resources plus the configured relay. It does not
allow inline scripts: page handlers are bound from `js/main.js`, and the
JSON-LD block is allowed by hash. A `TextureId`/`SoundId` pointing at an
outside URL is blocked, and there is no `HttpService`, so place scripts have
no network access.

The relay is public infrastructure, not authentication: anyone who can reach
it can create a public room. Run it behind the tunnel with the loopback
bind, tune `MAX_CONNECTIONS`/`MAX_ROOMS`/rate limits in its `.env`, and put
per-IP/WAF rate limits on the tunnel as well. Never expose the Node port
directly.

The chat filter's safe-word guard (`web/js/safewords.js`) is generated from
the public-domain [dwyl/english-words](https://github.com/dwyl/english-words)
dictionary. It contains the dictionary words that are one edit away from a
banned word, so fuzzy matching does not censor ordinary words such as
`duck`, `luck`, `funky`, `maggot`, `regard` or `where`. The file header
records the source and date; regenerate it if the banned list changes.

## Controls (2007 client)

- **WASD** move · **Space** jump · **right-drag** camera · **wheel** zoom
- **W/S** on a ladder or truss: walk into it to grab, then climb up/down;
  **Space** pushes off. Ladders are the shipped brick models (Crossroads).
- **/** or click chat box, then **Enter** to chat
- Click the **speech-bubble** button beside the chat box for Super Safe Chat
  (categories → phrases; no typing needed)
- **1-0** hotbar (matches the HopperBins shipped in each place)
- First-person zooms below 6 studs (classic behavior)

## Development guard

This repo ships a pre-commit hook in `.githooks/` that blocks private relay
code, environment files, keys, tokens and logs from being committed. Enable it
once after cloning:

```sh
git config core.hooksPath .githooks
```

The hook is a guardrail, not a guarantee. Never put deployment secrets in this
public repo.
