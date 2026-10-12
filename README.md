# MusicLab

A browser-based DAW with an Ableton-style arrangement view. It runs entirely
client-side as a static site: no backend, no accounts, no analytics. Projects
are saved to your own disk as a single `.musiclab` file.

**Features**

- Transport: play/stop, loop region, tempo, bar.beat.sixteenth + time display,
  Space toggles playback, follow-playhead.
- Arrangement: audio and MIDI tracks, bar/beat ruler, zoom, scroll, snap
  (adaptive or fixed grid), click/drag the ruler to seek. Add, rename,
  drag-to-reorder, and delete tracks.
- Drag audio in: drop WAV/MP3/OGG/FLAC files (whatever your browser can decode)
  onto the timeline. Clips land on the track and beat under the cursor.
  Dropping on empty space makes a new track, and dropping several files stacks
  them on new tracks. Files that fail to decode show an error toast.
- Clip editing: select (click, Shift/Ctrl-click, marquee), move (also across
  tracks), trim either edge, split at playhead, duplicate, delete, nudge with
  the arrow keys. Every edit can be undone and redone.
- Mixer: per-track volume, pan, mute, solo, and stereo peak meters, plus master
  volume and meter.
- MIDI: piano roll (draw, move, resize, delete notes, edit velocity, transpose,
  read-only pitch-bend curve), plus two built-in instruments running in
  AudioWorklets, with their parameters in the Device panel:
  - **SubSynth**, a polyphonic subtractive synth. It follows pitch bend (with
    a Bend Range parameter) and moves its filter cutoff with CC 1, CC 74,
    and a configurable Filter CC.
  - **DrumKit**, a synthesized General MIDI drum kit (kick, snare, closed and
    open hats, cymbals, toms, rim, clap, and blips for the other percussion
    notes), with a Level and Tune knob per voice group.

  The computer keyboard plays the selected MIDI track.
- Standard MIDI Files: drop a `.mid`/`.midi` file onto the arrangement (or
  use **Import MIDI**, which imports at the playhead). You get one MIDI track
  per file track (format 0 files are split by channel), named from the file.
  Channel 10 gets DrumKit and the other channels get SubSynth. Notes, pitch
  bend, and controllers are kept, and the whole import is one undo step.
  **Export MIDI** writes a format-1 `.mid` (whole song or loop region) with a
  tempo track and one track per MIDI track.
- Save/Open `.musiclab` files with the File System Access API where the
  browser supports it, and download / file input everywhere else. The page
  warns before you leave with unsaved changes.
- Export the mix (whole song or loop region) to 16-bit or 32-bit-float WAV.
  The render uses an OfflineAudioContext and the same engine code as live
  playback.

## Run

Requires Node.js 18+ (developed with Node 22).

```sh
npm install
npm run dev        # http://localhost:5173
```

Use a Chromium-based browser for the best experience. Firefox and Safari work
for playback and editing, but they lack the File System Access API, so saving
falls back to a download.

## Build & check

```sh
npm run typecheck  # tsc, strict mode
npm run lint       # eslint
npm test           # vitest unit tests
npm run build      # production build into dist/
npm run check      # all of the above
npm run preview    # serve dist/ locally
```

## Deploy

`npm run build` produces a fully static `dist/` folder. Assets use relative
paths, so you can serve it from any static host and any sub-path: GitHub
Pages, Netlify, Cloudflare Pages, S3, `python3 -m http.server`, and so on.
It needs no server configuration, but the page must be served over `https://`
or `http://localhost`, because AudioWorklet requires a secure context.
Opening `index.html` straight from `file://` will not work.

## Keyboard shortcuts

`Ctrl` means `Cmd` on macOS.

| Keys | Action |
| --- | --- |
| Space | Play / stop |
| Stop while stopped (■ button) | Return to start (or to loop start) |
| Home / End | Go to start / end of last clip |
| Ctrl+L | Loop on/off |
| Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) | Undo / redo |
| Ctrl+S / Ctrl+Shift+S | Save / Save as |
| Ctrl+O | Open project |
| Ctrl+Shift+E | Export WAV |
| Delete / Backspace | Delete selected clips (or selected notes in the piano roll) |
| Ctrl+D | Duplicate selected clips (or notes in the piano roll) |
| Ctrl+E | Split selected clips at the playhead (all clips under it if none selected) |
| Ctrl+A | Select all clips (all notes in the piano roll) |
| ← / → | Nudge selected clips by the grid (notes in the piano roll) |
| ↑ / ↓ (piano roll) | Transpose selected notes a semitone (Shift: an octave) |
| Ctrl+Shift+M | Insert a 1-bar MIDI clip at the playhead on the selected MIDI track |
| + / − | Zoom in / out |
| Ctrl+mouse wheel | Zoom around the mouse |
| Shift+mouse wheel | Scroll horizontally |
| Alt while dragging | Bypass snapping |
| Esc | Clear selection / close dialog |
| M | Computer MIDI keyboard on/off |
| A W S E D F T G Y H U J K O L P ; ' | Play notes (C to F an octave up) on the selected MIDI track |
| Z / X | Keyboard octave down / up |
| C / V | Keyboard velocity down / up |

**Mouse**

- Double-click an empty spot on a MIDI track to create a clip there, and
  double-click a MIDI clip to open it in the piano roll.
- Ruler: click or drag to seek. Drag in the thin top strip to draw a loop
  region. When the loop is on, drag its edges to resize it and its middle to
  move it. Click inside it to toggle the loop.
