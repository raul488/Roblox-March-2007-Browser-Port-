# Roblox 0.3.368.0 (2007)  browser port

**[Play it in your browser](https://raul488.github.io/Roblox-March-2007-Browser-Port-/)**

The actual March-2007 client rebuilt for HTML/JS/WebGL, using the
decompilation and the shipped content/place files as the only source of
truth. All engine constants, script behaviors, and content were mined
see `web/PORT.md` for the full ledger with decomp anchors.

Opencode was used for the making of this web port.
Credits to MaximumADHD for the original client! github.com/MaximumADHD/Roblox_0.3.368.0]
There is no online features due to possible security risks.

## Run it

Works from `file://`  no server needed:

1. Open `web/index.html` in any modern browser.
2. Pick a place (Crossroads, HappyHomeInRobloxia, HumanoidHarvesterHorror,
   RobloxHQ, TabulaRasa, Haunted Mansion) or drag a `.rbxl`/`.rbxm` XML file
   onto the window.

Everything (place data, sounds, character.rbxm, three.js r128) is embedded
in the `web/` tree  no network, no install.

## Content and trust

The bundled places are archived 2007 Roblox content, included for
preservation. Imported `.rbxl`/`.rbxm` files run their embedded scripts on
the built-in Lua layer, so only load files you trust.

The client ships a Content-Security-Policy (see `web/index.html`) that
allows only local and embedded (`data:`/`blob:`) resources. Place files
cannot load remote images, audio or scripts, so a `TextureId`/`SoundId`
pointing at an outside URL is simply blocked. There is no `HttpService`
either, so place scripts have no network access at all.

## Controls (2007 client)

- **WASD** move · **Space** jump · **right-drag** camera · **wheel** zoom
- **W/S** on a ladder or truss: walk into it to grab, then climb up/down;
  **Space** pushes off. Ladders are the shipped brick models (Crossroads).
- **/** or click chat box, then **Enter** to chat
- Click the **speech-bubble** button beside the chat box for Super Safe Chat
  (categories → phrases; no typing needed)
- **1–0** hotbar (matches the HopperBins shipped in each place)
- First-person zooms below 6 studs (classic behavior)

