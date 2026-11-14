# Roblox 0.3.368.0 (2007) browser port

**[Play it in your browser](https://raul488.github.io/Roblox-March-2007-Browser-Port-/)**

The March 2007 client rebuilt for HTML/JS/WebGL. Engine constants, script
behavior and content come from the decompilation and the shipped content
and place files.

Built with opencode. The original client is MaximumADHD's
[Roblox_0.3.368.0](https://github.com/MaximumADHD/Roblox_0.3.368.0).

Play Solo works fully offline. Multiplayer is optional and peer-hosted; the
client never opens a peer-to-peer connection.

## Running it

The client runs by opening `web/index.html` in a modern browser, with no
server needed; it works from `file://`.

Places (Crossroads, HappyHomeInRobloxia, HumanoidHarvesterHorror, RobloxHQ,
TabulaRasa, Haunted Mansion) are picked from the start page, and a
`.rbxl`/`.rbxm` XML file can be dragged onto the window.

Place data, sounds, character.rbxm and three.js r128 are all embedded in
`web/`. Play Solo needs no network and no install.

The start page's avatar panel includes a free, horizontally scrolling shelf
of 64 T-shirts (54 documented classic catalog shirts, many from 2007, plus
10 custom Homestead contest shirts; textures under `web/content/tshirts/`)
and a Face shelf with the classic smiley plus the custom faces recovered from
the 2007 Homestead contest avatars. The T-shirt row scrolls sideways with the
mouse wheel. There is no image upload; shirts are picked from
the shelf or `None`. Old data-URL shirts saved by earlier builds are cleared
on load.

## Multiplayer

Multiplayer uses a peer-hosted listen server. One player's browser runs the
room; other players join through a private relay. The relay keeps the room
list, enforces the 16-player cap, and routes messages. It does not expose
player IP addresses to other players. A modified host can still cheat its
own room, and the relay cannot verify that host's filtering.

Joiners predict their own movement and correct against the host's
acknowledged input, so latency does not snap them back. Remote avatars
interpolate toward the latest snapshot.

The relay endpoint is set in `web/js/netconfig.js`. The relay itself is a
separate component and is not included in this repository.

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
the built-in Lua layer, so only trusted files should be loaded.

`web/index.html` sets a Content-Security-Policy that allows only local and
embedded (`data:`/`blob:`) resources plus the multiplayer relay origin. It
does not allow inline scripts: page handlers are bound from `js/main.js`, and
the JSON-LD block is allowed by hash. A `TextureId`/`SoundId` pointing at an
outside URL is blocked, and there is no `HttpService`, so place scripts have
no network access.

The chat filter's safe-word guard (`web/js/safewords.js`) is generated from
the public-domain [dwyl/english-words](https://github.com/dwyl/english-words)
dictionary. It contains the dictionary words that are one edit away from a
banned word, so fuzzy matching does not censor ordinary words such as
`duck`, `luck`, `funky`, `maggot`, `regard` or `where`. The file header
records the source and date; it is regenerated when the banned list changes.

## Controls (2007 client)

- **WASD** move · **Space** jump · **right-drag** camera · **wheel** zoom
- **W/S** on a ladder or truss: walk into it to grab, then climb up/down;
  **Space** pushes off. Ladders are the shipped brick models (Crossroads).
- **/** or click chat box, then **Enter** to chat
- Click the **speech-bubble** button beside the chat box for Super Safe Chat
  (categories → phrases; no typing needed)
- **1-0** hotbar (matches the HopperBins shipped in each place)
- First-person zooms below 6 studs (classic behavior)
