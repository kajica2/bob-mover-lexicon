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
  let scheduledAudio = [];       // raw Web Audio osc/gain pairs (for stop)
  let scheduledTimers = [];      // setTimeout ids for visual callbacks + onEnd
  let onNoteCb    = null;
  let onBeatCb    = null;
  let onEndCb     = null;
  let initialized = false;
  // Loop playback. When loopOn, the engine re-arms the schedule at
  // the end of the current iteration (with a small gap so the ear
  // registers the new pass). playGeneration invalidates any pending
  // loop callback when stop() runs — without it, a setTimeout fired
  // 200ms after a Stop click would silently re-arm playback. Each
  // play() bumps the generation; stop() bumps it again; the loop
  // callback only re-arms if its captured generation still matches.
  let loopOn        = false;
  let playGeneration = 0;
  // Gap between loop iterations. 200ms is short enough to feel
  // continuous but long enough to register the start of the new
  // pass to the ear — and crucially, to give the previous note's
  // release tail time to fade out before the next attack.
  const LOOP_GAP_MS = 200;
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
  // v34: also cancel raw Web Audio nodes (scheduledAudio) and any
  // setTimeout-based visual callbacks (scheduledTimers). The previous
  // version only used Transport.clear() which left raw oscs ringing
  // and visual callbacks queued.
  function clearScheduled() {
    if (tone) {
      try {
        for (const id of scheduledIds) tone.Transport.clear(id);
      } catch (e) {}
    }
    scheduledIds = [];
    // Cancel raw Web Audio nodes scheduled for the future (or stop
    // them immediately if they've already started).
    for (let i = 0; i < scheduledAudio.length; i++) {
      const pair = scheduledAudio[i];
      try {
        if (pair && pair.osc) {
          try { pair.osc.stop(); } catch (e) {}
          try { pair.osc.disconnect(); } catch (e) {}
        }
        if (pair && pair.gain) {
          try { pair.gain.disconnect(); } catch (e) {}
        }
      } catch (e) {}
    }
    scheduledAudio = [];
    // Cancel any pending setTimeout-based visual callbacks + onEnd.
    for (let i = 0; i < scheduledTimers.length; i++) {
      try { clearTimeout(scheduledTimers[i]); } catch (e) {}
    }
    scheduledTimers = [];
    try { synth.triggerRelease(); } catch (e) {}
    try { if (metronomeOn && tone) tone.Transport.cancel(0); } catch (e) {}
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
  //
  // v34: rewrote scheduling to bypass Tone.Transport for note +
  // metronome scheduling. The previous code passed absolute audio
  // times (rawContext.currentTime + offset) to Transport.scheduleOnce,
  // but Transport interprets that argument as Transport-relative time
  // and adds its own start delay (~50ms) + lookAhead window (~100ms)
  // before firing. The result: every note landed ~250ms LATER than
  // it should have, and the first note after a Play click had a
  // ~300ms perceived delay before sounding. By calling
  // osc.start(audioTime) directly on the raw AudioContext we get
  // sample-accurate scheduling with no Transport overhead.
  //
  // Visual callbacks (note highlights, beat flashes, onEnd) go
  // through a setTimeout scheduled to fire at the right wall-clock
  // time. setTimeout can be cancelled via clearTimeout in stop(),
  // which is the cancellation mechanism the previous code lacked
  // for non-Transport callbacks. A generation counter inside each
  // setTimeout closure double-checks the playback is still active
  // before running the callback, in case a stale timer slips through
  // after stop().
  //
  // Transport is still used for:
  //   - The standalone metronome (Transport.scheduleRepeat) which
  //     needs a tempo-driven repeating interval that raw Web Audio
  //     would be awkward to reimplement.
  //   - Storing the BPM (Transport.bpm.value is the source of
  //     truth for the standalone's interval).
  function play(opts) {
    opts = opts || {};
    onNoteCb = typeof opts.onNote === 'function' ? opts.onNote : null;
    onBeatCb = typeof opts.onBeat === 'function' ? opts.onBeat : null;
    onEndCb  = typeof opts.onEnd  === 'function' ? opts.onEnd  : null;

    if (!init()) return false;
    const T = tone;
    if (!T) return false;

    // Bump the generation so any previously-pending loop callback
    // (from a prior play() that was looped) sees the mismatch and
    // does not re-arm. Captured in a local for the loop check below.
    playGeneration++;
    const myGen = playGeneration;

    // Establish tempo on the Transport (still used by the standalone
    // metronome).
    try { T.Transport.bpm.value = bpm; } catch (e) {}

    // Stop any in-progress playback first. This cancels pending
    // raw-Audio oscs + visual setTimeouts from the previous pass.
    clearScheduled();

    // Compute audioStart: a small lead-in so the first note's
    // scheduled time is comfortably in the future, giving the
    // browser time to actually fire the osc. 50ms is enough head
    // room on every browser we've seen and keeps the perceived
    // click-to-sound delay at roughly 50ms (vs the previous
    // ~300ms with Transport).
    var rawCtx = T.getContext().rawContext;
    var audioStart = rawCtx.currentTime + 0.05;
    var beatToSec = function (beat) { return beat * 60 / bpm; };

    // v23: enforce monophony. The original Tone.MonoSynth did this
    // automatically via note-stealing; v20's raw-oscillator rewrite
    // removed that safety, so when two notes share a beat (chord
    // tones, overlapping exercises in a stitched etude, accidental
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
      // Capture callbacks in locals for closure stability (cleared
      // by stop() which nulls the module-level refs).
      const onNote = onNoteCb;
      const midi = note.midi;
      // note.duration is in beats; convert to seconds.
      const durSec = Math.max(0.05, note.duration * 60 / bpm);
      // const/let give each iteration its OWN binding of
      // note/midi/durSec. v20's `var` made them function-scoped, so
      // every scheduled callback read the LAST note's values — the
      // entire exercise played as a single repeated D4 tone. v21 fix.
      const tAt = audioStart + beatToSec(note.beat);
      // Schedule the note directly on the raw AudioContext.
      // scheduleNoteRaw returns the osc/gain pair so we can stop it
      // mid-playback if the user clicks Stop before the note fires.
      const pair = scheduleNoteRaw(rawCtx, midi, tAt, durSec, false);
      scheduledAudio.push(pair);
      // Schedule the visual highlight via setTimeout, using the
      // delay in ms from now. The generation check skips stale
      // timers after stop().
      const delayMs = Math.max(0, (tAt - rawCtx.currentTime) * 1000);
      const visualTimer = setTimeout(function () {
        if (myGen !== playGeneration) return;
        if (onNote) {
          try { onNote(note); } catch (e) {}
        }
      }, delayMs);
      scheduledTimers.push(visualTimer);
    }

    // Metronome (optional): one click per beat across the score,
    // each scheduled at a precise audio time via raw Web Audio.
    // v22: respects metroConfig.timeSig (downbeat detection) and
    // metroConfig.subdivision (extra clicks per beat). The onBeat
    // payload tells the UI which beat/subdivision just fired so the
    // visual flash can match.
    if (metronomeOn) {
      const totalBeats = Math.ceil(totalBeatsOf(notes));
      const timeSig = metroConfig.timeSig || '4/4';
      const subdivision = metroConfig.subdivision || 'off';
      const subSteps = subdivision === 'off' ? [0]
        : subdivision === '8ths'  ? [0, 0.5]
        : subdivision === 'triplets' ? [0, 1/3, 2/3]
        : subdivision === '16ths' ? [0, 0.25, 0.5, 0.75]
        : [0];
      for (let b = 0; b < totalBeats; b++) {
        const isBeatDown = isDownbeat(b, timeSig);
        for (let s = 0; s < subSteps.length; s++) {
          const subOffset = subSteps[s];
          const isSubdivision = (s > 0);
          const beatTime = b + subOffset;
          const isDown = isBeatDown && !isSubdivision;
          const onBeat = onBeatCb;
          const hz = isDown ? METRO_DOWN_HZ
            : isSubdivision ? METRO_SUB_HZ
            : METRO_BEAT_HZ;
          const tAt = audioStart + beatToSec(beatTime);
          // Schedule the click via raw Web Audio (no Transport delay).
          const pair = scheduleNoteRaw(rawCtx, 60, tAt, METRO_DUR, true);
          scheduledAudio.push(pair);
          // Visual callback via setTimeout with generation check.
          const delayMs = Math.max(0, (tAt - rawCtx.currentTime) * 1000);
          const beatTimer = setTimeout(function () {
            if (myGen !== playGeneration) return;
            if (onBeat) {
              try { onBeat({ beat: b, sub: s, isDown, isSubdivision, beatTime }); } catch (e) {}
            }
          }, delayMs);
          scheduledTimers.push(beatTimer);
        }
      }
    }

    // onEnd after the last note tails out. When loop is on, schedule
    // a recursive play() after a short gap so the next pass begins
    // cleanly. The generation check guards against re-arming after
    // the user has clicked Stop (which bumps playGeneration, making
    // myGen !== playGeneration in the closure).
    const totalBeatsForEnd = totalBeatsOf(notes);
    const totalSecs = beatToSec(totalBeatsForEnd) + 0.2;
    const endAt = audioStart + totalSecs;
    const endDelayMs = Math.max(0, (endAt - rawCtx.currentTime) * 1000);
    const endTimer = setTimeout(function () {
      if (myGen !== playGeneration) return;
      if (onEndCb) {
        try { onEndCb(); } catch (e) {}
      }
      if (loopOn && myGen === playGeneration) {
        // Re-arm after a small gap so the ear registers the new
        // pass and the previous note's release tail can fade out.
        setTimeout(function () {
          if (loopOn && myGen === playGeneration) {
            play({ onNote: onNoteCb, onBeat: onBeatCb, onEnd: onEndCb });
          }
        }, LOOP_GAP_MS);
      }
    }, endDelayMs);
    scheduledTimers.push(endTimer);

    // No Transport.start() call — raw Web Audio runs on its own
    // clock. The oscs scheduled above will fire at their tAt
    // (audioStart + offset) without needing any Transport kick.

    return true;
  }

  // Halt + cancel scheduled events.
  // v22: if the standalone metronome is running, DON'T call
  // Transport.stop() — that would also halt scheduleRepeat and kill
  // the click track. Just clear the exercise's scheduled events and
  // release the synth; the Transport keeps ticking for the standalone.
  // Bumps playGeneration so any pending loop setTimeout (the
  // setTimeout(play) in the onEnd closure) sees the mismatch and
  // skips the recursive re-arm.
  function stop() {
    playGeneration++;
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

  // Toggle loop playback. When on, the engine re-arms the schedule
  // at the end of each iteration (with a 200ms gap so the ear
  // registers the new pass). Hot-swappable: the next time the
  // current iteration ends, the new value takes effect. Safe to
  // toggle mid-iteration; the current pass plays to its natural
  // end and the loop callback checks the current value when it
  // fires.
  function setLoop(on) {
    loopOn = !!on;
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
    setLoop: setLoop,
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
