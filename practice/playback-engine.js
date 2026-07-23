/* Web Audio MIDI playback engine for the Practice page.
 *
 * Plays back an array of notes ({midi, beat, duration}) at the given bpm
 * using a triangle-wave synth with an ADSR envelope. Optional metronome
 * click on every beat (downbeat accented). Reusable across exercises —
 * call init() once on first user gesture, then setNotes() + play() each
 * time.
 *
 * Public API on window.playbackEngine:
 *   init(), setNotes(notes, bpm), play({onNote, onBeat, onEnd}),
 *   stop(), setTempo(bpm), setMetronome(on), dispose()
 *
 * Visual sync callbacks (onNote, onBeat, onEnd) are driven by setTimeout
 * keyed off ctx.currentTime, so they line up with what you actually hear
 * even on a slow start.
 */
(function (root) {
  'use strict';

  // ADSR envelope (seconds). Triangle wave is a gentle, vaguely sax-like
  // timbre that won't fight the practice room. Master gain is capped at
  // 0.18 — Web Audio feedback loops at higher gain are painfully harsh.
  const ATTACK = 0.01;
  const DECAY = 0.08;
  const SUSTAIN = 0.55; // fraction of peak
  const RELEASE = 0.12;
  const MASTER_GAIN = 0.18;
  const LEAD_IN = 0.05; // schedule events 50ms in the future for clean alignment

  // Metronome: 1600Hz downbeat (accent), 1000Hz on every other beat.
  const METRO_DOWN_HZ = 1600;
  const METRO_DOWN_VOL = 0.10;
  const METRO_BEAT_HZ = 1000;
  const METRO_BEAT_VOL = 0.05;
  const METRO_DUR = 0.05;

  // Minimum audible note length. Anything below 20ms gets clamped so the
  // envelope has time to open without an audible click.
  const MIN_DUR = 0.02;

  // ===== Engine state =====
  let ctx = null;            // AudioContext
  let masterGain = null;     // master GainNode (so we can mute everything fast)
  let notes = [];            // currently scheduled note array
  let bpm = 120;             // current tempo
  let metronomeOn = false;
  let scheduled = [];        // tracked items for cancel-on-stop
  let startTime = 0;         // ctx.currentTime when playback started
  let onNoteCb = null;
  let onBeatCb = null;
  let onEndCb = null;
  let playing = false;

  // Webkit alias for older Safari.
  function getCtor() {
    return root.AudioContext || root.webkitAudioContext || null;
  }

  // Lazily create the AudioContext. On modern browsers the context may be
  // in 'suspended' state until a user gesture (autoplay policy). Returns
  // false if we couldn't open a usable context — caller should retry on
  // the next user click.
  function init() {
    if (ctx) {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        ctx.resume();
      }
      return ctx.state === 'running';
    }
    const Ctor = getCtor();
    if (!Ctor) return false;
    try {
      ctx = new Ctor();
    } catch (e) {
      ctx = null;
      return false;
    }
    masterGain = ctx.createGain();
    masterGain.gain.value = MASTER_GAIN;
    masterGain.connect(ctx.destination);
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume();
    }
    return ctx.state === 'running';
  }

  // MIDI number → frequency (A4 = 69 = 440 Hz).
  function midiToFreq(n) {
    return 440 * Math.pow(2, (n - 69) / 12);
  }

  // Schedule a single note: triangle osc → gain envelope → master.
  // Returns the scheduled object so we can stop it on stop()/dispose().
  function scheduleNote(note, beatToTime) {
    const startBeat = beatToTime(note.beat);
    const dur = Math.max(MIN_DUR, note.duration * 60 / bpm);
    const startAbs = startTime + startBeat;
    const peakAt = startAbs + ATTACK;
    const sustainAt = peakAt + DECAY;
    const releaseAt = startAbs + dur;
    const endAt = releaseAt + RELEASE;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = midiToFreq(note.midi);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, startAbs);
    gain.gain.linearRampToValueAtTime(1, peakAt);
    gain.gain.linearRampToValueAtTime(SUSTAIN, sustainAt);
    gain.gain.setValueAtTime(SUSTAIN, releaseAt);
    gain.gain.linearRampToValueAtTime(0, endAt);

    osc.connect(gain);
    gain.connect(masterGain);

    osc.start(startAbs);
    osc.stop(endAt);

    // Visual callback at note attack.
    const cbId = _scheduleCallback(startAbs, function () {
      if (onNoteCb) {
        try { onNoteCb(note); } catch (e) { /* swallow user-side errors */ }
      }
    });

    return {
      type: 'note',
      osc: osc,
      gain: gain,
      endTime: endAt,
      callbackId: cbId,
    };
  }

  // Schedule a metronome click at the given beat index.
  function scheduleClick(beatIndex, beatToTime) {
    const startAbs = startTime + beatToTime(beatIndex);
    const isDown = beatIndex % 4 === 0;
    const hz = isDown ? METRO_DOWN_HZ : METRO_BEAT_HZ;
    const vol = isDown ? METRO_DOWN_VOL : METRO_BEAT_VOL;
    const endAbs = startAbs + METRO_DUR;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = hz;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, startAbs);
    gain.gain.linearRampToValueAtTime(vol, startAbs + 0.002);
    gain.gain.setValueAtTime(vol, endAbs - 0.01);
    gain.gain.linearRampToValueAtTime(0, endAbs);

    osc.connect(gain);
    gain.connect(masterGain);

    osc.start(startAbs);
    osc.stop(endAbs);

    // Visual callback exactly on the click.
    const cbId = _scheduleCallback(startAbs, function () {
      if (onBeatCb) {
        try { onBeatCb(beatIndex); } catch (e) { /* swallow */ }
      }
    });

    return {
      type: 'click',
      osc: osc,
      gain: gain,
      endTime: endAbs,
      callbackId: cbId,
    };
  }

  // Map a beat (relative to start of exercise) to seconds offset from
  // startTime. Hooks here keep beat layout in one place.
  function beatToTime(beat) {
    return beat * 60 / bpm;
  }

  // Schedule a setTimeout-driven callback for visual sync. We could lean
  // on AudioWorklet/lookahead for sub-frame precision, but a 10-20ms
  // jitter on the visual highlight isn't a problem for this app.
  function _scheduleCallback(time, fn) {
    const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    return setTimeout(fn, delayMs);
  }

  // Cancel every oscillator + callback we've scheduled. Safe to call
  // when nothing is scheduled.
  function clearScheduled() {
    for (let i = 0; i < scheduled.length; i++) {
      const item = scheduled[i];
      if (item.type === 'callback') {
        clearTimeout(item.id);
      } else {
        // osc / click
        try { item.osc.stop(0); } catch (e) { /* already stopped */ }
      }
    }
    scheduled = [];
  }

  // Compute total beats across the note array (max of beat + duration).
  function totalBeatsOf(arr) {
    let max = 0;
    for (let i = 0; i < arr.length; i++) {
      const end = arr[i].beat + arr[i].duration;
      if (end > max) max = end;
    }
    return max;
  }

  // Walk the schedule from a starting offset (in beats). Used both for
  // full play and for tempo re-anchoring.
  function scheduleFromOffset(offsetBeats) {
    startTime = ctx.currentTime + LEAD_IN;

    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.beat + n.duration <= offsetBeats) continue; // already past
      const shiftedNote = {
        midi: n.midi,
        beat: n.beat - offsetBeats,
        duration: n.duration,
      };
      const item = scheduleNote(shiftedNote, beatToTime);
      scheduled.push(item);
    }

    if (metronomeOn) {
      // Emit one click per beat position occupied by the score. A click
      // at beat b covers the time window [b, b+1) beats; we only want
      // windows that overlap the score, so the inclusive upper bound is
      // (b+1) <= totalBeats, i.e. b < totalBeats.
      const totalBeats = totalBeatsOf(notes);
      const startBeatInt = Math.floor(offsetBeats);
      for (let b = startBeatInt; b < totalBeats; b++) {
        const item = scheduleClick(b, beatToTime);
        scheduled.push(item);
      }
    }

    const totalBeats = totalBeatsOf(notes);
    const endOffset = (totalBeats - offsetBeats) * 60 / bpm + 0.2;
    const endId = _scheduleCallback(startTime + endOffset, function () {
      playing = false;
      if (onEndCb) {
        try { onEndCb(); } catch (e) { /* swallow */ }
      }
    });
    scheduled.push({ type: 'callback', id: endId });
  }

  // Replace the active schedule. Stops any current playback first.
  function setNotes(newNotes, newBpm) {
    if (newNotes) notes = newNotes.slice();
    if (typeof newBpm === 'number' && isFinite(newBpm) && newBpm > 0) {
      bpm = newBpm;
    }
    if (playing) {
      clearScheduled();
      playing = false;
    }
  }

  // Start playback from the beginning. Returns true if the engine is
  // ready and playback was armed. onNote/onBeat/onEnd are optional
  // visual-sync callbacks.
  function play(opts) {
    opts = opts || {};
    if (!ctx) {
      const ok = init();
      if (!ok) return false;
    }
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume();
    }
    if (playing) {
      // Already mid-playback — restart from top.
      clearScheduled();
    }
    onNoteCb = typeof opts.onNote === 'function' ? opts.onNote : null;
    onBeatCb = typeof opts.onBeat === 'function' ? opts.onBeat : null;
    onEndCb = typeof opts.onEnd === 'function' ? opts.onEnd : null;

    playing = true;
    scheduleFromOffset(0);
    return true;
  }

  // Halt + cancel scheduled events.
  function stop() {
    clearScheduled();
    playing = false;
    onNoteCb = null;
    onBeatCb = null;
    onEndCb = null;
  }

  // Adjust tempo on the fly. If we're currently playing, re-anchor at
  // the right beat without losing audible progress.
  function setTempo(newBpm) {
    if (typeof newBpm !== 'number' || !isFinite(newBpm) || newBpm <= 0) return;
    const wasPlaying = playing;
    const oldBpm = bpm;
    bpm = newBpm;
    if (!wasPlaying || !ctx) return;
    const elapsed = ctx.currentTime - startTime;
    const elapsedBeats = elapsed * (oldBpm / 60);
    // Drain, then re-schedule from the same beat.
    const savedNoteCb = onNoteCb;
    const savedBeatCb = onBeatCb;
    const savedEndCb = onEndCb;
    clearScheduled();
    onNoteCb = savedNoteCb;
    onBeatCb = savedBeatCb;
    onEndCb = savedEndCb;
    scheduleFromOffset(Math.max(0, elapsedBeats));
  }

  // Toggle the metronome. Takes effect on the next play() — if we want
  // it live during playback we'd need to re-anchor, but toggling while
  // a song is running is rare enough to defer.
  function setMetronome(on) {
    metronomeOn = !!on;
  }

  // Tear down: cancel everything, close the context.
  function dispose() {
    clearScheduled();
    if (ctx && typeof ctx.close === 'function') {
      try { ctx.close(); } catch (e) { /* already closed */ }
    }
    ctx = null;
    masterGain = null;
    notes = [];
    playing = false;
    onNoteCb = null;
    onBeatCb = null;
    onEndCb = null;
  }

  // Public surface.
  root.playbackEngine = {
    init: init,
    setNotes: setNotes,
    play: play,
    stop: stop,
    setTempo: setTempo,
    setMetronome: setMetronome,
    dispose: dispose,
  };
})(window);