- Piano roll: click to draw a note (drag to set its length), drag a note to
  move it, drag its right edge to resize, double-click to delete,
  Shift-drag to box-select, and drag the bars in the velocity lane to set
  velocity. Click the keys on the left to audition notes.
- Track header: double-click the name to rename it, and drag the colored strip
  to reorder.
- Mixer faders, pan, and device knobs: double-click to reset.

## Project file format

A `.musiclab` file is a zip archive:

```
project.json                   # the project model (has "schemaVersion", currently 2)
audio/<assetId>/<fileName>     # each original audio file, byte-for-byte
```

`project.json` stores all musical time in beats, along with the project tempo.
MIDI clips can carry optional `bends` (`{ beat, semitones }`) and `ccs`
(`{ beat, controller, value }`) lists next to their notes. These use the
same clip-content beats as notes, so trimming and splitting treat them the
same way (added in schema 2).
Opening a file validates it fully (`src/model/validate.ts`). A file written by
a newer schema version is refused with a clear message, and older versions
pass through `migrate()`.

## Architecture

```
src/model/        plain-data project model, commands (every edit), undo history, validation
src/engine/       Web Audio engine: scheduler math, AudioEngine (live + offline), WorkletDevice host
src/devices/      Device interface, shared worklet processor host, SubSynth and DrumKit (descriptors + DSP cores)
src/midi/         Standard MIDI File parser/writer (smf.ts), SMF -> model import, project -> SMF export
src/persistence/  .musiclab read/write (fflate)
src/app/          controller (intents, file IO, engine lifecycle), stores, keyboard
src/ui/           React chrome + canvas timeline and piano roll
src/util/         WAV encoder, waveform peaks
```

- **Model.** Immutable, JSON-serializable data. Every edit is a `Command`
  (`src/model/commands.ts`), a labelled pure function from one project state
  to the next. `History` keeps before/after snapshots, so undo and redo cover
  everything. Continuous gestures (faders, knobs) merge into one undo step.
- **Engine.** `AudioEngine.setProject()` diffs the model into native nodes
  (GainNode, StereoPannerNode, AudioBufferSourceNode, AnalyserNode). A
  lookahead scheduler runs every 25 ms with a 120 ms horizon and calls the
  pure `scheduleWindow()` (`src/engine/schedule.ts`), the only place beats
  become seconds. Edits during playback stop and re-chase only the affected
  clips. WAV export runs the same `AudioEngine` and `scheduleWindow()` inside
  an `OfflineAudioContext`.
- **UI.** Components call controller methods and read from stores. They never
  touch Web Audio objects.
- **Devices.** A `DeviceDefinition` (parameter descriptors, processor name,
  I/O) plus an AudioWorklet processor that speaks a small message protocol:
  timed `noteOn`/`noteOff`/`allNotesOff`/`pitchBend`/`cc` events, `params`,
  and `reset`. Events known in advance (offline render) arrive through
  `processorOptions`. Both instruments share one processor host
  (`src/devices/processorHost.ts`). It applies each event at its exact sample
  frame and drives a pure-TypeScript `InstrumentCore`. A future plugin format
  can be adapted by writing a definition and a wrapper processor that speaks
  this protocol.
- **MIDI files.** `smf.ts` reads and writes the bytes (ticks, raw messages)
  and has no dependencies. Import converts ticks to beats with the file's
  PPQ and builds one batched `Command`. Export takes its notes and controller
  events from `collectMidi()` in `src/engine/schedule.ts`, the same function
  playback uses, so the file contains exactly what plays. Converting those
  beats to seconds still happens only in `scheduleWindow()`.

## Tests

`npm test` runs the unit tests. They cover:

- the project model and every command, including undo/redo
- history merging and dirty tracking
- beat/second and tick/beat conversion
- the scheduler's clip-window, loop, and bend/CC chasing math
- the SubSynth DSP, including pitch bend and CC filter mapping
- the DrumKit DSP, which must render bit-identically whatever the
  render-quantum splits
- the SMF parser: formats 0 and 1, running status, note-on with velocity 0,
  overlapping same-pitch notes, RPN bend range, and malformed files
- a MIDI export → import round trip that must yield identical notes, bends,
  and CCs
- the schema 1 → 2 migration, validation, and a save → open round trip that
  must yield an identical project
- the WAV encoder, waveform peaks, and timeline geometry

### Browser smoke tests (optional)

`e2e/` contains Playwright scripts that drive the real app in Chromium. They
cover:

- file drops, including a corrupt file
- clip editing, MIDI and synth, mixer, and loop
- WAV export checked for signal
- save → reload → open
- dropping a Standard MIDI File (`e2e/fixtures/groove.mid`, generated by
  `e2e/make-midi-fixture.mjs`) and a malformed one, undoing the import, live
  DrumKit playback, a MIDI export → re-import, and WAV export of the import
  checked for signal

They are not part of `npm test` and need extra tools:

```sh
npm i --no-save playwright-core
npx playwright-core install chromium   # or set CHROMIUM_PATH to an existing Chromium
e2e/make-fixtures.sh /tmp/ml           # needs ffmpeg
npm run dev &                          # in another terminal
node e2e/flows.mjs /tmp/ml
node e2e/editing.mjs /tmp/ml
node e2e/offline-render.mjs /tmp/ml
node e2e/midi.mjs /tmp/ml
```

## License

MIT, see [LICENSE](LICENSE). Runtime dependencies: React and React DOM (MIT)
and fflate (MIT).
