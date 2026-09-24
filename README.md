# SyncTracker

A WebXR tracker-module player. MOD, S3M, XM and IT music, with the module's score (patterns,
rows, channels) laid out in space around you and driving demoscene-style visuals.

Status: plays in a flat page and in VR (Quest), with selectable layouts, backdrops, note
shapes and views, a VR menu with every setting, and a module library.

## What it does

Each channel is a lane. The rows of the song come toward the play point along the lanes, and
each note lands there as you hear it. A note's lift off its lane is its pitch, its colour its
instrument, its thickness its volume. Strips across the lanes mark beats (4 rows) and bars
(16 rows). A pad per lane flashes when the channel plays.

Choices (on the page, and on the VR menu's Play tab):

- **Layout**: *Fan* (lanes radiating out in front), *Highway* (parallel lanes), *Wheel*
  (a disc, one ring per channel, rows turning down to the play point), *Tube* (channels
  around a tube you look down), *Vortex* (a tube narrowing and twisting away), *Tracker*
  (a wall of columns like a tracker screen, rows scrolling up past the play line).
- **Backdrop**: *Tunnel*, *Starfield* (warp), *Synthwave* (sun, mountains, grid floor),
  *Kaleidoscope*, *Nebula*, *Plasma*, *None*. All move with the music, not the
  clock, and brighten as notes land.
- **Notes**: *Box*, *Gem*, *Ball*, *Tile*, or *Text* (the note names, e.g. `C#5`).
- **View** presets for where the score sits: *In front*, *Around you*, *Big screen*,
  *Tabletop*.

Everything else is under Settings (the page's Settings section, the VR menu's Settings tab),
all remembered per browser: score distance/height/scale, rows ahead, row spacing, note width,
pitch lift, hit rings, beat strips; backdrop fade (how far ahead of you depth-based
backdrops fade out), brightness, spread, speed, pulse; audio offset (for sync by eye),
foveation, FPS display; and the menu's height, distance and tilt. The list is in
`settings.js`; the page and VR controls are generated from it.

In VR: point at the menu and pull the trigger. Its tabs are Play, Library (browse folders
and pick a track) and Settings, with Hide and Exit VR alongside. The trigger elsewhere or A/X
plays and pauses; B/Y shows and hides the menu; thumbstick flicks step through layouts
(left/right) and backdrops (up/down). Hold one grip and move your hand to drag the score
up/down and closer/away (closer/away at twice the hand's motion); hold both and pull your
hands apart or together to scale it. The score settings take the new values on release.

## Run it

Plain ES modules, no build step. Serve the folder over HTTP (or HTTPS for a headset) and open
`index.html`. Choose or drop a module file, pick one from the library, or pass one by URL:
`index.html?mod=<url>`. Drag to look around, scroll to zoom, space to pause.

WebXR and the audio worklet need a secure context: `localhost` works for development, a
headset needs HTTPS.

### Library

The library panel shows a folder tree from an `index.json`, loaded from `mods/index.json`
(next to `index.html`) by default or from `?library=<url>`. Put modules in `mods/`, in
subfolders if you like (it can be a link to a folder elsewhere; it is git-ignored), and write
the index with

```
python tools/index-mods.py [folder]
```

which walks the folder (subfolders and junctions included) and indexes the module files in
it. Re-run it after adding, moving or renaming modules.

## Code

- `settings.js`: every setting, with its range and default.
- `main.js` wires the player, scene, library and VR menu together, applies the settings, and
  keeps the play-position clock. libopenmpt reports where it is *rendering*; the play head
  is that minus the audio output latency, interpolated between row changes.
- `timeline.js` works out the song as played, the sequence of (order, row) steps following
  position jumps, pattern breaks and pattern loops, so rows can be shown before they play.
- `scene.js` is the three.js scene. Each layout is one GLSL function,
  `layoutPos(rows ahead, lane)`; box orientation, lane lines, pads and beat strips are
  derived from it. Every note is in one instanced mesh built once per song, placed by the
  vertex shaders from a single play-head uniform, so a frame uploads no buffers or textures.
- `backdrops.js`: the backdrop shaders, on a sphere around the listener.
- `vr-panel.js`: the VR menu (Play and Settings tabs), a canvas texture redrawn only when its
  content or the hovered button changes.
- `library.js`: the library tree.
- `vendor/chiptune3/` is [chiptune3](https://github.com/DrSnuggles/chiptune) 0.8.9
  (libopenmpt on an AudioWorklet), unmodified.

## Test

`test/timeline.test.mjs` renders modules at full speed in Node and checks that every row
libopenmpt plays matches the timeline:

```
node test/timeline.test.mjs path/to/*.mod path/to/*.xm
```

Module files are not in the repo.

Pattern loops (E6x / SBx) are unrolled. On 148 modules (7 CC0 test tracks plus a private
collection) the timeline matches libopenmpt row for row.
