# Decisions made on your behalf

Where the brief left a choice open, I picked the simplest option that meets
the constraints. Each one is listed here.

## Stack & tooling
- **React 18, Vite 6, Vitest 3, TypeScript 5.7, ESLint 9.** These are proven
  versions I could verify, not the newest majors. TypeScript runs with
  `strict`, `noUncheckedIndexedAccess`, and unused-code checks. ESLint
  forbids `any`. The codebase has no `any`; the few `as unknown as` casts each
  carry a comment explaining why.
- **No state library.** A 40-line external store (`src/app/store.ts`) on
  `useSyncExternalStore` is enough. Runtime dependencies are only React,
  React DOM, and fflate.
- **License check.** Every runtime dependency is MIT. The dev-only toolchain
  is MIT/ISC/BSD/Apache, apart from `caniuse-lite` (CC-BY-4.0), a data package
  that Babel pulls in at build time and that is never shipped in the app.
- **Browser smoke tests** use `playwright-core`, which is not a project
  dependency (install with `--no-save`). This keeps `npm install` lean.

## Model
- **Time signature.** I store only `beatsPerBar` (default 4). The beat unit is
  always a quarter note, and the UI does not expose time-signature changes.
- **One tempo per project.** There is no tempo automation.
- **Schema 2** adds optional `bends` and `ccs` lists to MIDI clips. They are
  stored in clip-content beats like notes, so split, trim, duplicate, and
  save/open handle them with no special cases. Both lists are omitted when a
  clip has none, so projects without expression data round-trip unchanged.
  `migrate()` now runs one step per version. The 1 → 2 step bumps the version
  and drops any stray `bends`/`ccs` keys, which a version-1 file can't
  legitimately contain.
- **Pitch bend is stored in semitones.** This is the musical intent, resolved
  at import with the file's own bend range. Bend and controller data apply to
  the whole channel (the track), not per note, as in MIDI.
- **Audio clip source offset in seconds.** Clip position and length are in
  beats. The offset into the audio file (`sourceOffset`) is in seconds,
  because audio is never time-stretched, so a file position is a time, not a
  musical value. Changing the tempo moves audio clips with the grid but keeps
  their playback speed.
- **Trimming converts beat deltas to file seconds in the command.** Only this
  adjustment of `sourceOffset` happens there. The command uses the shared
  `time.ts` helper. All playback scheduling (beats → AudioContext time) stays
  in the engine.
- **MIDI clips have a `contentOffset`** (beats) so left-trimming and splitting
  keep notes anchored in time. Split halves both keep the full note list, and
  each half plays only the notes that start inside its window. Extending a
  half later reveals the notes again, as in Ableton.
- **Overlapping clips are allowed** and both play. Ableton truncates the clip
  underneath instead; I skipped that.
- **Undo is snapshot-based.** Commands are pure functions, and `History`
  stores the before/after project objects. Structural sharing keeps this
  cheap, and it makes undo exact for every command, including composite ones.
- **Audio bytes are outside the model and outside undo.** Undoing a drop
  removes the asset entry from the project, but the decoded data stays in
  memory, so redo works. Saving writes only the assets that clips reference.
- **Track volume range** is 0–2 linear gain (−∞ to +6 dB). Faders use a
  curve that puts 0 dB about three-quarters of the way up.

## Engine
- **Scheduler.** 25 ms timer, 120 ms lookahead, 50 ms start latency.
- **Starting mid-clip.** Audio clips and notes that are already sounding at a
  play start, seek, or loop wrap are "chased", i.e. started part-way through.
- **Loop behaviour.** The loop applies while the playhead is before the loop
  end. Starting before the loop plays into it and then wraps. Starting after
  it plays on normally.
- **Stop.** Stop leaves the playhead where it is (Ableton-style). Pressing
  stop again returns it to the loop start or bar 1. Space plays from the
  current position.
- **Clicking empty arrangement space** while stopped moves the playhead there,
  like Ableton's insert marker, so "split at playhead" is easy to aim.
- **Edits during playback.** Changed or deleted audio clips are stopped and
  re-chased. A MIDI edit resets that track's instrument and re-chases all its
  clips. A tempo change restarts playback from the current position.
