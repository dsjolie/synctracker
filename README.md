# SyncTracker

A WebXR tracker-module player. MOD, S3M, XM and IT music, with the module's score (patterns,
rows, channels) laid out in space around you and driving demoscene-style visuals.

Status: first version — playback, the score lanes and a tunnel backdrop, in a flat page and
(untested on a headset so far) in VR.

## What it does

Each channel is a lane fanned out in front of you. The rows of the song come toward you along
the lanes, and each note lands on the "now" arc as you hear it. A note's height is its pitch,
its colour its instrument, its thickness its volume. Arcs across the lanes mark beats
(4 rows) and bars (16 rows).

Around it all is a demoscene tunnel whose rings travel toward you with the music, one per
beat, and which brightens as notes land. It is computed from the view direction in one
fragment shader, with no textures.

In VR, the controller trigger plays, pauses and resumes, and replays after the end. Load the
module before entering VR.

## Run it

Plain ES modules, no build step. Serve the folder over HTTP (or HTTPS for a headset) and open
`index.html`. Then choose or drop a module file, or pass one by URL: `index.html?mod=<url>`.
Drag to look around, scroll to zoom, space to pause.

On Raven the app is registered as a static at `/s/synctracker/`, with the local test modules
at `/s/synctracker-mods/`, e.g.
`https://<raven>:3443/s/synctracker/?mod=../synctracker-mods/k_jose_-_energy.s3m`.

## Code

- `main.js` wires the player to the scene and keeps the play-position clock. libopenmpt
  reports where it is *rendering*; the play head is that minus the audio output latency,
  interpolated between row changes.
- `timeline.js` works out the song as played, the sequence of (order, row) steps following
  position jumps and pattern breaks, so rows can be shown before they play.
- `scene.js` is the three.js scene and the tunnel. Every note is in one instanced mesh built once per song,
  and the vertex shaders place it from a single uniform (the play head), so scrolling
  uploads no buffers or textures.
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
