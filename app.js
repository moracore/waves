"use strict";

/* ============================================================
   Waves — additive mini-synth
   audio graph:  voices(osc→gain) → bus → compressor → analyser → out
   ============================================================ */

const NUM_HARMONICS = 10;
const GLIDE_TIME = 0.35;      // glissando duration, seconds
const VOICE_GAIN = 0.22;

let ctx = null, bus, analyser, timeBuf;
let wave = null;

// XY-scope taps: voices alternate between an X bus and a Y bus so two
// held notes trace true Lissajous figures (ratio of their frequencies)
let busX, busY, anX, anY, bufX, bufY;
let dXY, gXY, dYX, gYX;   // solo trick: delayed self-copy feeds the empty axis

// harmonic amplitudes, index 0 = fundamental
let harmonics = presetValues("organ");

// midi → { osc, gain }
const voices = new Map();
// midi → key element (filled when keyboards are built)
const keyEls = new Map();

/* ---------------- audio core ---------------- */

function ensureAudio() {
  if (ctx) { if (ctx.state === "suspended") ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  bus = ctx.createGain();
  bus.gain.value = 0.9;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 6;

  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.55;
  timeBuf = new Float32Array(analyser.fftSize);

  bus.connect(comp).connect(analyser).connect(ctx.destination);

  busX = ctx.createGain();
  busY = ctx.createGain();
  anX = ctx.createAnalyser();
  anY = ctx.createAnalyser();
  anX.fftSize = anY.fftSize = 2048;
  bufX = new Float32Array(anX.fftSize);
  bufY = new Float32Array(anY.fftSize);
  busX.connect(anX);
  busY.connect(anY);

  // when only one axis has voices, feed the other a quarter-period-delayed
  // copy so a lone sine draws a circle instead of a flat line
  dXY = ctx.createDelay(0.1); gXY = ctx.createGain(); gXY.gain.value = 0;
  busX.connect(dXY).connect(gXY).connect(anY);
  dYX = ctx.createDelay(0.1); gYX = ctx.createGain(); gYX.gain.value = 0;
  busY.connect(dYX).connect(gYX).connect(anX);

  rebuildWave();
}

function updateXYRouting() {
  if (!ctx) return;
  let nx = 0, ny = 0, fx = 0, fy = 0;
  for (const [midi, v] of voices) {
    const f = midiFreq(midi);
    if (v.axis === "x") { nx++; fx = fx ? Math.min(fx, f) : f; }
    else                { ny++; fy = fy ? Math.min(fy, f) : f; }
  }
  const t = ctx.currentTime;
  gXY.gain.setTargetAtTime(nx > 0 && ny === 0 ? 1 : 0, t, 0.05);
  gYX.gain.setTargetAtTime(ny > 0 && nx === 0 ? 1 : 0, t, 0.05);
  if (fx) dXY.delayTime.setTargetAtTime(Math.min(0.09, 0.25 / fx), t, 0.05);
  if (fy) dYX.delayTime.setTargetAtTime(Math.min(0.09, 0.25 / fy), t, 0.05);
}

function rebuildWave() {
  if (!ctx) return;
  const real = new Float32Array(NUM_HARMONICS + 1);
  const imag = new Float32Array(NUM_HARMONICS + 1);
  for (let i = 0; i < NUM_HARMONICS; i++) imag[i + 1] = harmonics[i];
  wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  for (const v of voices.values()) v.osc.setPeriodicWave(wave);
}

/* ---------------- tuning systems ----------------
   Ratios are relative to the selected root. The root itself stays at
   its equal-tempered pitch; every other note is tuned as a ratio from
   the nearest root below it. */

// quarter-comma meantone: stack pure-major-third fifths (5^(1/4)),
// Eb..G# spelling, folded into one octave
const MEANTONE = (() => {
  const fifth = 5 ** 0.25;
  const fifthsFromRoot = [0, 7, 2, -3, 4, -1, 6, 1, 8, 3, -2, 5];
  return fifthsFromRoot.map(k => {
    let r = fifth ** k;
    while (r >= 2) r /= 2;
    while (r < 1) r *= 2;
    return r;
  });
})();

const TUNINGS = {
  equal: Array.from({ length: 12 }, (_, d) => 2 ** (d / 12)),
  just: [1, 16/15, 9/8, 6/5, 5/4, 4/3, 45/32, 3/2, 8/5, 5/3, 9/5, 15/8],
  pythagorean: [1, 256/243, 9/8, 32/27, 81/64, 4/3, 729/512, 3/2, 128/81, 27/16, 16/9, 243/128],
  meantone: MEANTONE,
};

let tuningName = "equal";
let rootPc = 0;   // 0 = C

function midiFreq(m) {
  const degree = (((m % 12) - rootPc) + 12) % 12;
  const rootMidi = m - degree;
  return 440 * Math.pow(2, (rootMidi - 69) / 12) * TUNINGS[tuningName][degree];
}

// glide every sounding note to its pitch under the current tuning/root
function retune() {
  if (!ctx) return;
  const t = ctx.currentTime;
  for (const [midi, v] of voices) {
    v.osc.frequency.cancelScheduledValues(t);
    v.osc.frequency.setTargetAtTime(midiFreq(midi), t, 0.03);
  }
  updateXYRouting();
}
// pitch class → colour wheel (C = red, F# = cyan, …)
const midiHue = m => ((m % 12) / 12) * 360;

function startVoice(midi) {
  if (voices.has(midi)) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.setPeriodicWave(wave);
  osc.frequency.value = midiFreq(midi);
  gain.gain.value = 0;
  gain.gain.setTargetAtTime(VOICE_GAIN, ctx.currentTime, 0.02);
  osc.connect(gain).connect(bus);
  let nx = 0, ny = 0;
  for (const v of voices.values()) v.axis === "x" ? nx++ : ny++;
  const axis = nx <= ny ? "x" : "y";
  gain.connect(axis === "x" ? busX : busY);
  osc.start();
  voices.set(midi, { osc, gain, axis });
  markKey(midi, true);
  updateXYRouting();
}

function stopVoice(midi) {
  const v = voices.get(midi);
  if (!v) return;
  voices.delete(midi);
  const t = ctx.currentTime;
  v.gain.gain.cancelScheduledValues(t);
  v.gain.gain.setTargetAtTime(0, t, 0.05);
  v.osc.stop(t + 0.4);
  markKey(midi, false);
  updateXYRouting();
}

function glissando(fromMidi, toMidi) {
  // target already sounding → just drop the source
  if (voices.has(toMidi)) { stopVoice(fromMidi); return; }

  let v = voices.get(fromMidi);
  if (!v) { startVoice(fromMidi); v = voices.get(fromMidi); }
  voices.delete(fromMidi);
  markKey(fromMidi, false);

  const t = ctx.currentTime;
  v.osc.frequency.cancelScheduledValues(t);
  v.osc.frequency.setValueAtTime(v.osc.frequency.value, t);
  v.osc.frequency.exponentialRampToValueAtTime(midiFreq(toMidi), t + GLIDE_TIME);

  voices.set(toMidi, v);
  markKey(toMidi, true);
  updateXYRouting();
}

function markKey(midi, on) {
  const el = keyEls.get(midi);
  if (el) el.classList.toggle("active", on);
}

/* ---------------- keyboards ---------------- */

const WHITE_SEMIS = [0, 2, 4, 5, 7, 9, 11];
const BLACK_SEMIS = [1, 3, 6, 8, 10];        // c#, d#, f#, g#, a#
const BLACK_LEFT_WHITE = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };

