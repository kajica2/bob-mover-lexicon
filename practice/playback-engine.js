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

    // Note schedule: every note is a trigger at its beat-time.
    for (const note of notes) {
      const timeStr = formatBeatTime(note.beat);
      // MonoSynth.triggerAttackRelease handles monophony automatically
      // (the synth triggers a release on the prior voice before the new
      // attack, so two notes never overlap).
      const durStr = formatBeatDuration(note.duration);
      const id = T.Transport.scheduleOnce((t) => {
        const hz = T.Frequency(note.midi, 'midi').toFrequency();
        try { synth.triggerAttackRelease(durStr, t, hz); } catch (e) {}
        if (onNoteCb) {
          try { T.Draw.schedule(() => onNoteCb(note), t); } catch (e) { try { onNoteCb(note); } catch (_) {} }
        }
      }, timeStr);
      scheduledIds.push(id);
    }

    // Metronome (optional): one click per beat across the score, locked
    // to transport time so it stays in sync even after tempo changes.
    if (metronomeOn) {
      const totalBeats = Math.ceil(totalBeatsOf(notes));
      for (let b = 0; b < totalBeats; b++) {
        const isDown = (b % 4) === 0;
        const timeStr = formatBeatTime(b);
        const id = T.Transport.scheduleOnce((t) => {
          const hz = isDown ? METRO_DOWN_HZ : METRO_BEAT_HZ;
          const voice = isDown ? metroDown : metroUp;
          try { voice.triggerAttackRelease(METRO_DUR, t, hz); } catch (e) {}
          if (onBeatCb) {
            try { T.Draw.schedule(() => onBeatCb(b), t); } catch (e) { try { onBeatCb(b); } catch (_) {} }
          }
        }, timeStr);
        scheduledIds.push(id);
      }
    }

    // onEnd after the last note tails out.
    const totalBeats = totalBeatsOf(notes);
    const totalSecs = (totalBeats * 60) / bpm + 0.2;
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

  // Diagnostic: continuous test tone. Holds a 400Hz triangle wave at
  // 0 dBFS for 4 seconds with a 50ms ramp on each end to avoid clicks.
  // This is the "no excuses it didn't fire" check — the longest, loudest,
  // lowest-pitch signal we can produce through Tone.MonoSynth. If you
  // don't hear THIS, the problem is macOS audio output (system volume,
  // output device, Bluetooth disconnect), not the synth path.
  //
  // Returns true if the trigger was scheduled, false if synth isn't
  // built (call init() first).
  function testSound() {
    if (!synth) {
      if (!init()) return false;
    }
    const T = tone;
    if (!T) return false;
    // Synchronously kick Tone.start() AND return the Promise itself
    // so the click handler can `await` it. If the AudioContext is
    // already 'running', Tone.start() resolves immediately and the
    // await is a no-op. If it's 'suspended' (the typical first-click
    // case), the await blocks until the user gesture unlocks audio,
    // at which point the trigger is genuinely audible.
    const startPromise = (T.getContext().state === 'suspended')
      ? T.start()
      : null;
    if (startPromise && typeof startPromise.then === 'function') {
      // Return a Promise that fires the trigger once the context unlocks.
      // The button click handler can ignore the Promise and just trust
      // that the click gesture + the pending trigger will produce sound.
      startPromise.then(function(){
        try {
          synth.triggerAttackRelease(4, T.now() + 0.05, 400);
        } catch (e) {}
      }).catch(function(){});
      return true;
    }
    // Already running — fire immediately.
    try {
      synth.triggerAttackRelease(4, T.now() + 0.05, 400);
      return true;
    } catch (e) {
      return false;
    }
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