- **Offline export.** WAV export renders in an `OfflineAudioContext`. Note
  events go to the synth in `processorOptions`, because port messages are
  not guaranteed to arrive before offline rendering starts. Audio clips use
  the same `startAudio()` path as live playback. The export adds a 2-second
  tail, and its sample rate matches the live AudioContext.
- **Meters** are peak meters read from AnalyserNodes on each animation frame
  (−60 to +6 dB scale, red above 0 dBFS).

## Synth (SubSynth)
- 16 voices with oldest-voice stealing (released voices are stolen first).
  Two detuned oscillators with a shared waveform (PolyBLEP saw/square,
  triangle, sine) and an octave switch. A 12 dB/oct TPT state-variable
  low-pass filter with resonance and its own ADSR. An amp ADSR. Velocity
  sensitivity and output gain.
- The DSP is a plain TypeScript class (`synthCore.ts`), so it is unit-tested
  in Node and bundled into the worklet by Vite (`?worker&url`).

## Synth & drums: MIDI expression
- **SubSynth Bend Range (default ±12)** is the furthest the synth will bend.
  Stored bends are already in semitones, so they are clamped to this range,
  not scaled by it. A bend takes effect at the exact sample its event lands
  on: the processor host splits rendering at every event, and the bend is
  constant between events, so there is no glide or smoothing.
- **CC → cutoff.** CC 1 and the Filter CC (default 20) are unipolar, from 0
  (no change) to 127 (+4 octaves). CC 74 is bipolar around 64, ±4 octaves.
  The three add up. If the Filter CC is set to 1 or 74, that controller
  counts only once.
- **Controller state on transport jumps.** Stop, seek, and edits during
  playback reset the device, and a hard reset returns bend and CCs to their
  defaults. Play start, seek, loop wrap, and every clip start then "chase"
  state, the same way notes are chased. The scheduler sends the last bend
  and the last value of each controller from the clip content before that
  point.
- **Bend resets between clips.** On a track that uses bends anywhere, a clip
  with no earlier bend starts at bend 0, so a bent clip doesn't leave the
  next one bent. Controllers have no universal default, so they are not
  reset this way.
- **DrumKit** is fully synthesized, with no samples. It maps General MIDI
  drum notes as follows:
  - Kick: 35, 36
  - Snare: 38, 40
  - Rim: 37
  - Clap: 39
  - Toms: 41, 43, 45, 47, 48, 50
  - Hats: closed hat 42, pedal hat 44, and open hat 46, plus the cymbals
    (49, 51, 52, 53, 55, 57, 59)
  - Blips: every other note from 27 to 87, as short sine blips pitched by
    note number

  The closed and pedal hats choke the open hat. Note-offs are ignored
  because drums are one-shots. There are 32 voices, and the oldest is stolen.
  Each hit seeds its own noise generator from its note number, and all state
  advances per sample. The same events therefore render bit-identically in
  live playback and WAV export, whatever the render-quantum boundaries; a
  unit test checks this.
- **Shared processor host.** Both instruments use one AudioWorklet processor
  (`processorHost.ts`) that drives an `InstrumentCore`. Each device still
  has its own module and processor name.
- **Instrument picker.** The Device panel has a selector to switch a MIDI
  track between SubSynth and DrumKit (an undoable command). This wasn't
  asked for, but without it a drum track couldn't be made by hand.

## MIDI files
- **Parser/writer** written from the SMF spec (`src/midi/smf.ts`). Running
  status is supported on read but not used on write. SMPTE time division is
  rejected with an error. Unknown chunk types are skipped, as the spec
  requires.
- **What "malformed" means.** The file is rejected with an error toast, and
  the project is left unchanged, if it has any of these:
  - a missing or short header
  - a truncated chunk
  - a data byte with no running status
  - fewer tracks than the header declares
  - a VLQ longer than 4 bytes
  - no notes at all