function buildKeyboard(container) {
  const start = +container.dataset.startMidi;
  const whiteW = 100 / 14;                    // 2 octaves = 14 white keys

  for (let oct = 0; oct < 2; oct++) {
    for (const s of WHITE_SEMIS) {
      container.appendChild(makeKey(start + oct * 12 + s, "white"));
    }
  }
  for (let oct = 0; oct < 2; oct++) {
    for (const s of BLACK_SEMIS) {
      const key = makeKey(start + oct * 12 + s, "black");
      const wi = BLACK_LEFT_WHITE[s] + oct * 7;
      key.style.left = `calc(${(wi + 1) * whiteW}% - 3.2%)`;
      container.appendChild(key);
    }
  }
}

function makeKey(midi, colour) {
  const el = document.createElement("div");
  el.className = `key ${colour}`;
  el.dataset.midi = midi;
  el.style.setProperty("--keyhue", midiHue(midi));
  keyEls.set(midi, el);
  return el;
}

// tap = toggle, drag to another key = glissando (works across both rows)
let dragStart = null;

document.addEventListener("pointerdown", e => {
  const key = e.target.closest?.(".key");
  if (!key) return;
  e.preventDefault();
  ensureAudio();
  dragStart = +key.dataset.midi;
});

document.addEventListener("pointerup", e => {
  if (dragStart === null) return;
  const end = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".key");
  if (!end) { dragStart = null; return; }
  const endMidi = +end.dataset.midi;
  if (endMidi === dragStart) {
    voices.has(endMidi) ? stopVoice(endMidi) : startVoice(endMidi);
  } else {
    glissando(dragStart, endMidi);
  }
  dragStart = null;
});

