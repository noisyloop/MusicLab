# Decisions made on your behalf

Where the brief left a choice open, I picked the simplest option that meets
the constraints. Each one is listed here.

## Stack & tooling
- **React 19, Vite 8, Vitest 5, TypeScript 6.0, ESLint 10.** TypeScript stays
  on 6.0 because typescript-eslint does not support 7 yet. Dependabot opens
  weekly update PRs for npm packages and GitHub Actions. TypeScript runs with
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

## Insert effects
- **Model.** Each track has an `effects` list, and the master chain lives at
  `project.master.effects`, next to the master volume. A slot is
  `{ id, type, params, bypass }`. Schema 3's migration gives every track and
  the master an empty list. Validation:
  - rejects an unknown or non-effect type, naming the slot ("tracks[1].effects[0].type: unknown effect type …");
  - rejects duplicate slot ids within a chain;
  - clamps parameters and fills missing ones, the same as for instruments.

  Chains are addressed as `MASTER_CHAIN` (`'master'`) or a track id.
- **Inserts are pre-fader on the master too:** master input → chain → master
  volume → meter/output.
- **Rewiring.** A true crossfade between the old and new wiring isn't
  possible when reordering. During the fade both orders would be connected
  (A→B and B→A), and Web Audio mutes such cycles. So adding, removing, or
  reordering effects ducks that chain's output to silence over 5 ms, rewires
  it, and fades back in over 5 ms. The rewire waits about 12 ms of wall-clock
  time (a timer) for the duck to finish, so the gap can stretch if the main
  thread is busy. It is still click-free. Effects that stay in the chain keep
  their state, so tails continue. Bypass needs no rewire at all: the
  processor crossfades over 10 ms.
- **Bypass.**
  - Fully bypassed, the effect copies its input to its output (bit-identical)
    and does no processing.
  - Leaving full bypass starts the effect from a cleared state, so an old
    tail doesn't reappear.
  - A bypassed effect counts as inactive for the FX badge and the export tail.
- **Tails and stop.** Effect processors are never reset on stop, seek, or
  MIDI edits; only instruments are. Effects keep running for as long as the
  track exists. The WAV export tail is 2 s (instrument releases) plus the
  longest track-chain tail plus the master chain's tail, capped at **10 s**.
  Within a chain, the tails of active effects add up:
  - Delay: time × (1 + the number of repeats needed to fall 60 dB).
  - Reverb: pre-delay + decay.
  - Other effects: 0.
- **Tempo sync.**
  - Effects receive `transport` messages (context time, beat, BPM, beats per
    bar). The engine sends one at play start and one at each loop wrap. It
    also sends one when the tempo or bar length changes, at the current
    position.
  - An offline render gets the same information up front: the range start,
    at time 0.
  - A synced delay's time glides over about 50 ms when the tempo changes.
  - The filter LFO's phase comes from the song position (beat ÷ period),
    so it lines up with bars, and live and export match. It free-runs while
    stopped.
  - "1 bar" uses the project's beats per bar.

  Converting a note value to a delay time inside an effect is a beats →
  seconds conversion outside `scheduleWindow()`. It is local to the effect
  and doesn't schedule anything.
- **Effect designs.**
  - **EQ3**:
    - RBJ cookbook biquads (shelves with S = 1);
    - the low cut is a 12 dB/oct high-pass that is always on, defaulting to
      20 Hz.
  - **Compressor**:
    - a peak detector on max(|L|,|R|) (stereo-linked);
    - the Giannoulis/Massberg/Reiss soft-knee curve;
    - attack/release smoothing of the gain in dB;
    - it reports gain reduction about every 20 ms.
  - **Delay**:
    - the wet signal goes through one-pole low- and high-pass filters, and
      that filtered signal feeds back, so the filters are in the feedback
      path;
    - ping-pong feeds the mono sum into the left line and crosses the
      feedback between channels;
    - the line holds up to 5 s.
  - **Reverb**:
    - Freeverb's comb and allpass topology, with each comb's feedback derived
      from the Decay (RT60), so the knob means seconds;
    - no modulation and no noise, so it is deterministic.
  - **Saturator**:
    - 2× oversampling with zero-stuffing and 31-tap Blackman half-band FIRs;
    - the dry signal is delayed 15 samples to stay aligned for the dry/wet
      mix;
    - Tone is a one-pole low-pass on the wet signal.
  - **Filter**:
    - a TPT state-variable filter;
    - the LFO is ± Depth octaves around the cutoff.
- **"Knobs"** are the same sliders the instrument uses (double-click
  resets). Enum parameters with more than four options (such as the delay
  sync values) are drop-downs.
- **Track duplication** didn't exist yet. It is now ⧉ on the track header. It
  inserts a "<name> copy" track below the original, with fresh track, clip,
  and effect-slot ids, and the same content.

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
- **Autosave goes to IndexedDB, not to the file.** Writing back to the
  user's file without asking would make Save meaningless, and most browsers
  can't write to it anyway. So only unsaved work is autosaved, and only for
  recovery. A copy is written 1 s after the last edit (at most 5 s after the
  first one, so a long fader drag still gets saved) and when the tab is
  hidden. It is deleted when the project has no unsaved changes, including
  after an undo back to the saved state.
- **One autosave per tab.** Each tab writes under its own session id, so two
  tabs never overwrite each other. Each tab holds a Web Lock named after its
  id, and on startup only copies from tabs that are no longer open are
  offered, newest first. Without Web Locks, every other tab's copy is offered.
- **Audio is stored once.** Audio bytes go in a separate store keyed by asset
  id and are written only when missing. The project JSON is rewritten on
  every autosave. Assets no autosave references are deleted along with the
  last one that did.
- **A restored project is unsaved.** It has no file handle and no undo
  history, and it shows the unsaved dot until you save it. Restoring
  replaces the current project (after the usual confirmation if that has
  unsaved changes). If autosave writes fail (for example, the storage quota
  is full), one error toast appears, and no more until a write succeeds.
