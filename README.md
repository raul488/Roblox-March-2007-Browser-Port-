# Roblox 0.3.368.0 (2007)  browser port

The actual March-2007 client rebuilt for HTML/JS/WebGL, using the
decompilation and the shipped content/place files as the only source of
truth. All engine constants, script behaviors, and content were mined
see `web/PORT.md` for the full ledger with decomp anchors.

Opencode was used for the making of this web port.
Credits to MaximumADHD for the original client! github.com/MaximumADHD/Roblox_0.3.368.0]
There is no online features due to possible security risks.

## Run it

Works from `file://`  no server needed:

1. Open `client/web/index.html` in any modern browser.
2. Pick a place (Crossroads, HappyHomeInRobloxia, HumanoidHarvesterHorror,
   RobloxHQ, TabulaRasa, Haunted Mansion) or drag a `.rbxl`/`.rbxm` XML file
   onto the window.

Everything (place data, sounds, character.rbxm, three.js r128) is embedded
in the `web/` tree  no network, no install.

## Controls (2007 client)

- **WASD** move · **Space** jump · **right-drag** camera · **wheel** zoom
- **W/S** on a ladder or truss: walk into it to grab, then climb up/down;
  **Space** pushes off. Ladders are the shipped brick models (Crossroads).
- **/** or click chat box, then **Enter** to chat
- Click the **speech-bubble** button beside the chat box for Super Safe Chat
  (categories → phrases; no typing needed)
- **1–0** hotbar (matches the HopperBins shipped in each place)
- First-person zooms below 6 studs (classic behavior)