document.querySelectorAll(".kbd").forEach(buildKeyboard);

/* ---------------- tuning controls ---------------- */

function markRoots() {
  for (const [midi, el] of keyEls) {
    el.classList.toggle("root", midi % 12 === rootPc);
  }
}

document.getElementById("tuning").addEventListener("change", e => {
  tuningName = e.target.value;
  retune();
});

document.getElementById("root").addEventListener("change", e => {
  rootPc = +e.target.value;
  markRoots();
  retune();
});

markRoots();

/* ---------------- harmonics chart ---------------- */

const harmCanvas = document.getElementById("harmonics");
const harmCtx2d = harmCanvas.getContext("2d");

function presetValues(name) {
  const h = new Array(NUM_HARMONICS).fill(0);
  switch (name) {
    case "sine":   h[0] = 1; break;
    case "saw":    for (let i = 0; i < NUM_HARMONICS; i++) h[i] = 1 / (i + 1); break;
    case "square": for (let i = 0; i < NUM_HARMONICS; i += 2) h[i] = 1 / (i + 1); break;
    case "organ":  h[0] = 1; h[1] = 0.55; h[2] = 0.3; h[3] = 0.4; h[7] = 0.35; break;
  }
  return h;
}

document.querySelectorAll(".presets button").forEach(btn =>
  btn.addEventListener("click", () => {
    harmonics = presetValues(btn.dataset.preset);
    ensureAudio();
    rebuildWave();
    drawHarmonics();
  })
);

function drawHarmonics() {
  const { width: w, height: h } = harmCanvas;
  harmCtx2d.clearRect(0, 0, w, h);
  const gap = w * 0.015;
  const barW = (w - gap * (NUM_HARMONICS + 1)) / NUM_HARMONICS;
  for (let i = 0; i < NUM_HARMONICS; i++) {
    const x = gap + i * (barW + gap);
    const barH = harmonics[i] * (h - 8);
    const hue = (i / NUM_HARMONICS) * 300;
    harmCtx2d.fillStyle = `hsl(${hue} 85% 60%)`;
    harmCtx2d.fillRect(x, h - barH, barW, barH);
    harmCtx2d.fillStyle = "#ffffff22";           // ghost track
    harmCtx2d.fillRect(x, 4, barW, h - 8 - barH);
  }
}

function setHarmonicFromPointer(e) {
  const r = harmCanvas.getBoundingClientRect();
  const i = Math.floor(((e.clientX - r.left) / r.width) * NUM_HARMONICS);
  if (i < 0 || i >= NUM_HARMONICS) return;
  harmonics[i] = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
  rebuildWave();
  drawHarmonics();
}

let harmDrag = false;
harmCanvas.addEventListener("pointerdown", e => {
  harmDrag = true;
  ensureAudio();
  harmCanvas.setPointerCapture(e.pointerId);
  setHarmonicFromPointer(e);
});
harmCanvas.addEventListener("pointermove", e => harmDrag && setHarmonicFromPointer(e));
harmCanvas.addEventListener("pointerup", () => (harmDrag = false));

/* ---------------- visualizers ---------------- */

const scope = document.getElementById("scope");
const xy = document.getElementById("xy");
const scopeCtx = scope.getContext("2d");
const xyCtx = xy.getContext("2d");
let xyPeak = 0.02;   // running autoscale peak for the XY trace

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const r = c.getBoundingClientRect();
  c.width = Math.round(r.width * dpr);
  c.height = Math.round(r.height * dpr);
}

function fitAll() {
  [scope, xy, harmCanvas].forEach(fitCanvas);
  drawHarmonics();
}
window.addEventListener("resize", fitAll);
fitAll();

