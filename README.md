# Roblox 0.3.368.0 (2007) browser port

**[Play it in your browser](https://raul488.github.io/Roblox-March-2007-Browser-Port-/)**

The March 2007 client rebuilt for HTML/JS/WebGL. Engine constants, script
behavior and content come from the decompilation and the shipped content
and place files.

Built with opencode. The original client is MaximumADHD's
[Roblox_0.3.368.0](https://github.com/MaximumADHD/Roblox_0.3.368.0).

Play Solo works fully offline. Multiplayer is optional and peer-hosted;
this build points at the project's Tailscale Funnel relay by default (see
`web/js/netconfig.js`). The client never opens a peer-to-peer connection.
## Run it

Open `web/index.html` in any modern browser. It works from `file://`, with
no server.

Pick a place (Crossroads, HappyHomeInRobloxia, HumanoidHarvesterHorror,
RobloxHQ, TabulaRasa, Haunted Mansion) or drag a `.rbxl`/`.rbxm` XML file
onto the window.

Place data, sounds, character.rbxm and three.js r128 are all embedded in
`web/`. Play Solo needs no network and no install.

The start page's avatar panel includes a free, horizontally scrolling shelf
of 44 T-shirts (34 documented 2006-early-2007 catalog shirts, 10 custom
Homestead contest shirts; textures under `web/content/tshirts/`) and a Face
shelf with the classic smiley plus the custom faces recovered from the 2007
Homestead contest avatars. There is no image upload; pick a box or `None`
for shirts. Old data-URL shirts saved by earlier builds are cleared on load.

## Multiplayer

Multiplayer uses a peer-hosted listen server. One player's browser runs the
room; other players join through a private relay. The relay keeps the room
list, enforces the 16-player cap, and routes messages. It does not expose
player IP addresses to other players. A modified host can still cheat its
own room, and the relay cannot verify that host's filtering.

Joiners predict their own movement and correct against the host's
acknowledged input, so latency does not snap them back. Remote avatars
interpolate toward the latest snapshot.

The client is configured in `web/js/netconfig.js`:
```js
window.RBLX_RELAY_URL = 'https://relay.example.com';
```

This build points at the Tailscale Funnel relay
`https://desktop-33lh8ah.tail4210dd.ts.net`.

Add the relay origins to the `connect-src` directive in `web/index.html`:

```text
https://relay.example.com wss://relay.example.com
```

On `localhost` or `127.0.0.1`, an empty config defaults to
`http://127.0.0.1:8788` for local testing. Serve `web/` over HTTP, not
`file://`, for local multiplayer.

In Host & Play, the host's browser runs the authoritative world and
simulates every joined character. Joiners render remote avatars, chat, and
predict their own movement. They do not run the place's server Scripts.
Remote avatars use the player's body colors and a downscaled T-shirt.

Chat is ASCII-only, capped at 100 characters, rate-limited, and filtered for
profanity and slurs, including spaces, punctuation, leetspeak, inserted
digits, and doubled letters. A per-player Safe Chat toggle disables typing
and allows only exact phrases from the shipped Super Safe Chat tree; received
messages are checked against that list. The setting persists. Obvious slurs
mute the sender for one minute.

Usernames are filtered when committed; a filtered name falls back to
`Player1`. Live typing only strips illegal characters, so `assassin` can
still be entered. Names are capped at 20 characters with ASCII
letters/numbers, at most one space and one underscore.

The relay sees room names, display names, chat, avatars, and game state. A
T-shirt you choose is shared with the players in your room.

Host changes replicate to joiners: tool-created and moving parts, grabbed
bricks, beacon and regen geometry, explosions, and place-script Touched
events, so remote players trigger jumppads and beacons. Remote characters
are carried by the moving assembly they stand on. Joiners can use the
built-in BinTypes 1-7 through host-side proxy managers: rocket, slingshot,
laser, GameTool/Grab, clone, and hammer. Custom BinType 0 Lua gear remains
host-only.

Host (No Player) creates a room without a local character. The tab must stay
open and visible because browsers pause background tabs; there is no native
headless server. Duplicate display names get a numeric suffix (`Alice`,
`Alice2`). When the place has a Teams service, the host assigns players to
the team with the fewest members, and the snapshot replicates team colors to
name tags and the player list.

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
