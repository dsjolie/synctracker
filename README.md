# SyncTracker

A WebXR tracker-module player. MOD, S3M, XM and IT music, with the module's score (patterns,
rows, channels) laid out in space around you and driving demoscene-style visuals.

Status: plays in a flat page and in VR (Quest), with selectable layouts, backdrops and views,
a VR control panel, and a module library.

## What it does

Each channel is a lane. The rows of the song come toward the play point along the lanes, and
each note lands there as you hear it. A note's lift off its lane is its pitch, its colour its
instrument, its thickness its volume. Strips across the lanes mark beats (4 rows) and bars
(16 rows). A pad per lane flashes when the channel plays.

Choices, on the page and on the VR panel (remembered per browser):

- **Layout**: *Fan* (lanes radiating out in front), *Highway* (parallel lanes), *Wheel*
  (a disc, one ring per channel, rows turning down to the play point), *Tube* (channels
  around a tube you look down).
- **Backdrop**: *Tunnel* (rings travel toward you, one per beat), *Plasma*, *Copper bars*
  (Amiga raster bars), *None*. All brighten as notes land.
- **View**: *In front* (the score as a stage ahead of you), *Around you*, *Tabletop*.

In VR a panel at waist height shows the song and position and has Prev / Play-Pause / Next and
the three choices; point a controller and pull the trigger. The trigger pointed elsewhere
plays and pauses; the grip hides or shows the panel.

## Run it

Plain ES modules, no build step. Serve the folder over HTTP (or HTTPS for a headset) and open
`index.html`. Choose or drop a module file, pick one from the library, or pass one by URL:
`index.html?mod=<url>`. Drag to look around, scroll to zoom, space to pause.

On Raven the app is a static at `/s/synctracker/`, with local modules at
`/s/synctracker-mods/`, e.g.
`https://<raven>:3443/s/synctracker/?mod=../synctracker-mods/k_jose_-_energy.s3m`.

### Library

The library panel shows a folder tree from an `index.json`, loaded from
`../synctracker-mods/index.json` by default or `?library=<url>`. Write it with

```
python tools/index-mods.py [folder]
```

which walks the folder (subfolders and junctions included) and indexes the module files in
it. Re-run it after adding, moving or renaming modules.

## Code

- `main.js` wires the player, scene, library and VR panel together, holds the choices, and
  keeps the play-position clock. libopenmpt reports where it is *rendering*; the play head
  is that minus the audio output latency, interpolated between row changes.
- `timeline.js` works out the song as played, the sequence of (order, row) steps following
  position jumps, pattern breaks and pattern loops, so rows can be shown before they play.
- `scene.js` is the three.js scene. Each layout is one GLSL function,
  `layoutPos(rows ahead, lane)`; box orientation, lane lines, pads and beat strips are
  derived from it. Every note is in one instanced mesh built once per song, placed by the
  vertex shaders from a single play-head uniform, so a frame uploads no buffers or textures.
- `backdrops.js`: the backdrop shaders, on a sphere around the listener.
- `vr-panel.js`: the VR panel, a canvas texture redrawn only when its content or the hovered
  button changes.
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

Pattern loops (E6x / SBx) are unrolled. On 145 modules (7 CC0 test tracks plus a personal
archive) the timeline matches libopenmpt row for row.