/*  colour rules:
    - base hue = circular mean of active notes' pitch-class hues
      (glissandi sweep the hue automatically as frequency moves)
    - no notes → hue drifts slowly with time
    - loudness → line thickness + glow
    - lissajous trace fans the hue along its path; the fan widens the
      louder you play (quiet = one colour, loud = full rainbow), and
      old trace fades out slowly like phosphor on a real scope        */

function currentHue(t) {
  if (voices.size === 0) return (t * 12) % 360;
  let x = 0, y = 0;
  for (const midi of voices.keys()) {
    const a = (midiHue(midi) * Math.PI) / 180;
    x += Math.cos(a); y += Math.sin(a);
  }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function drawLoop(now) {
  requestAnimationFrame(drawLoop);
  const t = now / 1000;

  let rms = 0;
  if (analyser) {
    analyser.getFloatTimeDomainData(timeBuf);
    for (let i = 0; i < timeBuf.length; i++) rms += timeBuf[i] * timeBuf[i];
    rms = Math.sqrt(rms / timeBuf.length);
  }
  const hue = currentHue(t);
  document.documentElement.style.setProperty("--hue", hue.toFixed(0));

  /* --- oscilloscope --- */
  {
    const w = scope.width, h = scope.height;
    scopeCtx.clearRect(0, 0, w, h);
    scopeCtx.lineWidth = 2 + rms * 10;
    scopeCtx.strokeStyle = `hsl(${hue} 90% 62%)`;
    scopeCtx.shadowColor = `hsl(${hue} 90% 55%)`;
    scopeCtx.shadowBlur = rms * 60;
    scopeCtx.beginPath();
    const n = timeBuf ? timeBuf.length : 2;
    for (let i = 0; i < n; i++) {
      const v = timeBuf ? timeBuf[i] : 0;
      const x = (i / (n - 1)) * w;
      const y = h / 2 - v * h * 0.45;
      i ? scopeCtx.lineTo(x, y) : scopeCtx.moveTo(x, y);
    }
    scopeCtx.stroke();
    scopeCtx.shadowBlur = 0;
  }

  /* --- lissajous (XY scope) --- */
  {
    const w = xy.width, h = xy.height;

    // phosphor persistence: fade toward the card colour instead of clearing
    xyCtx.fillStyle = "rgba(20, 20, 31, 0.16)";
    xyCtx.fillRect(0, 0, w, h);

    // faint crosshair
    xyCtx.strokeStyle = "#ffffff10";
    xyCtx.lineWidth = 1;
    xyCtx.beginPath();
    xyCtx.moveTo(0, h / 2); xyCtx.lineTo(w, h / 2);
    xyCtx.moveTo(w / 2, 0); xyCtx.lineTo(w / 2, h);
    xyCtx.stroke();

    if (anX) {
      anX.getFloatTimeDomainData(bufX);
      anY.getFloatTimeDomainData(bufY);

      // autoscale so the figure fills the box whatever the voice count
      let peak = 0.02;
      for (let i = 0; i < bufX.length; i++) {
        const a = Math.abs(bufX[i]), b = Math.abs(bufY[i]);
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
      xyPeak = Math.max(peak, xyPeak * 0.97);   // decay slowly, jump up fast
      const S = (Math.min(w, h) * 0.42) / xyPeak;
      const cx = w / 2, cy = h / 2;

      const n = bufX.length;
      const SEG = 64;
      const fan = 40 + rms * 900;               // hue spread along the trace
      xyCtx.lineWidth = 1.5 + rms * 5;
      xyCtx.shadowBlur = rms * 35;

      for (let s = 0; s < n - 1; s += SEG) {
        const segHue = hue + ((s / n) * fan) % 360;
        xyCtx.strokeStyle = `hsl(${segHue} 90% 62%)`;
        xyCtx.shadowColor = `hsl(${segHue} 90% 55%)`;
        xyCtx.beginPath();
        for (let i = s; i <= Math.min(s + SEG, n - 1); i++) {
          const x = cx + bufX[i] * S;
          const y = cy - bufY[i] * S;
          i === s ? xyCtx.moveTo(x, y) : xyCtx.lineTo(x, y);
        }
        xyCtx.stroke();
      }
      xyCtx.shadowBlur = 0;
    }
  }
}
requestAnimationFrame(drawLoop);
