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
