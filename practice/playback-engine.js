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
  const METRO_DUR      = 0.05; // seconds per click

  // Gain for note playback through the raw oscillator path. The v19
  // testSound revealed that MonoSynth's ADSR + filter envelope combo
  // shaped the signal down to inaudibility on built-in Mac speakers.
  // Plain sine/triangle oscillators at constant ~0.3 gain through
  // masterGain → Destination is unmistakably audible. NOTE_GAIN_AMP
  // sets the per-note linear gain; 0.30 = ~ -10 dBFS, well above
  // the noise floor but below digital clipping on busy runs.
  const NOTE_GAIN_AMP = 0.30;
  // Tiny ramp at attack/release to suppress clicks at note edges.
  // 0.005s = 5ms; smaller than a musician's perception but enough
  // to avoid the "click on every note" artifact.
  const NOTE_RAMP_SEC = 0.005;

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
  let scheduledIds = [];         // Tone.Transport event ids (for cancel)
  let onNoteCb    = null;
  let onBeatCb    = null;
  let onEndCb     = null;
  let initialized = false;

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
    for (var i = 0; i < notes.length; i++) {
      var note = notes[i];
      // Capture callbacks in locals for closure stability (cancelled by
      // Stop which nulls the module-level refs).
      var onNote = onNoteCb;
      var midi = note.midi;
      // Compute the note's duration in seconds. note.duration is in
      // beats; multiply by (60 / bpm) to get seconds.
      var durSec = Math.max(0.05, note.duration * 60 / bpm);
      var id = T.Transport.scheduleOnce(function(t){
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
    if (metronomeOn) {
      var totalBeats = Math.ceil(totalBeatsOf(notes));
      for (var b = 0; b < totalBeats; b++) {
        var isDown = (b % 4) === 0;
        var onBeat = onBeatCb;
        var clickHz = isDown ? METRO_DOWN_HZ : METRO_BEAT_HZ;
        var id = T.Transport.scheduleOnce(function(t){
          scheduleNoteRaw(rawCtx, 60, t, METRO_DUR, true);
          if (onBeat) {
            try { T.Draw.schedule(function(){ onBeat(b); }, t); } catch (e) {}
          }
        }, formatBeatTime(b));
        scheduledIds.push(id);
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
  function stop() {
    clearScheduled();
    if (tone) {
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
      // Exercise note: pure sine, no ADSR. A tiny ramp at the boundaries
      // prevents clicks, but the body holds at NOTE_GAIN_AMP.
      osc.type = 'sine';
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
    dispose: dispose,
    // Diagnostic
    testSound: testSound,
    // diagnostic surface
    _isMono: true,
    _engine: 'tone.js',
  };

})(window);
