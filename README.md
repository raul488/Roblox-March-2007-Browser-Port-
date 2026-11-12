# Roblox 0.3.368.0 (2007) browser port

**[Play it in your browser](https://raul488.github.io/Roblox-March-2007-Browser-Port-/)**

The March 2007 client rebuilt for HTML/JS/WebGL. Engine constants, script
behavior and content come from the decompilation and the shipped content
and place files.

Built with opencode. The original client is MaximumADHD's
[Roblox_0.3.368.0](https://github.com/MaximumADHD/Roblox_0.3.368.0).

There are no online features, for security reasons.

## Run it

Open `web/index.html` in any modern browser. It works from `file://`, with
no server.

Pick a place (Crossroads, HappyHomeInRobloxia, HumanoidHarvesterHorror,
RobloxHQ, TabulaRasa, Haunted Mansion) or drag a `.rbxl`/`.rbxm` XML file
onto the window.

Place data, sounds, character.rbxm and three.js r128 are all embedded in
`web/`. No network, no install.

## Content and trust

The bundled places are archived 2007 Roblox content, included for
preservation. Imported `.rbxl`/`.rbxm` files run their embedded scripts on
the built-in Lua layer, so only load files you trust.

`web/index.html` sets a Content-Security-Policy that allows only local and
embedded (`data:`/`blob:`) resources. A `TextureId`/`SoundId` pointing at an
outside URL is blocked, and there is no `HttpService`, so place scripts
have no network access.

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