- **Tempo.** A project counts as empty when it has no clips (tracks with no
  clips don't count). An empty project adopts the file's first tempo, and
  its first time signature if that is a whole number of quarter notes (6/8 →
  3 beats per bar; 7/8 is ignored). Otherwise the project's tempo and
  time signature stay as they are. **Tempo maps are always ignored:** ticks
  convert to beats with the PPQ alone, so the notes stay on the grid, and a
  file with tempo changes plays at one tempo. Time-signature changes after
  the first are ignored.
- **Tracks.**
  - Format 1 gives one MIDI track per SMF track. Format 2 is treated the same
    way.
  - Format 0 gives one MIDI track per channel. Those tracks are named
    "Name (Ch n)" when the file has a name and several channels are used.
  - SMF tracks without notes (conductor or tempo tracks, CC-only tracks) are
    skipped.
  - A track's channel is the channel most of its notes use. Channel 10 means
    DrumKit.
  - Tracks are inserted below the hovered track, or at the end.
- **Clips.** Each track gets one clip at the drop beat, with
  `contentOffset` 0. Its length is rounded up to whole bars. Leading silence
  in the file is kept, so the tracks stay aligned.
- **Notes.**
  - Overlapping notes of the same pitch pair first-in, first-out.
  - A note-on with velocity 0 is a note-off.
  - Zero-length notes get 1 tick.
  - Notes still held at the end of the track last until the track ends, and
    are at least a sixteenth long.
  - Velocity is `v / 127`.
- **What is kept and what is dropped.** Pitch bend is converted to semitones
  with the channel's RPN 0 range (General MIDI default ±2). The RPN/NRPN
  controllers themselves (6, 38, 96–101) are consumed and not stored. All
  other CCs are kept. Program change, aftertouch, sysex, and other meta
  events are dropped silently.
- **Several MIDI files dropped together** import one after another. Each is
  its own undo step.
- **"File → Import / Export MIDI"** are toolbar buttons next to Export WAV,
  because the app has no menu bar. Import MIDI imports at the playhead
  (snapped) below the selected track.
- **Export.**
  - Format 1 at 960 PPQ. Track 1 holds the project name, the time signature
    (beatsPerBar/4), and the tempo. Then there is one track per MIDI track,
    including empty ones. Audio tracks are skipped.
  - DrumKit tracks use channel 10. Other tracks use channels 1–9 and 11–16
    in order, wrapping around.
  - The notes and controller events written are the ones playback would
    schedule (`collectMidi()`). Content hidden by trimming is left out, notes
    are cut at clip ends, and notes already sounding at the start of the
    export range are chased, as in WAV export. Chased bend/CC state is only
    written when it changes what the receiver already has.
  - Each track with bends gets an RPN 0 bend range. The range is the integer
    that reaches every bend with the least 14-bit quantization error, so
    bends imported with a ±12 range export exactly.
  - End-of-track sits at the end of the range.

## UI
- **Layout.** Toolbar, arrangement (track headers plus canvas), and a
  resizable bottom panel with Mixer / Piano Roll / Device tabs. This mirrors
  Ableton's detail view instead of floating windows.
- **Snap.** The default grid is "Auto", which adapts to zoom. Fixed grids and
  Off are available, and holding Alt bypasses snapping during a drag. The
  piano roll has its own grid (default 1/16).
- **Drop placement.**
  - The first file lands on the hovered track if it is an audio track.
  - The remaining files, or all of them when dropped on empty space or a MIDI
    track, get new audio tracks stacked below the hovered track (or at the
    end).
  - All clips start at the snapped beat under the cursor.
  - Non-audio files and files that fail to decode get an error toast.
- **Dropping a `.musiclab` file** anywhere opens it, after asking for
  confirmation if there are unsaved changes.
- **Computer keyboard.** On by default, using Ableton's layout (A = C, row
  continues to `'`). It plays only when a MIDI track is selected and no
  modifier is held, so Ctrl shortcuts keep working. **M** toggles it.
- **No shortcut for adding tracks.** Ctrl+T / Ctrl+Shift+T are reserved by
  browsers and cannot be intercepted, so adding tracks uses the toolbar
  buttons.
- **Track height is fixed** (64 px).
- **Track deletion** uses the × on the track header, so it can't be
  confused with deleting clips.
- **Light theme.** None; the app is dark only, like most DAWs.

## Files
- **`.musiclab` = zip.** `project.json` is pretty-printed and deflated.
  Audio is stored uncompressed (level 0), at `audio/<assetId>/<fileName>`.
  Unreferenced assets are pruned on save.
- **Save without File System Access** downloads `<project name>.musiclab`, so
  a later "Save" downloads again. With File System Access, Save writes back to
  the same file handle.
