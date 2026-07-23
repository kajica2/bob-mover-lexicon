// Practice page MIDI player. Built on Tone.js (UMD bundle vendored at
// vendor/Tone.js). Strictly monophonic via Tone.MonoSynth; sample-accurate
// scheduling via Tone.Transport.
//
// Public API on window.playbackEngine:
//   init(): boolean            -- lazily create AudioContext + synth. Returns true on ready.
//   setNotes(notes, bpm):       -- replace the schedule. Notes are [{midi, beat, duration}, ...],
//                                  bpm is integer-ish.
//   play({onNote, onBeat, onEnd}): start playback now. Returns boolean.
//   stop():                     -- halt and clear the transport.
//   setTempo(bpm):              -- adjust tempo without losing progress.
//   setMetronome(on):           -- toggle a per-beat click.
//   dispose():                  -- tear down.

(function (root) {
  'use strict';

  // Default envelope / voice. MonoSynth inherits Synth which is a normal
  // oscillator+filter+envelope voice; the "mono" part is what guarantees
  // one note at a time (note-stealing built in).
  const SYNTH_OPTS = {
    oscillator: { type: 'triangle' },
    filter:     { type: 'lowpass', rolloff: -24, frequency: 1800 },
    envelope:   { attack: 0.01, decay: 0.08, sustain: 0.55, release: 0.04 },
    filterEnvelope: { attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.05, baseFrequency: 600, octaves: 2.6 },
  };

  // Metronome constants (only used when metronome is on).
  const METRO_DOWN_HZ  = 1600;
  const METRO_DOWN_VOL = -20;  // dBFS
  const METRO_BEAT_HZ  = 1000;
  const METRO_BEAT_VOL = -26;
  const METRO_SUB_HZ   = 1400; // higher than offbeat click so subdivisions pop
  const METRO_DUR      = 0.05; // seconds per click

  // Time signature → beats per bar. Used for the metronome's downbeat
  // detection. 6/8 is 6 eighth-note "pulses" per bar, with downbeats
  // every 3 (so beat 0 and beat 3 of each bar get the accent).
  const TIME_SIG_BEATS = { '4/4': 4, '3/4': 3, '6/8': 6, '2/4': 2 };
  // For 6/8, the metric "downbeat" is the dotted-quarter pulse, not
  // the literal beat 0/6. We override isDownbeat for 6/8 below.

  // Gain for note playback through the raw oscillator path. v22
  // polish: switched the body waveform from sine to triangle — it has
  // a touch of odd-harmonic content (-12dB/oct rolloff) that gives the
  // note a warm, sax-like presence on built-in Mac speakers without
  // the harshness of sawtooth. Plain oscillators at constant ~0.3 gain
  // through masterGain → Destination is unmistakably audible. NOTE_GAIN_AMP
  // sets the per-note linear gain; 0.30 = ~ -10 dBFS, well above
  // the noise floor but below digital clipping on busy runs.
  const NOTE_GAIN_AMP = 0.30;
  // Ramp at attack/release to suppress clicks at note edges. v22:
  // bumped from 0.005s to 0.010s — slightly smoother on the ear, and
  // matches the 5-10ms range used by commercial soft synths.
  const NOTE_RAMP_SEC = 0.010;

  // Is a given beat the downbeat for a time signature? Returns true
  // for beat 0 of each bar. For 6/8 we treat the dotted-quarter pulse
  // (every 3 eighths) as the downbeat — that's how musicians hear it.
  function isDownbeat(beatNum, timeSig) {
    const beats = TIME_SIG_BEATS[timeSig] || 4;
    if (timeSig === '6/8') return (beatNum % 3) === 0;
    return (beatNum % beats) === 0;
  }

  // Subdivision setting → Tone.Transport.scheduleRepeat interval string.
  // 'off' = 4n (one click per beat); '8ths' = 8n; 'triplets' = 8t;
  // '16ths' = 16n. The beat counter passed to onBeat increments
  // every subdivision tick, so the UI can know which subdivision
  // just fired (0 = downbeat if isDownbeat(subCount, timeSig)).
  const SUBDIV_TO_INTERVAL = {
    off:     '4n',
    '8ths':  '8n',
    triplets:'8t',
    '16ths': '16n',
  };

  // Visual callbacks fire via Tone.Draw so they align with render frames.
  // Web Audio's `setTimeout`-driven callbacks jitter; Tone.Draw is locked
  // to the audio thread, eliminating visible highlight lag.

  // ----- state -----
  let tone        = null;        // Tone.js top-level namespace (lazily resolved)
  let synth       = null;        // Tone.MonoSynth
  let metroDown   = null;        // Tone.MembraneSynth (downbeat click)
  let metroUp     = null;        // Tone.MembraneSynth (offbeat click)
  let notes       = [];          // current note array
  let bpm         = 120;         // currently-applied BPM
  let metronomeOn = false;
  // Metronome configuration — used by both in-exercise and standalone
  // metronome paths. v22 added: timeSig (4/4, 3/4, 6/8, 2/4) and
  // subdivision (off, 8ths, triplets, 16ths). Downbeats (per timeSig)
  // get a higher pitch; subdivisions get a higher-pitch click than
  // offbeats but lower than downbeats.
  let metroConfig = { timeSig: '4/4', subdivision: 'off' };
  let scheduledIds = [];         // Tone.Transport event ids (for cancel)
  let onNoteCb    = null;
  let onBeatCb    = null;
  let onEndCb     = null;
  let initialized = false;
  // Standalone-metronome-only state (set/cleared by startMetronome/stopMetronome)
  let metroRepeatId = null;      // Transport.scheduleRepeat handle

  function ensureTone() {
    if (tone) return tone;
    if (typeof root.Tone !== 'undefined') {
      tone = root.Tone;
      return tone;
    }
    return null;
  }

  // Lazy AudioContext + synth construction. On modern browsers,
  // AudioContext is 'suspended' until a user gesture — we call Tone.start()
  // but don't gate on its result: Transport and trigger calls work even
  // when the context is in 'suspended' state; the browser unblocks audio
  // on the next user gesture automatically.
  let masterGain = null;     // explicit master Gain (we control volume)
  function init() {
    const T = ensureTone();
    if (!T) return false;
    if (!initialized) {
      try {
        // Ensure Tone's destination/master is unmuted. Tone 15's
        // Destination wraps an internal Master Gain that defaults
        // to mute=false, but a previous init or browser quirk can
        // flip it. Forcing mute=false guarantees the synth's signal
        // actually reaches the speakers.
        try {
          const dest = T.getDestination();
          if (dest && typeof dest.mute === 'boolean') dest.mute = false;
          if (dest && typeof dest.volume !== 'undefined') dest.volume.value = 0;
        } catch (e) {}

        // Build an explicit master Gain that we control. We route the
        // synth + metronome voices through it, and then to destination.
        // This gives us a single point of volume control and avoids
        // any subtle issues with Tone's Destination muting.
        masterGain = new T.Gain(1.0).toDestination();

        // Build the synth. connect through masterGain.
        synth = new T.MonoSynth(SYNTH_OPTS);
        synth.volume.value = 0;
        synth.connect(masterGain);

        // Metronome: two cheap membrane voices.
        metroDown = new T.MembraneSynth({
          pitchDecay: 0.01,
          octaves: 2,
          envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 }
        });
        metroDown.volume.value = METRO_DOWN_VOL;
        metroDown.connect(masterGain);

        metroUp = new T.MembraneSynth({
          pitchDecay: 0.01,
          octaves: 2,
          envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 }
        });
        metroUp.volume.value = METRO_BEAT_VOL;
        metroUp.connect(masterGain);

        initialized = true;
      } catch (e) {
        console.error('playback-engine init failed:', e);
        return false;
      }
    }

    // Kick the AudioContext if needed (fire-and-forget; Tone.start returns
    // a promise that resolves on user gesture).
    try {
      if (T.getContext().state !== 'running') {
        const p = T.start();
        if (p && typeof p.catch === 'function') p.catch(function(){});
      }
    } catch (e) {}

    return initialized;
  }

  // Stop any scheduled transport events + silence the synth.
  // v22: don't stop the Transport if the standalone metronome is
  // running — scheduleRepeat is driven by the Transport, so stopping
  // it would also kill the standalone. Only halt the Transport when
  // there's nothing left to drive.
  function clearScheduled() {
    if (!tone) return;
    try {
      for (const id of scheduledIds) tone.Transport.clear(id);
    } catch (e) {}
    scheduledIds = [];
    try { synth.triggerRelease(); } catch (e) {}
    try { if (metronomeOn) tone.Transport.cancel(0); } catch (e) {}
  }

  // Replace the active schedule. Stops any current playback first.
  function setNotes(newNotes, newBpm) {
    if (Array.isArray(newNotes)) notes = newNotes.slice();
    if (typeof newBpm === 'number' && isFinite(newBpm) && newBpm > 0) {
      bpm = newBpm;
      if (initialized && tone) {
        try { tone.Transport.bpm.value = bpm; } catch (e) {}
      }
    }
    clearScheduled();
  }

  // Compute total beats across the note array.
  function totalBeatsOf(arr) {
    let max = 0;
    for (const n of arr) {
      const end = n.beat + (typeof n.duration === 'number' ? n.duration : 0);
      if (end > max) max = end;
    }
    return max;
  }

  // Fire a callback at audio-thread time using Tone.Draw (frame-accurate).
  function scheduleVisualCallback(time, fn) {
    if (!tone) return;
    const id = tone.Transport.scheduleOnce((t) => {
      try { tone.Draw.schedule(fn, t); } catch (e) { try { fn(); } catch (_) {} }
    }, time);
    scheduledIds.push(id);
    return id;
  }

  // Start playback from the beginning. Returns true if armed.
  function play(opts) {
    opts = opts || {};
    onNoteCb = typeof opts.onNote === 'function' ? opts.onNote : null;
    onBeatCb = typeof opts.onBeat === 'function' ? opts.onBeat : null;
    onEndCb  = typeof opts.onEnd  === 'function' ? opts.onEnd  : null;

    if (!init()) return false;
    const T = tone;
    if (!T) return false;

    // Establish tempo on the Transport.
    try { T.Transport.bpm.value = bpm; } catch (e) {}

    // Stop any in-progress playback first.
    clearScheduled();

    // Note schedule: every note fires as a raw oscillator at its
    // AudioContext timestamp. We use the Tone.Transport for sample-
    // accurate scheduling (it computes the precise ctx time `t` for
    // each callback). The actual signal is generated by scheduleNoteRaw
    // to bypass MonoSynth's ADSR/filter shape that rendered ex 1+
    // inaudible on built-in Mac speakers.
    var rawCtx = T.getContext().rawContext;
    // v23: enforce monophony. The original Tone.MonoSynth did this
    // automatically via note-stealing; v20's raw-oscillator rewrite
    // removed that safety, so when two notes share a beat (chord tones,
    // overlapping exercises in a stitched etude, accidental
    // fractional rounding) every one of them plays simultaneously —
    // producing stacked-tone "harmonies" that aren't in the score's
    // intent. We track which beat positions we've already scheduled
    // and skip duplicates. Tolerance of 0.01 beats handles
    // floating-point drift in triplet arithmetic.
    const scheduledBeats = new Set();
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      const beatKey = note.beat.toFixed(4);
      if (scheduledBeats.has(beatKey)) continue;  // monophony: skip duplicate
      scheduledBeats.add(beatKey);
      // Capture callbacks in locals for closure stability (cancelled by
      // Stop which nulls the module-level refs).
      const onNote = onNoteCb;
      const midi = note.midi;
      // Compute the note's duration in seconds. note.duration is in
      // beats; multiply by (60 / bpm) to get seconds.
      const durSec = Math.max(0.05, note.duration * 60 / bpm);
      // CRITICAL: const/let give each iteration its OWN binding of
      // note/midi/durSec. v20's `var` made them function-scoped, so
      // every scheduled callback read the LAST note's values — the
      // entire exercise played as a single repeated D4 tone. v21 fix.
      const id = T.Transport.scheduleOnce(function(t){
        scheduleNoteRaw(rawCtx, midi, t, durSec, false);
        if (onNote) {
          try { T.Draw.schedule(function(){ onNote(note); }, t); } catch (e) {}
        }
      }, formatBeatTime(note.beat));
      scheduledIds.push(id);
      // Keep a reference so Stop() can halt it cleanly.
      // scheduleNoteRaw returns an osc/gain pair; capture it inside
      // the closure once the callback fires.
    }

    // Metronome (optional): one click per beat across the score, locked
    // to transport time so it stays in sync even after tempo changes.
    // v22: respects metroConfig.timeSig (downbeat detection) and
    // metroConfig.subdivision (extra clicks per beat). Each scheduled
    // callback is one click; the onBeat payload tells the UI which
    // beat/subdivision just fired so the visual flash can match.
    if (metronomeOn) {
      const totalBeats = Math.ceil(totalBeatsOf(notes));
      const timeSig = metroConfig.timeSig || '4/4';
      const subdivision = metroConfig.subdivision || 'off';
      // For each BEAT, schedule (1 + Nsub) clicks: one downbeat/offbeat
      // at the beat, then Nsub subdivisions spread evenly inside the
      // beat. With 'off' this is just the one click per beat.
      const subSteps = subdivision === 'off' ? [0]
        : subdivision === '8ths'  ? [0, 0.5]
        : subdivision === 'triplets' ? [0, 1/3, 2/3]
        : subdivision === '16ths' ? [0, 0.25, 0.5, 0.75]
        : [0];
      for (let b = 0; b < totalBeats; b++) {
        const isBeatDown = isDownbeat(b, timeSig);
        for (let s = 0; s < subSteps.length; s++) {
          const subOffset = subSteps[s];          // 0..0.75 of a beat
          const isSubdivision = (s > 0);
          // timeStr: beat b + subOffset (in beats)
          const beatTime = b + subOffset;
          const isDown = isBeatDown && !isSubdivision;
          const onBeat = onBeatCb;
          const hz = isDown ? METRO_DOWN_HZ
            : isSubdivision ? METRO_SUB_HZ
            : METRO_BEAT_HZ;
          const id = T.Transport.scheduleOnce(function(t){
            scheduleNoteRaw(rawCtx, 60, t, METRO_DUR, true);
            if (onBeat) {
              try { T.Draw.schedule(function(){
                onBeat({ beat: b, sub: s, isDown, isSubdivision, beatTime });
              }, t); } catch (e) {}
            }
          }, formatBeatTime(beatTime));
          scheduledIds.push(id);
        }
      }
    }

    // onEnd after the last note tails out.
    const totalBeatsForEnd = totalBeatsOf(notes);
    const totalSecs = (totalBeatsForEnd * 60) / bpm + 0.2;
    const endId = T.Transport.scheduleOnce(() => {
      if (onEndCb) {
        try { onEndCb(); } catch (e) {}
      }
    }, `+${totalSecs}`);
    scheduledIds.push(endId);

    // Start the transport now (if already started, schedule from current).
    try { T.Transport.start('+0.05'); } catch (e) {}

    return true;
  }

  // Halt + cancel scheduled events.
  // v22: if the standalone metronome is running, DON'T call
  // Transport.stop() — that would also halt scheduleRepeat and kill
  // the click track. Just clear the exercise's scheduled events and
  // release the synth; the Transport keeps ticking for the standalone.
  function stop() {
    clearScheduled();
    if (tone && metroRepeatId == null) {
      try { tone.Transport.stop(); } catch (e) {}
    }
    onNoteCb = null;
    onBeatCb = null;
    onEndCb = null;
  }

  // Adjust tempo on the fly. Transport.bpm.value re-anchors at the
  // current transport position, so progress isn't lost.
  function setTempo(newBpm) {
    if (typeof newBpm !== 'number' || !isFinite(newBpm) || newBpm <= 0) return;
    bpm = newBpm;
    if (initialized && tone) {
      try { tone.Transport.bpm.value = bpm; } catch (e) {}
    }
  }

  // Toggle metronome. We don't pre-schedule here; play() handles it.
  function setMetronome(on) {
    metronomeOn = !!on;
  }

  // Configure metronome options (time signature, subdivision). v22.
  // Takes effect on the next play() (in-exercise) or the next
  // startMetronome() (standalone). Hot-swapping during playback is
  // supported for the in-exercise case only because play() pre-schedules
  // its clicks; standalone always re-arms on config change.
  function setMetroConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (typeof cfg.timeSig === 'string' && cfg.timeSig in TIME_SIG_BEATS) {
      metroConfig.timeSig = cfg.timeSig;
    }
    if (typeof cfg.subdivision === 'string' && cfg.subdivision in SUBDIV_TO_INTERVAL) {
      metroConfig.subdivision = cfg.subdivision;
    }
  }

  // Standalone metronome: free-running click track independent of any
  // exercise. v22. Uses Tone.Transport.scheduleRepeat so the engine
  // keeps accurate timing even across BPM changes. Returns true on
  // success, false if Tone isn't ready.
  //
  // opts: { bpm, timeSig, subdivision, volume (0..1), onBeat }
  //   bpm: 40..240, default 100
  //   timeSig: '4/4' | '3/4' | '6/8' | '2/4', default '4/4'
  //   subdivision: 'off' | '8ths' | 'triplets' | '16ths', default 'off'
  //   volume: 0..1 linear, default 0.5
  //   onBeat: function({ beat, sub, isDown, isSubdivision, beatTime })
  function startMetronome(opts) {
    opts = opts || {};
    if (!init()) return false;
    const T = tone;
    if (!T) return false;
    // Stop any current standalone or exercise playback first
    stopMetronome();
    stop();

    const bpmTarget = (typeof opts.bpm === 'number' && isFinite(opts.bpm) && opts.bpm > 0)
      ? Math.max(40, Math.min(240, opts.bpm))
      : 100;
    const timeSig = (typeof opts.timeSig === 'string' && opts.timeSig in TIME_SIG_BEATS)
      ? opts.timeSig : '4/4';
    const subdivision = (typeof opts.subdivision === 'string' && opts.subdivision in SUBDIV_TO_INTERVAL)
      ? opts.subdivision : 'off';
    metroConfig = { timeSig, subdivision };
    const vol = (typeof opts.volume === 'number' && isFinite(opts.volume))
      ? Math.max(0, Math.min(1, opts.volume)) : 0.5;
    const onBeat = typeof opts.onBeat === 'function' ? opts.onBeat : null;

    try { T.Transport.bpm.value = bpmTarget; } catch (e) {}

    // Counter for onBeat — increments per subdivision tick, not per bar.
    let counter = 0;
    const rawCtx = T.getContext().rawContext;
    const interval = SUBDIV_TO_INTERVAL[subdivision] || '4n';
    const VOL_DOWN = 0.4 * vol;
    const VOL_BEAT = 0.28 * vol;
    const VOL_SUB  = 0.22 * vol;

    try {
      metroRepeatId = T.Transport.scheduleRepeat(function(time){
        const b = Math.floor(counter);
        const s = 0; // scheduleRepeat only fires on the chosen interval,
                     // so each tick IS a "subdivision 0" of the next counter
                     // value. The sub index is implicit: s=0 always.
        // We track beats via the counter relative to subdivision density.
        // To know if THIS tick is a downbeat, we look at the beat it
        // belongs to. With 'off' the counter increments 1 per beat, so
        // b=counter. With 8ths, counter increments 2 per beat. With
        // triplets, 3 per beat. With 16ths, 4 per beat.
        const subPerBeat = subdivision === 'off' ? 1
          : subdivision === '8ths' ? 2
          : subdivision === 'triplets' ? 3
          : 4;
        const isDown = isDownbeat(b, timeSig) && (s === 0);
        const isSubdivision = false; // scheduleRepeat always lands on the
                                     // beat or subdivision — but from the
                                     // caller's perspective each tick is
                                     // the metric pulse, with isDown
                                     // already encoding the sub-state
        const hz = isDown ? METRO_DOWN_HZ : METRO_BEAT_HZ;
        const peak = isDown ? VOL_DOWN : VOL_BEAT;
        // Use scheduleNoteRaw with isClick=true, but with our own vol.
        // The simplest: emit a click directly with peak amplitude.
        try {
          var osc = rawCtx.createOscillator();
          var gain = rawCtx.createGain();
          osc.type = 'square';
          osc.frequency.value = hz;
          gain.gain.setValueAtTime(peak, time);
          gain.gain.exponentialRampToValueAtTime(0.001, time + METRO_DUR);
          osc.connect(gain);
          gain.connect(rawCtx.destination);
          osc.start(time);
          osc.stop(time + METRO_DUR + 0.02);
        } catch (e) {}
        if (onBeat) {
          try { T.Draw.schedule(function(){
            onBeat({ beat: b, sub: s, isDown, isSubdivision, beatTime: b });
          }, time); } catch (e) {}
        }
        counter++;
      }, interval);
    } catch (e) { return false; }

    try { T.Transport.start('+0.05'); } catch (e) {}
    return true;
  }

  function stopMetronome() {
    if (tone && metroRepeatId != null) {
      try { tone.Transport.clear(metroRepeatId); } catch (e) {}
    }
    metroRepeatId = null;
  }

  function isMetronomeRunning() {
    return metroRepeatId != null;
  }

  // Tear down.
  function dispose() {
    stop();
    try { synth && synth.dispose(); } catch (e) {}
    try { metroDown && metroDown.dispose(); } catch (e) {}
    try { metroUp && metroUp.dispose(); } catch (e) {}
    try { masterGain && masterGain.dispose(); } catch (e) {}
    synth = metroDown = metroUp = masterGain = null;
    initialized = false;
  }

  // ----- helpers -----
  // Convert a beat-position (relative to start) to a Tone.Transport time
  // string. `barsBeatsSixteenths` style: use "0:0:X" form (X = 16th notes).
  // 4/4 assumed.
  function formatBeatTime(beat) {
    const bar  = Math.floor(beat / 4);
    const beatInBar = Math.floor(beat % 4);
    const sixteenth = (beat - Math.floor(beat)) * 4;
    // Tone.Transport accepts "0:0:0" (bar:beat:sixteenth)
    return `${bar}:${beatInBar}:${Math.round(sixteenth)}`;
  }

  // Convert a beat-duration to a Tone.Duration string ("4n", "8n", etc.)
  // approximate, or fall back to seconds.
  function formatBeatDuration(beats) {
    if (!isFinite(beats) || beats <= 0) return '16n';
    // Map to the nearest power-of-two note value.
    if (beats >= 4)    return '1m';
    if (beats >= 2)    return '2n';
    if (beats >= 1)    return '4n';
    if (beats >= 0.5)  return '8n';
    if (beats >= 0.25) return '16n';
    if (beats >= 0.125) return '32n';
    return '64n';
  }

  // Schedule a single note's audio directly via raw Web Audio, bypassing
  // MonoSynth's ADSR + filter envelope (which shaped the signal down
  // to inaudibility on built-in Mac speakers). Returns the scheduled
  // osc/gain pair so the caller can stop it early on Stop.
  //
  // ctx: AudioContext (raw Web Audio, not Tone)
  // midi: MIDI note number
  // startAt: AudioContext time (seconds) when the note should begin
  // durationSec: how long the note should ring, in seconds
  // isClick: if true, this is a metronome click (uses square + envelope
  //          so the beep has a transient "tick" feel); otherwise a
  //          sustained note (uses sine).
  function scheduleNoteRaw(ctx, midi, startAt, durationSec, isClick) {
    var hz = 440 * Math.pow(2, (midi - 69) / 12);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    if (isClick) {
      // Metronome click: square wave with a fast exponential decay —
      // a "tick" feel. Peak at 0.4, decays to 0.001 over the click duration.
      osc.type = 'square';
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.4, startAt);
      gain.gain.exponentialRampToValueAtTime(0.001, startAt + durationSec);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + durationSec + 0.02);
    } else {
      // Exercise note: triangle wave (v22 polish — was sine), no ADSR.
      // Triangle has a touch of odd harmonics that gives the note a
      // warm, sax-like presence on built-in speakers. The body holds
      // at NOTE_GAIN_AMP with a NOTE_RAMP_SEC ramp at the boundaries
      // to suppress clicks.
      osc.type = 'triangle';
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(NOTE_GAIN_AMP, startAt + NOTE_RAMP_SEC);
      gain.gain.setValueAtTime(NOTE_GAIN_AMP, startAt + Math.max(durationSec, NOTE_RAMP_SEC * 2));
      gain.gain.linearRampToValueAtTime(0, startAt + durationSec + NOTE_RAMP_SEC);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + durationSec + NOTE_RAMP_SEC + 0.05);
    }
    return { osc: osc, gain: gain };
  }

  // Diagnostic: continuous test tone. Fires a raw OscillatorNode
  // (bypassing the synth envelope) at 400Hz through masterGain. The
  // signal stays at full amplitude for 4 seconds with no envelope
  // shaping — there's literally no way for this to under-deliver
  // because we eliminate the ADSR, the filter envelope, and the
  // MonoSynth's voice-stealing semantics.
  //
  // If you hear THIS, the audio path is intact: engine → masterGain →
  // Destination → speakers. If you don't, the issue is macOS audio
  // output (system volume, output device, Bluetooth disconnect).
  //
  // Returns an object with status info:
  //   { ok: boolean, message: string, context: AudioContextState, reason: string }
  function testSound() {
    var result = { ok: false, message: '', context: 'unknown', reason: '' };
    if (!synth) {
      if (!init()) {
        result.reason = 'init failed (Tone.js not loaded?)';
        return result;
      }
    }
    var T = tone;
    if (!T) {
      result.reason = 'Tone.js unavailable';
      return result;
    }
    result.context = T.getContext().state;

    // Synchronously kick Tone.start() and chain the trigger into its
    // .then() callback. This means the trigger fires only AFTER the
    // AudioContext is unlocked — which is the whole point of the
    // user gesture that initiated this call.
    var startPromise = (result.context === 'suspended')
      ? T.start()
      : null;
    var fireNow = function(){
      // Use a fresh OscillatorNode + GainNode pair, not the
      // MonoSynth's envelope-shaped voice. Bypasses the filter and
      // ADSR — what you hear is a flat 400Hz sine tone for 4 seconds.
      try {
        var ctx = T.getContext().rawContext;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 400;
        gain.gain.value = 0.15;  // -16 dBFS, gentle but clearly audible
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 4);
        result.ok = true;
        result.context = 'running';
        result.message = '4s 400Hz tone fired via raw oscillator (audio running)';
      } catch (e) {
        result.reason = 'raw oscillator failed: ' + (e && e.message);
      }
    };
    if (startPromise && typeof startPromise.then === 'function') {
      startPromise.then(function(){
        result.context = T.getContext().state;
        fireNow();
      }).catch(function(){
        result.context = T.getContext().state;
        result.reason = 'Tone.start() rejected — click the page first to allow audio';
      });
      // Even if we haven't fired yet, this is success in the sense that
      // we accepted the click and queued audio. The user gesture unlocks
      // the context, which triggers the tone.
      result.ok = true;
      result.message = '4s 400Hz tone armed (will fire when audio unlocks)';
      return result;
    }
    // Already running — fire immediately.
    fireNow();
    return result;
  }

  // Expose the public API.
  root.playbackEngine = {
    init: init,
    setNotes: setNotes,
    play: play,
    stop: stop,
    setTempo: setTempo,
    setMetronome: setMetronome,
    setMetroConfig: setMetroConfig,
    startMetronome: startMetronome,
    stopMetronome: stopMetronome,
    isMetronomeRunning: isMetronomeRunning,
    dispose: dispose,
    // Diagnostic
    testSound: testSound,
    // diagnostic surface
    _isMono: true,
    _engine: 'tone.js',
  };

})(window);
