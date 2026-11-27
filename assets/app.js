/* ==========================================================================
   Meridian Air — render layer
   One decrypt boundary, one render pass, no arithmetic on thresholds: every
   band, tone and label arrives resolved in the payload. A metric the payload
   does not carry is left out, never shown as a placeholder.
   ========================================================================== */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    payload: null, passphrase: null, theme: null, source: "fitbit", stackMode: true,
    stackIndex: 0, badSeen: new Set(), sound: true, gyro: false, audio: null,
    navSeq: 0, lastCelebration: "",
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const coarsePointer = () => Boolean(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  const reduceMotion = () => Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const haptic = (pattern) => { if (coarsePointer() && navigator.vibrate) navigator.vibrate(pattern); };

  // Sound is synthesised locally: no asset request on a page holding health data.
  function ensureAudio() {
    if (!state.sound) return null;
    try {
      if (!state.audio) state.audio = new (window.AudioContext || window.webkitAudioContext)();
      if (state.audio.state === "suspended") state.audio.resume();
      return state.audio;
    } catch (error) { return null; }
  }
  function playTone(freq, delay, duration, gain, type = "sine") {
    const ctx = state.audio;
    if (!ctx || !state.sound) return;
    const at = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(gain, at + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }
  function sweep(from, to, delay, duration, gain) {
    const ctx = state.audio;
    if (!ctx || !state.sound) return;
    const at = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(to, at + duration);
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(gain, at + 0.02);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }
  function playMove(forward = true) { if (ensureAudio()) playTone(forward ? 540 : 420, 0, 0.05, 0.018, "triangle"); }
  function playCelebrate(gold) {
    if (!state.audio || !state.sound) return; // no gesture yet: stay silent
    if (gold) {
      sweep(180, 880, 0, 0.55, 0.03);
      playTone(110, 0, 0.32, 0.045, "sine");
      [523, 659, 784, 1047, 1319].forEach((freq, i) =>
        playTone(freq, 0.06 + i * 0.09, 0.42, 0.05, "triangle"));
    } else {
      [523, 784].forEach((freq, i) => playTone(freq, i * 0.085, 0.2, 0.032, "triangle"));
    }
  }
  // Cards mode lifts every measured card into one deck; remember the slot
  // it came from so switching back to Page mode restores the layout.
  const cardOrigins = new Map();
  const sectionHidden = new Map();
  let flyTimer = null;

  /* ------------------------------------------------------------- helpers -- */
  const DASH = "–";
  const has = (value) => value !== null && value !== undefined && !Number.isNaN(value);
  const tierOf = (score) => !has(score) ? "" : score >= 92 ? "gold" : score >= 80 ? "silver" : "";

  function num(value, digits = 0) {
    if (!has(value)) return DASH;
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function hm(minutes) {
    if (!has(minutes)) return DASH;
    const total = Math.round(minutes);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  }

  function signed(value, digits, suffix) {
    if (!has(value)) return DASH;
    const rounded = Number(value).toFixed(digits);
    // Sign from the rounded figure, so -0.04 reads "0.0", not "−0.0".
    const shown = Number(rounded);
    const sign = shown > 0 ? "+" : shown < 0 ? "−" : "";
    return sign + rounded.replace("-", "") + (suffix || "");
  }

  const tone = (band) => (band && band.tone) || "neutral";
  const bandLabel = (band) => (band && band.label) || "";

  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function shortDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
  }

  /* ---------------------------------------------------- plain-English help -- */
  const HELP = {
    scores: "All four scores are calculated here from your own Fitbit measurements by fixed, published rules. They borrow ideas from WHOOP, Apple and Garmin but are not their scores.",
    recovery: "A 0-100 readiness score from last night's HRV, resting heart rate, breathing, sleep and skin temperature. Each reading is turned into a z-score against your own baseline, weighted (HRV 55%, resting HR 20%, sleep 15%, breathing 5%, skin temperature 5%), then mapped through a logistic curve. Missing readings drop their weight instead of being guessed. It is a transparent approximation, not a device's proprietary score.",
    readiness: "Your recovery, adjusted for how quickly your training has been ramping up. A quick answer to: is today a good day to go hard?",
    sleep_perf: "A 0-100 score from time asleep against your own need (55%), sleep efficiency (30%) and deep/REM balance (15%). The ring, the Today card and the Last night card all show this same number.",
    load: "Training minutes in the last 7 days compared with your usual week. About 0.8 to 1.3 is a healthy build. Above 1.5 is a sudden jump that raises injury risk.",
    hrv: "Heart rate variability: tiny differences in time between heartbeats, measured while you sleep. Above your normal usually means rested. Below can mean fatigue, stress, illness or alcohol.",
    rhr: "Your heart rate at complete rest. A few beats above your normal can signal fatigue or illness. Lower over months usually means fitter.",
    resp: "Breaths per minute while asleep. It barely changes from night to night, so a rise can be an early sign of getting sick.",
    spo2: "How much oxygen your blood is carrying, measured overnight. 95 to 100% is typical.",
    skin: "How warm your skin was overnight compared with your own usual. It can rise with illness, alcohol, a warm room or the menstrual cycle.",
    stages: "Deep sleep restores the body, REM supports memory and mood, and light sleep makes up the rest. Short wake-ups are normal.",
    effort: "A 0-100 measure of how hard the workout was on your heart. Each minute of heart rate is placed in a zone of your heart-rate reserve (50/60/70/80/90%), given a weight from 1 to 5, then compressed logarithmically. It uses only the heart-rate samples your device reported and your resting heart rate; it is not Garmin's or WHOOP's score.",
    efficiency: "The share of your time in bed that you were actually asleep.",
    debt: "Sleep you missed compared with your need, added up over the last 14 nights.",
    consistency: "How often you fell asleep within 45 minutes of your usual bedtime. A steadier body clock is linked to better health.",
    jetlag: "How far your weekend sleep times drift from your weekday ones. It is like crossing time zones every weekend. Under an hour is good.",
    hrv_status: "Your HRV averaged over the past week and compared with your normal range. One night means little; the weekly trend tells you more.",
    vo2: "Cardio fitness: how much oxygen your body can use during hard exercise. It is one of the strongest predictors of long-term health. One MET is 3.5 ml/kg/min.",
    rhr_trend: "Your average resting heart rate this month compared with the month before. A slow drift down usually means improving fitness.",
    steps: "Your average daily steps. In large studies, the health benefit kept growing up to a certain range and then levelled off.",
    bmi: "Weight relative to height. A rough screening number: it can't tell muscle from fat.",
    intensity: "How your workout time splits between easy effort, where you could still talk, and hard effort, where you are breathing heavily. Most endurance plans aim for about 80% easy.",
    active: "Minutes you moved briskly enough to raise your heart rate. Health guidelines suggest at least 150 a week.",
    workout: "Every measurement the API reported for your most recent session, plus how it compares with your recent sessions of the same kind. Pace and speed are only shown when measured or calculable from distance and time.",
    workout_hr: "One-minute average heart rate during the workout. Each stretch is coloured by the zone your device reported: grey below light, grey-blue light, blue moderate, amber vigorous, red peak. Hover or drag over the line to read any minute; arrow keys work too. If the device sent no samples or no zone limits, the chart says so rather than guessing.",
    te: "How hard your workout was for you, Garmin-style. Aerobic counts steady effort (moderate and vigorous heart-rate zones; easy light-zone time doesn't count, as with Fitbit's Active Zone Minutes); anaerobic counts all-out bursts (peak zone). 5.0 means as hard as your toughest recent sessions.",
    heatmap: "Each square is one day. Darker squares mean more training minutes.",
    factors: "Each card shows the reading your device reported and, underneath, how much that driver counts toward today's recovery score. The share is not a sleep or HRV score.",
    patterns: "A number from −1 to +1 showing how closely two of your measures move together. Closer to ±1 is stronger. It shows a link, not a cause.",
  };

  const info = (key) =>
    HELP[key]
      ? `<button class="info" type="button" data-help="${key}" aria-expanded="false" aria-label="What does this mean?">i</button>`
      : "";

  let helpPop = null;
  let helpButton = null;
  let helpSeq = 0;

  function hideHelp() {
    if (helpPop) helpPop.remove();
    if (helpButton) {
      helpButton.setAttribute("aria-expanded", "false");
      helpButton.removeAttribute("aria-describedby");
    }
    helpPop = helpButton = null;
  }

  function showHelp(button) {
    hideHelp();
    const pop = document.createElement("div");
    pop.className = "info-pop";
    pop.id = `info-help-${++helpSeq}`;
    pop.setAttribute("role", "status");
    pop.setAttribute("aria-live", "polite");
    pop.textContent = HELP[button.dataset.help];
    document.body.appendChild(pop);
    const box = button.getBoundingClientRect();
    const left = Math.min(Math.max(8, box.left + box.width / 2 - pop.offsetWidth / 2),
      document.documentElement.clientWidth - pop.offsetWidth - 8);
    const below = box.bottom + 8;
    const flip = below + pop.offsetHeight > window.innerHeight - 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${(flip ? box.top - pop.offsetHeight - 8 : below) + window.scrollY}px`;
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-describedby", pop.id);
    helpPop = pop;
    helpButton = button;
  }

  const slot = (name) => document.querySelector(`[data-slot="${name}"]`);
  const status = (band, text) =>
    `<span class="status ${tone(band)}">${esc(text ?? bandLabel(band))}</span>`;

  /* -------------------------------------------------------------- vault --- */
  function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function decryptVault(passphrase) {
    const response = await fetch("data/biometrics.enc.json?ts=" + Date.now(), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? "No vault published yet. Run sync.py, then encrypt_data.py."
          : `Could not read the vault (HTTP ${response.status}).`
      );
    }
    const envelope = await response.json();
    const salt = decodeBase64(envelope.salt);
    const iv = decodeBase64(envelope.iv);
    const ciphertext = decodeBase64(envelope.data);

    const keyMaterial = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: Number(envelope.iterations), hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  /* --------------------------------------------------------------- theme -- */
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("ma-theme", theme);
    } catch (error) {
      /* private mode: the theme simply does not persist */
    }
    $("btnTheme").setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    // Charts and rings read colours from CSS variables at draw time.
    if (state.payload) render(state.payload);
  }

  function initTheme() {
    let stored = null;
    try {
      stored = localStorage.getItem("ma-theme");
    } catch (error) {
      stored = null;
    }
    applyTheme(stored || "light");
  }

  const SOURCE_ICONS = {
    fitbit: '<svg viewBox="0 0 24 24"><circle cx="7" cy="15" r="2.2"/><circle cx="11" cy="12" r="2.8"/><circle cx="16" cy="9" r="3.4"/></svg>',
    garmin: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 6V4M15 6V4M9 20v-2M15 20v-2M6 10H4M6 14H4M20 10h-2M20 14h-2"/></svg>',
    other: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 16.5 7.8 12.4a2.6 2.6 0 0 1 3.7-3.7l.5.5.5-.5a2.6 2.6 0 0 1 3.7 3.7Z"/></svg>',
    all: '<svg viewBox="0 0 24 24"><circle cx="8" cy="12" r="3"/><circle cx="15" cy="8" r="2.4"/><circle cx="16" cy="16" r="2.4"/></svg>',
  };
  const SOURCE_LABELS = {
    fitbit: "Fitbit Air", garmin: "Garmin Fenix", other: "Google / other", all: "All sources",
  };
  const SOURCE_ORDER = ["fitbit", "garmin", "other", "all"];
  const SOURCE_DESCRIPTIONS = {
    fitbit: "Your Fitbit Air only", garmin: "Garmin watch sessions", other: "Google Fit and phone", all: "Everything combined",
  };

  function closeSourceMenu() {
    const menu = $("sourceMenu");
    const button = $("sourceButton");
    if (menu) menu.hidden = true;
    if (button) button.setAttribute("aria-expanded", "false");
  }

  function updateSourceUI(data) {
    const picker = $("sourcePicker");
    if (!picker) return;
    const views = data.views || null;
    picker.hidden = !views;
    if (!views) return;
    if (!views[state.source]) state.source = data.default_view || "fitbit";

    const button = $("sourceButton");
    if (button) {
      button.innerHTML = `<span class="source-icon" aria-hidden="true">${SOURCE_ICONS[state.source]}</span>
        <span>${esc(SOURCE_LABELS[state.source])}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>`;
      button.setAttribute("aria-label", `Data source: ${SOURCE_LABELS[state.source]}`);
    }
    const menu = $("sourceMenu");
    if (!menu) return;
    menu.innerHTML = SOURCE_ORDER.map((key) => {
      const view = views[key];
      const count = view && view.history ? (view.history.exercise || []).length : 0;
      return `<button class="source-option${key === state.source ? " selected" : ""}" type="button"
        role="option" aria-selected="${key === state.source}" data-source="${key}"${view ? "" : " disabled"}>
        <span class="source-icon" aria-hidden="true">${SOURCE_ICONS[key]}</span>
        <span class="source-text"><b>${esc(SOURCE_LABELS[key])}</b><small>${esc(SOURCE_DESCRIPTIONS[key])}</small></span>
        <span class="source-count">${view ? `${count} workouts` : "no data"}</span>
      </button>`;
    }).join("");
  }

  function initSource() {
    try {
      const stored = localStorage.getItem("ma-source");
      if (SOURCE_ORDER.includes(stored)) state.source = stored;
    } catch (error) {
      /* private mode: use the default */
    }
  }

  function setSource(next) {
    if (!SOURCE_ORDER.includes(next)) return;
    state.source = next;
    try {
      localStorage.setItem("ma-source", next);
    } catch (error) {
      /* preference is not essential */
    }
    closeSourceMenu();
    if (state.payload) render(state.payload);
  }

  /* --------------------------------------------------------------- today -- */
  const RING_R = 52;
  const RING_C = 2 * Math.PI * RING_R;

  function ring(ratio, color, inner, ticks = false) {
    const bounded = has(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
    // A quiet instrument detail: fine ticks around the recovery ring only.
    const tickMarkup = ticks ? `<g class="ring-ticks">${Array.from({ length: 36 }, (_, i) => {
      const angle = (i * 10 - 90) * Math.PI / 180;
      const long = i % 3 === 0;
      const a = long ? 57 : 59;
      const b = 63;
      const point = (r) => `${(60 + r * Math.cos(angle)).toFixed(1)} ${(60 + r * Math.sin(angle)).toFixed(1)}`;
      return `<line x1="${point(a).split(" ")[0]}" y1="${point(a).split(" ")[1]}"
        x2="${point(b).split(" ")[0]}" y2="${point(b).split(" ")[1]}"
        stroke="var(--line-strong)" stroke-width="${long ? 1.4 : 1}" opacity="${long ? 0.8 : 0.45}" />`;
    }).join("")}</g>` : "";
    return `<div class="ring-wrap">
      <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
        ${tickMarkup}
        <circle class="trk" cx="60" cy="60" r="${RING_R}" />
        <circle class="val" cx="60" cy="60" r="${RING_R}" stroke="${color}"
          stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C * (1 - bounded)}" />
      </svg>
      <div class="ring-center">${inner}</div>
    </div>`;
  }

  function scoreBlock({ help, label, figure, unit, ratio, color, band, bandText, sub }) {
    return `<div class="score">
      <div class="score-title">${esc(label)}${info(help)}</div>
      ${ring(ratio, color, `<div class="ring-value">${figure}${unit ? `<small>${unit}</small>` : ""}</div>`)}
      <div class="score-band" style="color:${color}">${esc(bandText ?? bandLabel(band))}</div>
      ${sub ? `<div class="score-sub">${sub}</div>` : ""}
    </div>`;
  }

  function toneColor(band) {
    const t = tone(band);
    return cssVar(t === "neutral" ? "--text" : `--${t}`);
  }

  function renderToday(data) {
    const today = data.today || {};
    const recovery = today.recovery || {};
    const sleep = today.sleep || {};
    const load = data.load || {};
    const readiness = today.readiness || {};

    const dateText = today.date
      ? new Date(today.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })
      : "";
    const device = (data.device && data.device.name) || "Fitbit";
    const lede = recovery.band && recovery.band.plain
      ? recovery.band.plain
      : (data.clinical && data.clinical.headline) || "";
    // One sleep number everywhere: the pipeline's sleep score (duration,
    // efficiency and stage balance). The need ratio is only its fallback and
    // the supporting readout, never a second competing score.
    const needRatio = has(sleep.minutes) && sleep.need_minutes
      ? Math.min(100, (sleep.minutes / sleep.need_minutes) * 100) : null;
    const perf = has(sleep.score) ? Number(sleep.score) : needRatio;

    const ringStat = (label, ratio, value, unit, color, bandText, help, sub, ticks = false) => `<div class="hero-ring-stat">
      ${has(ratio) ? ring(ratio, color, `<div class="ring-value">${value}${unit ? `<small>${unit}</small>` : ""}</div>`, ticks) : ""}
      <div class="label">${label}${info(help)}</div>
      <div class="ring-band" style="color:${color}">${esc(bandText)}</div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}
    </div>`;

    const rings = [
      has(recovery.score) ? ringStat("Recovery", recovery.score / 100, Math.round(recovery.score), "%",
        toneColor(recovery.band), bandLabel(recovery.band), "recovery",
        has(today.hrv && today.hrv.delta_pct) ? `HRV ${signed(today.hrv.delta_pct, 0, "%")} vs median` : "", true) : "",
      perf !== null ? ringStat("Sleep", perf / 100, Math.round(perf), "%", cssVar("--sleep"),
        sleep.band ? bandLabel(sleep.band) : perf >= 100 ? "Need met" : "Short of need", "sleep_perf",
        `${hm(sleep.minutes)} of ${hm(sleep.need_minutes)}`) : "",
      has(load.acwr) ? ringStat("Training load", Math.min(2, load.acwr) / 2, load.acwr.toFixed(2), "",
        tone(load.acwr_band) === "good" ? cssVar("--chart") : toneColor(load.acwr_band),
        bandLabel(load.acwr_band), "load", `${num(load.acute_minutes)} min this week`) : "",
    ].filter(Boolean).join("");

    const focusKey = (data.coaching && data.coaching.focus) || "";
    const focusCard = ((data.coaching && data.coaching.cards) || []).find((card) => card.key === focusKey);
    const focus = focusCard ? focusCard.title : focusKey;
    const foot = [
      has(readiness.score) ? `Readiness <b>${Math.round(readiness.score)}</b> · ${esc(bandLabel(readiness.band))}` : "",
      has(today.hrv && today.hrv.delta_pct) ? `HRV <b>${signed(today.hrv.delta_pct, 0, "%")}</b> vs your median` : "",
      focus ? `Focus <b>${esc(focus)}</b>` : "",
    ].filter(Boolean).join('<span class="foot-sep">·</span>');

    $("pageTitle").textContent = "Today";
    const factors = Array.isArray(recovery.factors) ? recovery.factors : [];
    const labels = (data.policy && data.policy.labels) || {};
    const markers = data.markers || {};
    const factorDetail = {
      hrv: "Compared with your own 30-night median.",
      rhr: "Compared with your own 30-day median.",
      sleep: "Measured against tonight's sleep need.",
      resp: "Compared with your own breathing-rate baseline.",
      skin: "Temperature drift away from your usual overnight baseline.",
    };
    const factorLabels = {
      hrv: "HRV", rhr: "Resting HR", sleep: "Sleep", resp: "Breathing rate", skin: "Skin temp",
    };
    const deckOffsets = [
      { x: -26, y: 16, r: -6 },
      { x: 24, y: -14, r: 5 },
      { x: -18, y: 22, r: -3.5 },
      { x: 20, y: 12, r: 4.5 },
    ];

    // The headline of every Today card is a reported reading or a real score,
    // never a contribution share dressed up as a percentage score.
    const figureFromRead = (read) => {
      const match = String(read || "").match(/^(.+?)\s+(?:vs|against|from)\b/i);
      return match ? match[1].trim() : String(read || "").trim();
    };
    const deckItems = factors.map((f) => {
      const weight = Number(f.weight) || 0;
      return {
        key: `factor-${f.key}`, label: factorLabels[f.key] || labels[f.key] || f.key, help: "factors",
        figure: figureFromRead(f.read), unit: "", tier: "", score: 0,
        read: f.read || "", detail: factorDetail[f.key] || "",
        note: `${Math.round(weight)}% of today's recovery score`,
      };
    });

    if (perf !== null) deckItems.push({
      key: "sleep-performance", label: "Sleep score", help: "sleep_perf",
      figure: String(Math.round(perf)), unit: "%", score: Math.round(perf), tier: tierOf(perf),
      read: `${hm(sleep.minutes)} of ${hm(sleep.need_minutes)} needed`,
      detail: "Duration against need, efficiency and stage balance.", note: "Sleep score",
    });
    if (has(readiness.score)) deckItems.push({
      key: "readiness", label: "Training readiness", help: "readiness",
      figure: String(Math.round(readiness.score)), unit: "%", score: Math.round(readiness.score),
      tier: tierOf(readiness.score), read: bandLabel(readiness.band),
      detail: "Recovery tempered by the load trend.", note: "Today's readiness",
    });
    if (has(load.acwr)) deckItems.push({
      key: "load", label: "Training load", help: "load",
      figure: load.acwr.toFixed(2), unit: "", score: 0,
      tier: tone(load.acwr_band) === "good" ? "silver" : "",
      read: `${load.acwr.toFixed(2)} · ${bandLabel(load.acwr_band)}`,
      detail: "This week's minutes against your usual week.", note: "Acute : chronic",
    });
    if (has(today.spo2 && today.spo2.pct)) deckItems.push({
      key: "spo2", label: "Blood oxygen", help: "spo2",
      figure: num(today.spo2.pct, 1), unit: "%", score: 0,
      tier: tone(today.spo2.band) === "good" ? "silver" : "",
      read: `${num(today.spo2.pct, 1)}% overnight`,
      detail: "Nightly average oxygen saturation.", note: "Measured overnight",
    });
    if (has(sleep.debt_minutes) && sleep.debt_minutes === 0) deckItems.push({
      key: "sleep-debt", label: "Sleep debt", help: "debt",
      figure: "None", unit: "", score: 0, tier: "silver",
      read: "None", detail: "No accumulated need across 14 nights.", note: "Sleep need",
    });
    const illness = data.clinical && data.clinical.illness;
    if (illness && illness.level === "none") deckItems.push({
      key: "illness", label: "Illness watch", help: "recovery",
      figure: "Clear", unit: "", score: 0, tier: "silver",
      read: illness.headline, detail: "No early-illness pattern in the measured signals.", note: "Measured signals",
    });

    const deck = deckItems.length ? `<div class="deck-section">
      <div class="section-mini">Today's cards${info("factors")}</div>
      <div class="deck" id="factorDeck" role="list" aria-label="Today's measurements">
        ${deckItems.map((item, index) => {
          const score = Math.max(0, Math.min(100, Number(item.score) || 0));
          const tier = item.tier || "";
          const gold = tier === "gold";
          const silver = tier === "silver";
          const foil = gold || silver;
          const scored = item.unit === "%";
          const offset = deckOffsets[index % deckOffsets.length];
          return `<button class="deck-card${foil ? " foil" : ""}${gold ? " gold" : ""}${silver ? " silver" : ""}" type="button" role="listitem" data-index="${index}"
            data-foil="${foil}" data-good="${foil}" data-gold="${gold}" data-tier="${tier}" data-score="${score}"
            data-result-key="${esc(item.key)}" data-label="${esc(item.label)}"
            style="--bx:${offset.x}px;--by:${offset.y}px;--br:${offset.r}deg"
            aria-label="${esc(item.label)}: ${esc(item.read)}">
            <span class="deck-top">
              <span class="deck-num">${String(index + 1).padStart(2, "0")} / ${String(deckItems.length).padStart(2, "0")}</span>
              <span class="deck-score${scored ? "" : " text"}">${esc(item.figure)}${scored ? `<small>%</small>` : ""}</span>
            </span>
            ${foil && scored ? `<span class="foil-badge">${gold ? "Near perfect" : "Silver tier"}</span>` : ""}
            <span class="deck-label">${esc(item.label)}</span>
            <span class="deck-weight">${esc(item.note)}</span>
            <span class="deck-read">${esc(item.read)}</span>
            <span class="deck-detail">${esc(item.detail)}</span>
            ${scored ? `<span class="progress"><i style="width:${score}%"></i></span>` : ""}
          </button>`;
        }).join("")}
      </div>
      <p class="sub deck-hint">Press the top card to send it to the back.</p>
    </div>` : "";

    const recoveryTier = tierOf(recovery.score);
    slot("today").innerHTML = `<div class="hero-card${recoveryTier ? " foil" : ""}${recoveryTier === "gold" ? " gold" : recoveryTier === "silver" ? " silver" : ""}"
      data-tone="${esc(tone(recovery.band))}"
      data-good="${has(recovery.score) && recovery.score >= 80}" data-gold="${has(recovery.score) && recovery.score >= 92}"
      data-tier="${recoveryTier}" data-result-key="recovery" data-label="Recovery">
      <div class="hero-intro">
        <p class="eyebrow">${esc(dateText)} · ${esc(device)}</p>
        <h1>${has(recovery.score) && bandLabel(recovery.band) ? esc(bandLabel(recovery.band)) : "Today"}</h1>
        ${lede ? `<p class="hero-lede">${esc(lede)}</p>` : ""}
      </div>
      ${rings ? `<div class="hero-rings">${rings}</div>` : ""}
      ${foot ? `<div class="hero-foot">${foot}</div>` : ""}
    </div>${deck ? `<div style="height:16px"></div>${deck}` : ""}`;
  }

  function bindFactorDeck() {
    const deck = $("factorDeck");
    if (!deck) return;
    const cards = [...deck.querySelectorAll(".deck-card")];
    if (cards.length < 2) return;
    let order = cards.map((_, index) => index);

    function paint() {
      order.forEach((cardIndex, position) => {
        const card = cards[cardIndex];
        const depth = order.length - 1 - position;
        const front = depth === 0;
        const style = card.style;
        style.setProperty("--x", front ? "0px" : `calc(var(--bx) * var(--stack-scale) * ${0.5 + depth * 0.35})`);
        style.setProperty("--y", front ? "0px" : `calc(var(--by) * var(--stack-scale) * ${0.5 + depth * 0.35})`);
        style.setProperty("--r", front ? "0deg" : `calc(var(--br) * var(--stack-scale) * ${0.5 + depth * 0.35})`);
        style.setProperty("--z", String(position + 1));
        card.dataset.front = String(front);
      });
    }

    function toFront(index) {
      order = order.filter((value) => value !== index).concat(index);
      paint();
    }

    function toBack(index) {
      order = [index].concat(order.filter((value) => value !== index));
      paint();
    }

    cards.forEach((card) => {
      const index = Number(card.dataset.index);
      card.addEventListener("click", () => {
        if (state.stackMode) return; // the deck viewport owns presses in Cards mode
        if (order[order.length - 1] === index) toBack(index);
        else toFront(index);
      });
      card.addEventListener("keydown", (event) => {
        if (state.stackMode) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (order[order.length - 1] === index) toBack(index);
          else toFront(index);
        }
      });
    });
    paint();
  }

  /* -------------------------------------------------------------- vitals -- */
  // A compact comparison of the readings the API actually reported, with the
  // user's own baseline drawn as a dashed reference. No estimated points.
  function miniTrend(history, field, baseline, name = "Reading") {
    const rows = (history || []).filter((row) => has(Number(row[field])) && row.date).slice(-10);
    if (rows.length < 2) return `<p class="trend-empty">Not enough readings to compare.</p>`;
    const values = rows.map((row) => Number(row[field]));
    const ref = has(baseline) ? Number(baseline) : null;
    const lo0 = Math.min(...values, ref === null ? Infinity : ref);
    const hi0 = Math.max(...values, ref === null ? -Infinity : ref);
    const pad = (hi0 - lo0) * 0.15 || 1;
    const lo = lo0 - pad;
    const hi = hi0 + pad;
    const x = (i) => 6 + i * (188 / (values.length - 1));
    const y = (v) => 48 - ((v - lo) / (hi - lo)) * 38;
    const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const last = values.length - 1;
    return `<div class="trend-block">
      <svg class="mini-trend" viewBox="0 0 200 56" preserveAspectRatio="none"
        role="img" aria-label="${esc(name)}: ${rows.length} daily readings${ref === null ? "" : " against your baseline"}">
        ${ref === null ? "" : `<line class="base" x1="6" x2="194" y1="${y(ref).toFixed(1)}" y2="${y(ref).toFixed(1)}" />`}
        <polyline points="${points}" fill="none" stroke="var(--trend, var(--accent))"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <rect class="latest" x="${(x(last) - 3).toFixed(1)}" y="${(y(values[last]) - 3).toFixed(1)}"
          width="6" height="6" rx="1.5" fill="var(--trend, var(--accent))" />
      </svg>
      <div class="trend-caption"><span>${esc(shortDate(rows[0].date))}</span><span>${esc(shortDate(rows[last].date))}</span></div>
    </div>`;
  }

  function renderVitals(data) {
    const t = data.today || {};
    const hrv = t.hrv || {};
    const rhr = t.rhr || {};
    const resp = t.resp || {};
    const spo2 = t.spo2 || {};
    const skin = t.skin_temp || {};
    const history = data.history || {};

    const rows = [
      has(hrv.ms) && {
        help: "hrv", name: "HRV", value: `${num(hrv.ms)} ms`,
        base: has(hrv.baseline) ? `${num(hrv.baseline)} ms` : "", change: signed(hrv.delta_pct, 0, "%"), band: hrv.band, date: hrv.date,
        trend: miniTrend(history.hrv, "ms", hrv.baseline, "HRV"),
      },
      has(rhr.bpm) && {
        help: "rhr", name: "Resting HR", value: `${num(rhr.bpm)} bpm`,
        base: has(rhr.baseline) ? `${num(rhr.baseline)} bpm` : "", change: signed(rhr.delta, 0, " bpm"), band: rhr.band, date: rhr.date,
        trend: miniTrend(history.rhr, "bpm", rhr.baseline, "Resting HR"),
      },
      has(resp.brpm) && {
        help: "resp", name: "Breathing rate", value: `${num(resp.brpm, 1)} /min`,
        base: has(resp.baseline) ? `${num(resp.baseline, 1)} /min` : "", change: signed(resp.delta, 1, ""), band: resp.band, date: resp.date,
        trend: miniTrend(history.resp, "brpm", resp.baseline, "Breathing rate"),
      },
      has(spo2.pct) && {
        help: "spo2", name: "Blood oxygen", value: `${num(spo2.pct, 1)}%`, base: "", change: "", band: spo2.band, date: spo2.date,
        trend: miniTrend(history.spo2, "pct", null, "Blood oxygen"),
      },
      // The API gives skin temperature with its own 30-night baseline; there
      // is no published threshold for it here, so it carries no status colour.
      has(skin.delta_c) && {
        help: "skin", name: "Skin temp", value: `${signed(skin.delta_c, 1, " °C")}`, base: "30-night median", change: "", date: skin.date,
        trend: miniTrend(history.skin_temp, "delta_c", null, "Skin temperature"),
        band: null, bandText: "Not scored",
      },
    ].filter(Boolean);

    const illness = (data.clinical && data.clinical.illness) || null;

    slot("vitals").innerHTML = rows.length
      ? `<div class="metric-grid">${rows.map((r) => {
          const foil = Boolean(r.band) && tone(r.band) === "good";
          const gold = foil && ["primed", "optimal", "normal"].includes(r.band.key);
          const tier = gold ? "gold" : foil ? "silver" : "";
          return `<div class="card metric-card${foil ? " foil" : ""}${gold ? " gold" : ""}${tier === "silver" ? " silver" : ""}"
            data-good="${foil}" data-gold="${gold}" data-tier="${tier}" data-score="${gold ? 100 : foil ? 80 : 0}"
            data-result-key="vital-${esc(r.name)}" data-label="${esc(r.name)}">
            <div class="label">${esc(r.name)}${info(r.help)}</div>
            <div class="figure">${esc(r.value)}</div>
            <div class="sub">${esc([r.base && r.base !== "30-night median" ? `Usual ${r.base}` : r.base, r.change, r.date ? `Measured ${shortDate(r.date)}` : ""].filter(Boolean).join(" · "))}</div>
            <div class="tile-status">${status(r.band, r.bandText)}${foil ? '<span class="foil-badge">On track</span>' : ""}</div>
            ${r.trend}
          </div>`;
        }).join("")}</div>
        ${illness && illness.headline ? `<p class="note">${status({ tone: illness.tone }, illness.headline)}${
          (illness.drivers || []).length ? ` · ${esc(illness.drivers.join(", "))}` : ""}</p>` : ""}`
      : `<p class="muted">No overnight vitals in this sync.</p>`;
  }

  /* --------------------------------------------------------------- sleep -- */
  function readouts(items) {
    const rows = items.filter(([, value]) => has(value) && value !== "");
    return rows.length ? `<div class="readouts">${rows.map(([label, value]) =>
      `<div class="readout"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}</div>` : "";
  }

  /* ------------------------------------------- latest workout HR trace -- */
  const HR_CHART = { w: 720, h: 240, left: 44, right: 18, top: 18, bottom: 34 };
  const HR_ZONES = {
    below: ["--faint", "Below zones"],
    light: ["--zone-light", "Light"],
    moderate: ["--zone-moderate", "Moderate"],
    vigorous: ["--zone-vigorous", "Vigorous"],
    peak: ["--zone-peak", "Peak"],
  };

  function hrZone(bpm, zones) {
    for (const key of ["peak", "vigorous", "moderate", "light"]) {
      const range = zones && zones[key];
      if (range && bpm >= range[0] && bpm <= range[1]) return key;
    }
    return "below";
  }

  function clockInZone(iso, timezone) {
    if (!iso) return "";
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: timezone || undefined, hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(iso));
    } catch (error) {
      return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
  }

  function workoutHrChart(data, workoutZones) {
    const samples = ((data.history && data.history.workout_hr) || []).filter((row) => has(row.bpm)).slice(-180);
    if (samples.length < 2) {
      return `<div class="section-mini">Heart rate${info("workout_hr")}</div>
        <p class="sub">No per-minute heart-rate samples were returned for this workout. The measured average is above; no line is drawn from an estimate.</p>`;
    }

    const zones = data.hr_zones || null;
    const { w, h, left, right, top, bottom } = HR_CHART;
    const values = samples.map((row) => row.bpm);
    const low = Math.max(30, Math.floor((Math.min(...values) - 8) / 10) * 10);
    const high = Math.ceil((Math.max(...values) + 8) / 10) * 10;
    const xAt = (index) => left + (index / (samples.length - 1)) * (w - left - right);
    const yAt = (bpm) => top + ((high - bpm) / (high - low)) * (h - top - bottom);
    const points = samples.map((row, index) => ({ x: xAt(index), y: yAt(row.bpm), bpm: row.bpm }));
    const mean = (v) => v.reduce((a, c) => a + c, 0) / v.length;
    const average = Math.round(mean(values));
    const peak = Math.max(...values);
    const third = Math.max(1, Math.floor(values.length / 3));
    const drift = Math.round(mean(values.slice(-third)) - mean(values.slice(0, third)));
    const thirds = samples.length >= 3
      ? [0, 1, 2].map((part) =>
          Math.round(mean(values.slice(part * third, part === 2 ? values.length : (part + 1) * third))))
      : [null, null, null];
    const thirdText = (value) => has(value) ? `${value} bpm` : DASH;

    const bands = zones ? Object.keys(HR_ZONES).filter((key) => zones[key]).map((key) => {
      const [a, b] = zones[key];
      const y1 = yAt(Math.min(high, Math.max(low, b)));
      const y2 = yAt(Math.min(high, Math.max(low, a)));
      if (y2 <= y1) return "";
      return `<rect x="${left}" y="${y1.toFixed(1)}" width="${w - left - right}" height="${(y2 - y1).toFixed(1)}"
        fill="var(${HR_ZONES[key][0]})" opacity="0.09" />`;
    }).join("") : "";

    const grid = [low, Math.round((low + high) / 2), high].map((value) =>
      `<line x1="${left}" y1="${yAt(value).toFixed(1)}" x2="${w - right}" y2="${yAt(value).toFixed(1)}" stroke="var(--line)" />`).join("");

    const used = new Set();
    let full = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    let strokes = "";
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      full += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
      const zone = zones ? hrZone((p1.bpm + p2.bpm) / 2, zones) : "moderate";
      used.add(zone);
      strokes += `<path d="M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}"
        fill="none" stroke="var(${HR_ZONES[zone][0]})" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`;
    }
    const area = `${full} L ${points[points.length - 1].x.toFixed(1)} ${h - bottom} L ${points[0].x.toFixed(1)} ${h - bottom} Z`;

    const topIndex = values.indexOf(peak);
    const topPoint = points[topIndex];
    const avgY = yAt(average);
    const marker = `<line x1="${left}" y1="${avgY.toFixed(1)}" x2="${w - right}" y2="${avgY.toFixed(1)}" stroke="var(--line-strong)" stroke-dasharray="4 5" />
      <circle cx="${topPoint.x.toFixed(1)}" cy="${topPoint.y.toFixed(1)}" r="4.5" fill="var(--surface)" stroke="var(--text)" stroke-width="2" />`;

    // The device's own zone-minute summary gives a clean second reading;
    // per-sample runs are too fragmented to use as a strip.
    const stripData = workoutZones
      ? Object.keys(HR_ZONES).filter((key) => workoutZones[key] > 0).map((key) => [key, workoutZones[key]])
      : [["moderate", 1]];
    const stripTotal = stripData.reduce((sum, [, minutes]) => sum + minutes, 0);
    const strip = stripData.map(([key, minutes]) =>
      `<span style="width:${(100 * minutes / stripTotal).toFixed(1)}%;background:var(${HR_ZONES[key][0]})"
        title="${HR_ZONES[key][1]} · ${hm(minutes)}"></span>`).join("");

    const ticks = [high, Math.round((low + high) / 2), low];
    const legend = zones
      ? [...used].map((key) => `<span><i style="background:var(${HR_ZONES[key][0]})"></i>${HR_ZONES[key][1]}${
          zones[key] ? ` <b>${zones[key][0]}–${zones[key][1]}</b>` : ""}</span>`).join("")
      : `<span><i style="background:var(--zone-moderate)"></i>Heart rate · zone limits not reported</span>`;

    return `<div class="section-mini hr-head"><span>Heart rate during workout${info("workout_hr")}</span>
        <span class="hr-summary">Average <b>${average}</b> · Peak <b>${peak}</b> · Drift <b>${signed(drift, 0, " bpm")}</b></span>
      </div>
      <div class="hr-ribbon">
        <div class="hr-plot">
          <div class="hr-y">${ticks.map((value) => `<span>${value}</span>`).join("")}</div>
          <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" tabindex="0"
            aria-label="Heart rate during the latest workout, coloured by heart-rate zone. Hover or drag to inspect a minute; arrow keys also work.">
            ${bands}${grid}<path d="${area}" fill="var(--accent-soft)" />${marker}${strokes}
            <line class="scrub-line" x1="0" y1="${top}" x2="0" y2="${h - bottom}" />
            <circle class="scrub-dot" cx="0" cy="0" r="4.5" />
          </svg>
          <div class="hr-tip" hidden></div>
        </div>
        <div class="hr-axis"><span>${clockInZone(samples[0].t, data.timezone)}</span><span>${clockInZone(samples[samples.length - 1].t, data.timezone)}</span></div>
        <div class="zone-strip" role="img" aria-label="Time spent in each heart-rate zone">${strip}</div>
        <div class="hr-split">
          <div><span>First third</span><b>${thirdText(thirds[0])}</b></div>
          <div><span>Middle third</span><b>${thirdText(thirds[1])}</b></div>
          <div><span>Last third</span><b>${thirdText(thirds[2])}</b></div>
        </div>
        <p class="hr-peak">Move over the line, or drag on a phone, to read any minute. Dashed line is your average.</p>
      </div>
      <div class="legend hr-legend">${legend}</div>`;
  }

  function bindHrScrub(samples, zones, timezone) {
    const svg = document.querySelector(".hr-ribbon svg");
    if (!svg || samples.length < 2) return;
    const plot = svg.parentElement;
    const tip = plot.querySelector(".hr-tip");
    const line = svg.querySelector(".scrub-line");
    const dot = svg.querySelector(".scrub-dot");
    const { w, h, left, right, top, bottom } = HR_CHART;
    const values = samples.map((row) => row.bpm);
    const low = Math.max(30, Math.floor((Math.min(...values) - 8) / 10) * 10);
    const high = Math.ceil((Math.max(...values) + 8) / 10) * 10;
    const xAt = (index) => left + (index / (samples.length - 1)) * (w - left - right);
    const yAt = (bpm) => top + ((high - bpm) / (high - low)) * (h - top - bottom);
    let index = -1;

    function show(next) {
      index = Math.max(0, Math.min(samples.length - 1, next));
      const sample = samples[index];
      const px = xAt(index);
      const py = yAt(sample.bpm);
      line.setAttribute("x1", px);
      line.setAttribute("x2", px);
      line.setAttribute("opacity", "1");
      dot.setAttribute("cx", px);
      dot.setAttribute("cy", py);
      dot.setAttribute("opacity", "1");

      const zone = hrZone(sample.bpm, zones);
      const range = zones && zones[zone] ? ` ${zones[zone][0]}–${zones[zone][1]}` : "";
      tip.innerHTML = `<i style="background:var(${HR_ZONES[zone][0]})"></i>
        <b>${sample.bpm} bpm</b>
        <span>${clockInZone(sample.t, timezone)} · ${HR_ZONES[zone][1]}${range}</span>`;
      tip.hidden = false;

      const svgBox = svg.getBoundingClientRect();
      const plotBox = plot.getBoundingClientRect();
      const x = svgBox.left - plotBox.left + (px / w) * svgBox.width;
      const y = svgBox.top - plotBox.top + (py / h) * svgBox.height;
      tip.style.left = `${Math.max(76, Math.min(plotBox.width - 76, x))}px`;
      tip.style.top = `${Math.max(8, y - 12)}px`;
    }

    function hide() {
      tip.hidden = true;
      line.setAttribute("opacity", "0");
      dot.setAttribute("opacity", "0");
      index = -1;
    }

    function fromPointer(event) {
      const box = svg.getBoundingClientRect();
      const viewX = ((event.clientX - box.left) / box.width) * w;
      show(Math.round(((viewX - left) / (w - left - right)) * (samples.length - 1)));
    }

    svg.addEventListener("pointermove", fromPointer);
    svg.addEventListener("pointerdown", (event) => {
      try { svg.setPointerCapture(event.pointerId); } catch (error) { /* synthetic or stale pointer */ }
      fromPointer(event);
    });
    svg.addEventListener("pointerup", (event) => {
      try {
        if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
      } catch (error) { /* nothing captured */ }
    });
    svg.addEventListener("pointerleave", (event) => {
      try {
        if (!svg.hasPointerCapture(event.pointerId)) hide();
      } catch (error) { hide(); }
    });
    svg.addEventListener("pointercancel", hide);
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") { show(index < 0 ? 0 : index + 1); event.preventDefault(); }
      else if (event.key === "ArrowLeft") { show(index < 0 ? samples.length - 1 : index - 1); event.preventDefault(); }
      else if (event.key === "Home") { show(0); event.preventDefault(); }
      else if (event.key === "End") { show(samples.length - 1); event.preventDefault(); }
      else if (event.key === "Escape") hide();
    });
  }

  function stackSections() {
    return [...document.querySelectorAll("#stackViewport .section")].filter((section) => !section.hidden);
  }

  // Every measured result becomes one card in the deck. Sections hold the
  // cards in Page mode, so each lifted card gets a throwaway section wrapper
  // and the real section is hidden until the deck is released.
  function collectResultCards() {
    if (cardOrigins.size) return;
    const viewport = $("stackViewport");
    document.querySelectorAll("#stackViewport [data-result-key]").forEach((card) => {
      const proxy = document.createElement("section");
      proxy.className = "section stack-proxy";
      proxy.dataset.label = card.dataset.label || "";
      proxy.dataset.sectionId = (card.parentElement.closest(".section") || {}).id || "";
      proxy.dataset.tier = card.dataset.tier
        || (card.dataset.gold === "true" ? "gold" : card.dataset.good === "true" ? "silver" : "");
      const tier = proxy.dataset.tier;
      const score = Number(card.dataset.score);
      const bad = card.dataset.tone === "bad" || Boolean(card.querySelector(".status.bad"))
        || (has(score) && score < 50);
      proxy.dataset.state = tier === "gold" ? "gold" : tier === "silver" ? "silver"
        : bad ? "bad" : "plain";
      card.dataset.state = proxy.dataset.state;
      cardOrigins.set(card, { parent: card.parentElement, next: card.nextSibling, proxy });
      proxy.appendChild(card);
      viewport.appendChild(proxy);
    });
    document.querySelectorAll("#stackViewport > .section:not(.stack-proxy)").forEach((section) => {
      sectionHidden.set(section, section.hidden);
      section.hidden = true;
    });
  }

  function restoreResultCards() {
    // Reverse order: a card's saved "next" sibling may be another card that
    // has not been put back yet, and insertBefore would yank it from its proxy.
    [...cardOrigins.entries()].reverse().forEach(([card, origin]) => {
      card.classList.remove("stack-card");
      if (flyTimer) { clearTimeout(flyTimer); flyTimer = null; }
      resetTilt(card);
      clearDrag(card);
      origin.parent.insertBefore(card, origin.next);
      origin.proxy.remove();
    });
    cardOrigins.clear();
    sectionHidden.forEach((wasHidden, section) => { section.hidden = wasHidden; });
    sectionHidden.clear();
  }

  function initMode() {
    try {
      const stored = localStorage.getItem("ma-mode");
      state.stackMode = stored !== "page";
    } catch (error) {
      state.stackMode = true;
    }
    document.body.classList.toggle("stack-mode", state.stackMode);
    const button = $("btnCards");
    if (button) {
      button.setAttribute("aria-pressed", String(state.stackMode));
      button.textContent = state.stackMode ? "Cards" : "Page";
    }
    const controls = $("stackControls");
    if (controls) controls.hidden = !state.stackMode;
  }

  function setMode(next) {
    state.stackMode = next;
    try { localStorage.setItem("ma-mode", next ? "stack" : "page"); } catch (error) { /* optional */ }
    document.body.classList.toggle("stack-mode", next);
    const button = $("btnCards");
    if (button) {
      button.setAttribute("aria-pressed", String(next));
      button.textContent = next ? "Cards" : "Page";
    }
    if (!next) {
      restoreResultCards();
      stackSections().forEach((section) => {
        section.classList.remove("active");
        ["--stack-x", "--stack-y", "--stack-r", "--stack-s", "--stack-o", "--stack-z"].forEach((prop) => section.style.removeProperty(prop));
      });
    } else {
      collectResultCards();
      stackTo(state.stackIndex);
    }
    const controls = $("stackControls");
    if (controls) controls.hidden = !next || !stackSections().length;
    toggleShortcutHelp(false);
  }

  function celebrate(card) {
    const layer = $("celebration");
    if (!layer) return;
    const label = card.dataset.label || "Achievement";
    const gold = card.dataset.gold === "true";
    const silver = card.dataset.tier === "silver";
    haptic(gold ? [45, 55, 45, 70, 110] : silver ? [35, 50, 35] : [25, 40, 25]);
    playCelebrate(gold);
    const toast = document.createElement("div");
    toast.className = "achievement";
    toast.textContent = `${gold ? "Near perfect" : silver ? "Strong result" : "Achievement"} · ${label}`;
    layer.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);

    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cardBox = card.getBoundingClientRect();
    const layerBox = layer.getBoundingClientRect();
    const centerX = cardBox.left + cardBox.width / 2 - layerBox.left;
    const centerY = cardBox.top + cardBox.height / 2 - layerBox.top;
    const colors = gold ? ["#d4af37", "#f6e27a", "#fff4c2", "#ffdf6e"]
      : ["var(--foil-a)", "var(--foil-b)", "var(--foil-c)", "#ffffff"];

    // One fragment append and one timer per lifetime group: a gold burst used
    // to schedule 130 individual removals on every revisit.
    const fragment = document.createDocumentFragment();
    const groups = [];
    const group = (nodes, life) => groups.push({ nodes, life });

    if (gold) {
      const flash = document.createElement("span");
      flash.className = "flash";
      flash.style.setProperty("--x", `${centerX}px`);
      flash.style.setProperty("--y", `${centerY}px`);
      flash.style.setProperty("--color", colors[1]);
      fragment.appendChild(flash);
      group([flash], 1000);

      const rays = document.createElement("span");
      rays.className = "rays";
      rays.style.setProperty("--x", `${centerX}px`);
      rays.style.setProperty("--y", `${centerY}px`);
      rays.style.setProperty("--color", colors[1]);
      fragment.appendChild(rays);
      group([rays], 1600);

      const badge = document.createElement("span");
      badge.className = "hype-badge";
      badge.textContent = "NEAR PERFECT";
      fragment.appendChild(badge);
      group([badge], 2600);

      const bursts = [];
      for (let i = 0; i < 7; i += 1) {
        const burst = document.createElement("span");
        burst.className = "firework";
        burst.style.setProperty("--x", `${centerX + (Math.random() - 0.5) * layerBox.width * 0.7}px`);
        burst.style.setProperty("--y", `${centerY - 40 + (Math.random() - 0.5) * layerBox.height * 0.45}px`);
        burst.style.setProperty("--color", colors[i % colors.length]);
        burst.style.setProperty("--ring", `${170 + Math.round(Math.random() * 150)}px`);
        burst.style.setProperty("--delay", `${Math.round(Math.random() * 420)}ms`);
        fragment.appendChild(burst);
        bursts.push(burst);
      }
      group(bursts, 2200);

      const balloons = [];
      for (let i = 0; i < 11; i += 1) {
        const balloon = document.createElement("span");
        balloon.className = "balloon";
        balloon.style.setProperty("--x", `${Math.round(Math.random() * layerBox.width)}px`);
        balloon.style.setProperty("--w", `${26 + Math.round(Math.random() * 20)}px`);
        balloon.style.setProperty("--color", colors[i % colors.length]);
        balloon.style.setProperty("--rise", `${Math.round(layerBox.height + 160)}px`);
        balloon.style.setProperty("--delay", `${Math.round(Math.random() * 700)}ms`);
        balloon.style.setProperty("--life", `${3 + Math.random() * 1.4}s`);
        fragment.appendChild(balloon);
        balloons.push(balloon);
      }
      group(balloons, 4600);
    }

    const pieces = gold ? 110 : 46;
    const confetti = [];
    for (let i = 0; i < pieces; i += 1) {
      const piece = document.createElement("span");
      piece.className = "confetti";
      const fromCorner = gold && i % 3 === 0;
      piece.style.setProperty("--x", `${fromCorner
        ? (i % 2 ? 30 : layerBox.width - 30)
        : centerX + (Math.random() - 0.5) * layerBox.width * 0.8}px`);
      piece.style.setProperty("--y", `${fromCorner ? layerBox.height - 20 : centerY + (Math.random() - 0.5) * layerBox.height * 0.5}px`);
      piece.style.setProperty("--dx", `${Math.round((fromCorner ? (centerX - (i % 2 ? 30 : layerBox.width - 30)) * 0.7 : (Math.random() - 0.5) * 620))}px`);
      piece.style.setProperty("--dy", `${Math.round(-120 - Math.random() * (fromCorner ? 520 : 300))}px`);
      piece.style.setProperty("--rot", `${Math.round(Math.random() * 720 - 360)}deg`);
      piece.style.setProperty("--size", `${5 + Math.round(Math.random() * 9)}px`);
      piece.style.setProperty("--color", colors[i % colors.length]);
      piece.style.setProperty("--delay", `${Math.round(Math.random() * (gold ? 480 : 260))}ms`);
      piece.style.setProperty("--life", `${2.2 + Math.random() * 0.9}s`);
      fragment.appendChild(piece);
      confetti.push(piece);
    }
    group(confetti, 3400);

    layer.appendChild(fragment);
    groups.forEach(({ nodes, life }) => setTimeout(() => nodes.forEach((node) => node.remove()), life));
  }

  function stackTo(index) {
    const sections = stackSections();
    if (!sections.length) return;
    const previous = sections[state.stackIndex];
    state.stackIndex = Math.max(0, Math.min(sections.length - 1, (index + sections.length) % sections.length));
    if (previous && previous !== sections[state.stackIndex]) resetTilt(previous);
    sections.forEach((section, position) => {
      const distance = (position - state.stackIndex + sections.length) % sections.length;
      const depth = Math.min(distance, 3);
      section.classList.toggle("active", distance === 0);
      section.style.setProperty("--stack-x", `${depth * 6}px`);
      section.style.setProperty("--stack-y", `${depth * 6}px`);
      section.style.setProperty("--stack-r", `${depth * 0.9}deg`);
      section.style.setProperty("--stack-s", String(1 - depth * 0.01));
      section.style.setProperty("--stack-o", distance <= 3 ? String(1 - depth * 0.14) : "0");
      section.style.setProperty("--stack-z", String(sections.length - depth));
    });
    const active = sections[state.stackIndex];
    active.scrollTop = 0;
    const celebrationTarget = [...active.querySelectorAll("[data-result-key]")]
      .find((card) => card.dataset.good === "true");
    if (celebrationTarget) {
      const signature = `${state.navSeq}:${celebrationTarget.dataset.resultKey}`;
      if (signature !== state.lastCelebration) {
        state.lastCelebration = signature;
        celebrate(celebrationTarget);
      }
    }
    const fallbackTitles = { today: "Today", markers: "Health markers", sources: "Data sources" };
    const title = active.dataset.label || active.querySelector("h2")?.textContent || fallbackTitles[active.id] || active.id;
    $("pageTitle").textContent = title;
    const live = $("stackLive");
    if (live) live.textContent = `Card ${state.stackIndex + 1} of ${sections.length}: ${title}`;
    const count = $("stackCount");
    if (count) count.textContent = `${state.stackIndex + 1} / ${sections.length}`;
    document.querySelectorAll(".nav a, .tabbar a").forEach((link) =>
      link.setAttribute("aria-current", String(link.getAttribute("href") === `#${active.dataset.sectionId || active.id}`))
    );
    const next = sections[(state.stackIndex + 1) % sections.length];
    const nextLabel = $("stackNextLabel");
    if (nextLabel) {
      const nextTitle = next.dataset.label || next.querySelector("h2")?.textContent || next.id;
      nextLabel.textContent = `Next: ${nextTitle}`;
    }
    const rail = $("stackRail");
    if (rail) rail.style.width = `${((state.stackIndex + 1) / sections.length) * 100}%`;

    if (active.dataset.state === "bad" && !state.badSeen.has(active.dataset.label)) {
      state.badSeen.add(active.dataset.label);
      if (state.audio && state.sound) playTone(150, 0, 0.16, 0.035, "sine");
      haptic([40, 60, 40]);
    }
    const controls = $("stackControls");
    if (controls) controls.hidden = false;
  }

  function cycleStack(delta) {
    state.navSeq += 1;
    playMove(delta > 0);
    haptic(12);
    stackTo(state.stackIndex + delta);
  }

  function goToSection(id) {
    const sections = stackSections();
    const index = sections.findIndex((section) => section.id === id || section.dataset.sectionId === id);
    if (index >= 0) {
      state.navSeq += 1;
      playMove(index > state.stackIndex);
      haptic(12);
      stackTo(index);
      return;
    }
    // Text-only sections are not deck cards: show them in the scrolling view.
    const section = $(id);
    if (section) {
      setMode(false);
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function applyTilt(card, x, y, foils) {
    if (reduceMotion()) return;
    const tx = clamp(y, -14, 14);
    const ty = clamp(x, -14, 14);
    card.style.setProperty("--tilt-x", `${tx.toFixed(1)}deg`);
    card.style.setProperty("--tilt-y", `${ty.toFixed(1)}deg`);
    card.style.setProperty("--shine-x", `${Math.round(50 + ty * 2.6)}%`);
    card.style.setProperty("--shine-y", `${Math.round(50 - tx * 2.6)}%`);
    card.style.setProperty("--hue", `${Math.round(ty * 5)}deg`);
    card.classList.add("charged");
    (foils || card.querySelectorAll(".foil")).forEach((foil) => {
      foil.style.setProperty("--tilt-x", `${tx.toFixed(1)}deg`);
      foil.style.setProperty("--tilt-y", `${ty.toFixed(1)}deg`);
      foil.style.setProperty("--shine-x", `${Math.round(50 + ty * 2.6)}%`);
      foil.style.setProperty("--shine-y", `${Math.round(50 - tx * 2.6)}%`);
      foil.style.setProperty("--hue", `${Math.round(ty * 5)}deg`);
      foil.classList.add("charged", "dragging");
    });
  }

  function resetTilt(card) {
    if (!card) return;
    card.classList.remove("charged");
    card.style.setProperty("--tilt-x", "0deg");
    card.style.setProperty("--tilt-y", "0deg");
    card.style.setProperty("--shine-x", "50%");
    card.style.setProperty("--shine-y", "50%");
    card.style.setProperty("--hue", "0deg");
    card.querySelectorAll(".foil").forEach((foil) => {
      foil.classList.remove("charged", "dragging");
      foil.style.setProperty("--tilt-x", "0deg");
      foil.style.setProperty("--tilt-y", "0deg");
      foil.style.setProperty("--shine-x", "50%");
      foil.style.setProperty("--shine-y", "50%");
      foil.style.setProperty("--hue", "0deg");
    });
  }

  function setDrag(card, dx, dy, armed) {
    card.style.setProperty("--drag-x", `${clamp(dx * 0.75, -150, 150).toFixed(1)}px`);
    card.style.setProperty("--drag-y", `${clamp(dy * 0.22, -55, 55).toFixed(1)}px`);
    card.style.setProperty("--drag-r", `${clamp(dx * 0.07, -16, 16).toFixed(1)}deg`);
    card.classList.add("following");
    if (armed) {
      if (!card.querySelector(".swipe-cue")) {
        const cue = document.createElement("span");
        cue.className = "swipe-cue";
        cue.setAttribute("aria-hidden", "true");
        card.appendChild(cue);
      }
      card.querySelector(".swipe-cue").textContent = dx < 0 ? "Release to move →" : "← Release to move";
      card.classList.add("swipe-ready");
    } else {
      card.classList.remove("swipe-ready");
      const cue = card.querySelector(".swipe-cue");
      if (cue) cue.remove();
    }
  }

  function clearDrag(card, fly) {
    if (!card) return;
    card.classList.remove("following", "swipe-ready");
    const cue = card.querySelector(".swipe-cue");
    if (cue) cue.remove();
    card.style.setProperty("--drag-x", `${fly || 0}px`);
    card.style.setProperty("--drag-y", "0px");
    card.style.setProperty("--drag-r", fly ? `${fly < 0 ? -28 : 28}deg` : "0deg");
  }

  function bindDeckDrag() {
    const viewport = $("stackViewport");
    let drag = null;
    viewport.addEventListener("pointerdown", (event) => {
      if (!state.stackMode || event.button !== 0) return;
      if (event.target.closest(".info, a, details, input, select, .stack-controls, .source-picker")) return;
      const card = stackSections()[state.stackIndex];
      if (!card || !card.classList.contains("stack-proxy")) return;
      if (flyTimer) { clearTimeout(flyTimer); flyTimer = null; }
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, card,
        foils: card.querySelectorAll(".foil"), at: performance.now(), armed: false };
      // Pointerdown on text would otherwise start a desktop text selection.
      event.preventDefault();
      const selection = window.getSelection && window.getSelection();
      if (selection) selection.removeAllRanges();
      document.body.classList.add("deck-dragging");
      if (!state.gyro) { haptic(8); ensureAudio(); playTone(760, 0, 0.04, 0.012); }
      // A foil child already captured the pointer; stealing it would leave
      // its own hover state stuck at the down-tilt maximum.
      if (!event.target.closest(".foil")) {
        try { viewport.setPointerCapture(event.pointerId); } catch (error) { /* optional */ }
      }
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!drag || drag.id !== event.pointerId || state.gyro) return;
      event.preventDefault();
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      const armed = coarsePointer() && Math.abs(dx) > 72;
      if (armed && !drag.armed) haptic(18);
      drag.armed = armed;
      drag.lastX = dx;
      if (!reduceMotion()) {
        applyTilt(drag.card, dx / 9, -dy / 9, drag.foils);
        setDrag(drag.card, dx, dy, armed);
      }
    });
    const end = (event) => {
      document.body.classList.remove("deck-dragging");
      if (drag) {
        const cancelled = event.type === "pointercancel";
        const dx = (event.clientX ?? drag.x + (drag.lastX || 0)) - drag.x;
        const dt = Math.max(1, performance.now() - drag.at);
        const commit = !cancelled && coarsePointer()
          && (drag.armed || (Math.abs(dx) > 72 && Math.abs(dx) / dt > 0.35));
        resetTilt(drag.card);
        if (commit) {
          clearDrag(drag.card, dx < 0 ? -Math.round(window.innerWidth) : Math.round(window.innerWidth));
          const flown = drag.card;
          flyTimer = setTimeout(() => {
            flyTimer = null;
            if (!flown.isConnected || !state.stackMode) return;
            clearDrag(flown);
            cycleStack(dx < 0 ? 1 : -1);
          }, 170);
        } else {
          clearDrag(drag.card);
        }
      }
      drag = null;
    };
    viewport.addEventListener("pointerup", end);
    viewport.addEventListener("pointercancel", end);
  }

  function onDeviceOrientation(event) {
    if (!state.gyro || !state.stackMode || reduceMotion() || event.beta == null || event.gamma == null) return;
    const card = stackSections()[state.stackIndex];
    if (card) applyTilt(card, event.gamma / 2.6, (event.beta - 45) / 3.2);
  }

  async function toggleGyro() {
    const button = $("btnGyro");
    if (state.gyro) {
      state.gyro = false;
      window.removeEventListener("deviceorientation", onDeviceOrientation);
      resetTilt(stackSections()[state.stackIndex]);
      if (button) button.setAttribute("aria-pressed", "false");
      return;
    }
    const request = window.DeviceOrientationEvent && window.DeviceOrientationEvent.requestPermission;
    try {
      if (typeof request === "function" && await request() !== "granted") return;
      state.gyro = true;
      window.addEventListener("deviceorientation", onDeviceOrientation);
      if (button) button.setAttribute("aria-pressed", "true");
    } catch (error) { /* permission declined or sensor unavailable */ }
  }

  function toggleShortcutHelp(force) {
    const panel = $("shortcutHelp");
    if (!panel) return;
    const open = typeof force === "boolean" ? force : panel.hidden;
    panel.hidden = !open;
    const button = $("btnHelp");
    if (button) button.setAttribute("aria-expanded", String(open));
  }

  function toggleSound() {
    state.sound = !state.sound;
    try { localStorage.setItem("ma-sound", state.sound ? "on" : "off"); } catch (error) { /* optional */ }
    const button = $("btnSound");
    if (button) {
      button.setAttribute("aria-pressed", String(state.sound));
      button.title = state.sound ? "Mute sound" : "Unmute sound";
    }
    if (state.sound && ensureAudio()) playMove();
  }

  function initSound() {
    try { state.sound = localStorage.getItem("ma-sound") !== "off"; } catch (error) { /* optional */ }
    const button = $("btnSound");
    if (button) {
      button.setAttribute("aria-pressed", String(state.sound));
      button.title = state.sound ? "Mute sound" : "Unmute sound";
    }
  }

  function bindFoilTilt() {
    document.querySelectorAll(".foil").forEach((card) => {
      if (card.dataset.tiltBound) return;
      card.dataset.tiltBound = "1";
      let down = false;

      const update = (event) => {
        const box = card.getBoundingClientRect();
        if (!box.width || !box.height) return;
        const x = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
        const y = Math.max(0, Math.min(1, (event.clientY - box.top) / box.height));
        const max = down ? 9 : 5;
        card.style.setProperty("--tilt-x", `${((0.5 - y) * 2 * max).toFixed(1)}deg`);
        card.style.setProperty("--tilt-y", `${((x - 0.5) * 2 * max).toFixed(1)}deg`);
        card.style.setProperty("--shine-x", `${Math.round(x * 100)}%`);
        card.style.setProperty("--shine-y", `${Math.round(y * 100)}%`);
        card.style.setProperty("--hue", `${Math.round((x - 0.5) * 50)}deg`);
      };

      const reset = () => {
        down = false;
        card.classList.remove("dragging");
        card.style.setProperty("--tilt-x", "0deg");
        card.style.setProperty("--tilt-y", "0deg");
        card.style.setProperty("--shine-x", "50%");
        card.style.setProperty("--shine-y", "50%");
        card.style.setProperty("--hue", "0deg");
      };

      card.addEventListener("pointermove", update);
      card.addEventListener("pointerdown", (event) => {
        // Capturing on an interactive child would retarget its click to the
        // card, so the ⓘ buttons would never open their help popover.
        if (event.target.closest("button, a, input, select, details, .info")) return;
        down = true;
        card.classList.add("dragging");
        try { card.setPointerCapture(event.pointerId); } catch (error) { /* not available */ }
        update(event);
      });
      card.addEventListener("pointerup", (event) => {
        try { card.releasePointerCapture(event.pointerId); } catch (error) { /* not captured */ }
        reset();
      });
      card.addEventListener("pointercancel", reset);
      card.addEventListener("pointerleave", () => { if (!down) reset(); });
    });
  }

  function renderSleep(data) {
    const sleep = (data.today && data.today.sleep) || {};
    const circ = data.circadian || {};
    const jet = (data.markers && data.markers.social_jetlag) || {};
    const history = (data.history && data.history.sleep) || [];
    if (!has(sleep.minutes) && !history.length) {
      slot("sleep").innerHTML = `<p class="muted">No sleep recorded in this sync.</p>`;
      slot("sleepNights").innerHTML = `<p class="muted">No recent nights recorded.</p>`;
      slot("sleepTiming").innerHTML = `<p class="muted">No timing recorded.</p>`;
      return;
    }

    const stages = sleep.stages || {};
    const stageDefs = [
      ["Deep", "deep", "--sleep-deep"],
      ["REM", "rem", "--sleep-rem"],
      ["Light", "light", "--sleep-light"],
      ["Awake", "awake", "--sleep-awake"],
    ].filter(([, key]) => has(stages[key]));
    const total = stageDefs.reduce((sum, [, key]) => sum + stages[key], 0);

    const kv = [
      ["Fell asleep", sleep.bed],
      ["Woke", sleep.wake],
      ["Efficiency", has(sleep.efficiency) ? `${num(sleep.efficiency)}%` : null],
      ["Need tonight", sleep.need_minutes ? hm(sleep.need_minutes) : null],
      ["Sleep debt, 14 nights", has(sleep.debt_minutes) ? (sleep.debt_minutes ? hm(sleep.debt_minutes) : "None") : null],
      ["Bedtime target", circ.bedtime_target],
      ["Consistency", has(circ.alignment_pct) ? `${circ.alignment_pct}% of nights within 45 min` : null],
    ].filter(([, v]) => has(v) && v !== "");

    const recent = history.slice(-7).reverse();
    const asleep = recent.map((r) => r.minutes).filter(has);
    const spanText = asleep.length ? `${hm(Math.min(...asleep))} – ${hm(Math.max(...asleep))}` : null;

    let timing = "";
    if (history.some((r) => has(r.bed_minutes))) {
      timing = `<div class="card">
        <div class="card-head"><h3>Sleep timing${info("jetlag")}</h3>${jet.available ? status(jet.band, `Shift ${hm(jet.minutes)}`) : ""}</div>
        ${readouts([
          ["Median onset", circ.median_onset],
          ["Typical wake", circ.typical_wake],
          ["Onset spread", has(circ.spread_minutes) ? `${circ.spread_minutes} min` : null],
          ["Weekend shift", jet.available ? `${hm(jet.minutes)} ${jet.later_on_free_days ? "later" : "earlier"}` : null],
          ["Nights compared", jet.available ? `${jet.work_nights} weekdays · ${jet.free_nights} weekends` : null],
        ])}
        ${jet.available ? `<p class="note">${esc(jet.band.plain)}</p>${study(jet.evidence)}` : ""}
      </div>`;
    }

    slot("sleep").innerHTML = `<div class="card">
      <div class="label">Last night${info("stages")}</div>
      <div class="figure">${hm(sleep.minutes)}</div>
      ${has(sleep.score) ? `<div class="sub">Score ${num(sleep.score)} of 100 · ${esc(bandLabel(sleep.band))}</div>` : ""}
      ${total ? `<div class="stagebar" role="img" aria-label="Sleep stages">${stageDefs
        .map(([, key, color]) => `<i style="width:${(stages[key] / total) * 100}%;background:var(${color})"></i>`).join("")}</div>
        <div class="legend">${stageDefs
          .map(([label, key, color]) => `<span><i style="background:var(${color})"></i>${label} <b>${hm(stages[key])}</b></span>`).join("")}</div>` : ""}
      ${kv.length ? `<dl class="kv">${kv.map(([k, v]) => `<div><dt>${k}${info({ "Efficiency": "efficiency", "Sleep debt, 14 nights": "debt", "Consistency": "consistency" }[k])}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
    </div>`;

    // Several nights belong to one card, not one card per night.
    const bestEfficiency = recent.reduce((best, r) =>
      Math.max(best, has(r.efficiency) ? Number(r.efficiency) : 0), 0);
    const nightsGold = bestEfficiency >= 95;
    const nightsGood = bestEfficiency >= 90;
    const nightsTier = nightsGold ? "gold" : nightsGood ? "silver" : "";
    slot("sleepNights").innerHTML = `<div class="card nights-card${nightsGood ? " foil" : ""}${nightsGold ? " gold" : ""}${nightsTier === "silver" ? " silver" : ""}"
      data-good="${nightsGood}" data-gold="${nightsGold}" data-tier="${nightsTier}"
      data-score="${bestEfficiency}" data-result-key="recent-nights" data-label="Recent nights">
      <div class="card-head"><h3>Recent nights</h3><span class="faint small">Last ${recent.length}</span></div>
      ${recent.length ? `<div class="nights-list">${recent.map((r) => {
        const efficiency = has(r.efficiency) ? Number(r.efficiency) : null;
        return `<div class="night-row">
          <span class="night-date">${esc(shortDate(r.date))}</span>
          <span class="night-time">${hm(r.minutes)}</span>
          <span class="night-eff">${efficiency === null ? DASH : `${num(efficiency)}%`}</span>
          <span class="night-bar"><i style="width:${efficiency === null ? 0 : clamp(efficiency, 0, 100)}%"></i></span>
        </div>`;
      }).join("")}</div>` : `<p class="muted">No recent nights recorded.</p>`}
      ${spanText ? `<p class="note">Across these nights, sleep ran from ${spanText}.</p>` : ""}
    </div>`;

    slot("sleepTiming").innerHTML = timing || `<p class="muted">No timing recorded.</p>`;
  }

  /* --------------------------------------------------------------- heart -- */
  function renderHeart(data) {
    const h = data.history || {};
    const t = data.today || {};
    const b = data.baselines || {};
    const hr = h.hr_intraday || [];
    const skin = (h.skin_temp || []).slice(-60);

    const avg = (v) => v.length ? Math.round((v.reduce((a, c) => a + c, 0) / v.length) * 10) / 10 : null;
    const hrVals = hr.map((r) => r.bpm).filter(has);
    const skinVals = skin.map((r) => r.delta_c).filter(has);
    const hrvWeek = (h.hrv || []).slice(-7).map((r) => r.ms).filter(has);
    const rhrWeek = (h.rhr || []).slice(-7).map((r) => r.bpm).filter(has);

    // Vitals already shows tonight's readings; this section adds only their
    // context against the athlete's own baseline.
    const signals = [];
    if (has(t.hrv && t.hrv.ms)) signals.push({
      name: "HRV", help: "hrv", value: `${num(t.hrv.ms)} ms`, band: t.hrv.band,
      read: has(b.hrv_ms)
        ? `Median ${num(b.hrv_ms)} ms · week ${num(avg(hrvWeek), 1)} ms`
        : `Week ${num(avg(hrvWeek), 1)} ms`,
    });
    if (has(t.rhr && t.rhr.bpm)) signals.push({
      name: "Resting HR", help: "rhr", value: `${num(t.rhr.bpm)} bpm`, band: t.rhr.band,
      read: has(b.rhr_bpm)
        ? `Median ${num(b.rhr_bpm)} bpm · week ${num(avg(rhrWeek), 1)} bpm`
        : `Week ${num(avg(rhrWeek), 1)} bpm`,
    });

    const cards = [];
    if (signals.length) cards.push(`<div class="card span-2">
      <div class="card-head"><h3>Baseline context</h3><span class="faint small">Overnight against your own median</span></div>
      <div class="signal-list">${signals.map((s) => `<div class="signal-row">
        <span class="signal-name">${s.name}${info(s.help)}</span>
        <b>${s.value}</b>
        <span class="muted">${esc(s.read)}</span>
        ${status(s.band)}
      </div>`).join("")}</div>
    </div>`);
    if (skinVals.length) cards.push(`<div class="card">
      <div class="card-head"><h3>Skin temperature${info("skin")}</h3><span class="faint small">${skinVals.length} nights</span></div>
      <div class="figure">${signed(skinVals[skinVals.length - 1], 1, "")}<small>°C vs baseline</small></div>
      ${readouts([
        ["Nightly range", `${signed(Math.min(...skinVals), 1, " °C")} to ${signed(Math.max(...skinVals), 1, " °C")}`],
        ["Mean", `${signed(avg(skinVals), 1, " °C")}`],
      ])}
    </div>`);
    if (hrVals.length) cards.push(`<div class="card">
      <div class="card-head"><h3>Heart rate, 24 hours</h3><span class="faint small">${hrVals.length} hourly readings</span></div>
      ${readouts([
        ["Lowest", `${num(Math.min(...hrVals))} bpm`],
        ["Highest", `${num(Math.max(...hrVals))} bpm`],
        ["Latest", `${num(hrVals[hrVals.length - 1])} bpm`],
        ["Mean", `${num(avg(hrVals))} bpm`],
      ])}
    </div>`);

    slot("heart").innerHTML = signals.length
      ? `<div class="card span-2">
          <div class="card-head"><h3>Baseline context</h3><span class="faint small">Overnight against your own median</span></div>
          <div class="signal-list">${signals.map((s) => `<div class="signal-row">
            <span class="signal-name">${s.name}${info(s.help)}</span>
            <b>${s.value}</b>
            <span class="muted">${esc(s.read)}</span>
            ${status(s.band)}
          </div>`).join("")}</div>
        </div>`
      : `<p class="muted">No heart data in this sync.</p>`;
    const detail = cards.slice(1);
    slot("heartDetail").innerHTML = detail.length
      ? `<div class="grid cols-2">${detail.join("")}</div>`
      : `<p class="muted">No extra heart detail in this sync.</p>`;
  }

  /* ------------------------------------------------------------- markers -- */
  const study = (ev) =>
    ev && ev.cite
      ? `<details class="plain study"><summary>${esc(ev.cite)}</summary><div class="small muted">${esc(ev.found)} <span class="faint">Limits: ${esc(ev.not)}</span></div></details>`
      : "";

  function renderMarkers(data) {
    const m = data.markers || {};
    const hs = m.hrv_status || {};
    const cards = [];

    if (hs.available) {
      const [lo, hi] = hs.range_ms;
      cards.push(`<div class="card">
        <div class="card-head"><h3>HRV status${info("hrv_status")}</h3>${status(hs.band)}</div>
        <div class="figure">${num(hs.week_ms, 1)}<small>ms, 7-night mean</small></div>
        ${readouts([
          ["Your usual range", `${num(lo, 1)}–${num(hi, 1)} ms`],
          ["Nights in the week", num(hs.week_nights)],
          ["Baseline nights", num(hs.baseline_nights)],
          ["Night-to-night variation", has(hs.cv_pct) ? `${num(hs.cv_pct, 1)}%` : null],
        ])}
        <p class="note">${esc(hs.band.plain)}</p>
        ${study(hs.evidence)}
      </div>`);
    }

    const rows = [];
    if (m.vo2max) rows.push({
      help: "vo2", name: "Cardio fitness",
      value: `${m.vo2max.estimated ? "≈ " : ""}${num(m.vo2max.value, 1)} ml/kg/min`,
      detail: `${num(m.vo2max.mets, 1)} METs${has(m.vo2max.change_mets) ? ` · ${signed(m.vo2max.change_mets, 1, " MET")} since ${shortDate(m.vo2max.since)}` : ""}`,
      ev: m.vo2max.evidence,
    });
    if (m.rhr_trend) rows.push({
      help: "rhr_trend", name: "Resting heart rate, 30 days",
      value: `${num(m.rhr_trend.mean_30d, 1)} bpm`,
      detail: `${signed(m.rhr_trend.change, 1, " bpm")} vs the 30 days before`,
      ev: m.rhr_trend.evidence,
    });
    if (m.steps && has(m.steps.mean_28d)) {
      const range = m.steps.plateau;
      rows.push({
        help: "steps", name: "Daily steps, 28 days",
        value: num(m.steps.mean_28d),
        detail: range
          ? `Benefit levelled off at ${num(range[0])}–${num(range[1])} for your age group`
          : `Benefit levelled off at 8,000–10,000 under 60, 6,000–8,000 over 60`,
        ev: m.steps.evidence,
      });
    }
    if (has(m.bmi)) rows.push({
      help: "bmi", name: "Body mass index",
      value: num(m.bmi, 1),
      detail: "From the height and weight in your profile. WHO bands: 18.5–24.9 healthy, 25–29.9 overweight, 30+ obese",
      ev: null,
    });

    if (rows.length) cards.push(`<div class="card">
      <div class="card-head"><h3>Heart and metabolic markers</h3></div>
      ${rows.map((r) => `<div class="marker">
        <div class="marker-head"><span>${esc(r.name)}${info(r.help)}</span><b class="tnum">${esc(r.value)}</b></div>
        <div class="sub">${esc(r.detail)}</div>
        ${study(r.ev)}
      </div>`).join("")}
      <p class="note">Research context, not a diagnosis or a personal risk estimate. Insulin resistance and blood glucose are not estimated:
        ${m.metabolic_evidence ? esc(m.metabolic_evidence.not) : "they need blood tests."}</p>
    </div>`);

    $("markers").hidden = !cards.length;
    slot("markers").innerHTML = cards.length ? `<div class="grid ${cards.length > 1 ? "cols-2" : ""}">${cards.join("")}</div>` : "";
  }

  /* ------------------------------------------------------------ activity -- */
  function renderActivity(data) {
    const t = data.today || {};
    const load = data.load || {};
    const h = data.history || {};
    const steps = t.steps || {};
    const active = t.active_minutes || {};
    const week = active.week || {};
    const calories = t.calories || {};
    const exerciseLive = data.data_quality?.metrics?.exercise?.source === "live";

    const stats = [];
    if (has(steps.count)) stats.push(`<div class="tile">
      <div class="tile-name">Steps today</div>
      <div class="tile-value">${num(steps.count)}</div>
      <div class="tile-meta">of ${num(steps.goal)} target</div>
      <div class="progress"><i class="${steps.pct >= 100 ? "done" : ""}" style="width:${Math.min(100, steps.pct || 0)}%"></i></div>
    </div>`);
    if (has(week.minutes)) stats.push(`<div class="tile">
      <div class="tile-name">Active minutes, week${info("active")}</div>
      <div class="tile-value">${num(week.minutes)}</div>
      <div class="tile-meta">of ${num(week.target)} min${week.days && week.days < 7 ? ` · day ${num(week.days)} of 7` : ""}</div>
      <div class="progress"><i class="${week.pct >= 100 ? "done" : ""}" style="width:${Math.min(100, week.pct || 0)}%"></i></div>
    </div>`);
    if (has(calories.today)) stats.push(`<div class="tile">
      <div class="tile-name">Calories today</div>
      <div class="tile-value">${num(calories.today)}</div>
      ${has(calories.mean_7d) ? `<div class="tile-meta">7-day avg ${num(calories.mean_7d)}</div>` : ""}
    </div>`);
    if (has(steps.mean_7d)) stats.push(`<div class="tile">
      <div class="tile-name">Steps, 7-day average</div>
      <div class="tile-value">${num(steps.mean_7d)}</div>
      ${has(steps.mean_28d) ? `<div class="tile-meta">28-day avg ${num(steps.mean_28d)}</div>` : ""}
    </div>`);

    const loadCard = has(load.acwr) && exerciseLive ? `<div class="card">
      <div class="card-head"><h3>Training load${info("load")}</h3>${status(load.acwr_band)}</div>
      <div class="figure">${load.acwr.toFixed(2)}<small>acute : chronic</small></div>
      ${readouts([
        ["Last 7 days", `${num(load.acute_minutes)} min`],
        ["Usual week", `${num(load.chronic_minutes)} min`],
        ["Sessions, 28 days", num(load.sessions_28d)],
      ])}
      ${load.acwr_band && load.acwr_band.plain ? `<p class="note">${esc(load.acwr_band.plain)}</p>` : ""}
    </div>` : "";

    const sessions = exerciseLive ? (h.exercise || []).filter((s) => s.date) : [];
    const mix = (data.markers && data.markers.intensity) || {};
    const mixCard = mix.available ? `<div class="card">
      <div class="card-head"><h3>Aerobic vs high intensity${info("intensity")}</h3>${status(mix.band)}</div>
      <div class="figure">${num(100 - mix.pct_hard)}<small>% easy</small></div>
      ${readouts([
        ["Aerobic", `${hm(mix.easy_minutes)} · ${num(100 - mix.pct_hard)}%`],
        ["High intensity", `${hm(mix.hard_minutes)} · ${num(mix.pct_hard)}%`],
        ["Workouts", `${num(mix.sessions)} in ${num(mix.window_days)} days`],
      ])}
      ${study(mix.evidence)}
    </div>` : "";

    const trainedDays = new Set(sessions.map((s) => s.date)).size;
    const totalMinutes = sessions.reduce((n, s) => n + (Number(s.minutes) || 0), 0);
    const avgSession = sessions.length ? totalMinutes / sessions.length : null;
    const longest = Math.max(0, ...sessions.map((s) => Number(s.minutes) || 0));
    const consistency = exerciseLive && sessions.length ? `<div class="card">
      <div class="card-head"><h3>Training record</h3><span class="faint small">History</span></div>
      ${readouts([
        ["Sessions recorded", num(sessions.length)],
        ["Days trained", num(trainedDays)],
        ["Average session", has(avgSession) ? hm(avgSession) : DASH],
        ["Longest session", has(longest) ? hm(longest) : DASH],
        ["Total time", hm(totalMinutes)],
        ["Last 28 days", `${num(load.sessions_28d)} sessions`],
      ])}
    </div>` : "";

    // Latest workout: every measurement the API sent, plus a comparison with
    // recent sessions. No chart; all of it is numbers and short tables.
    const te = (data.markers && data.markers.training_effect) || {};
    // Some views report only a count when training effect is unavailable;
    // never treat that number as a list of sessions.
    const teSessions = Array.isArray(te.sessions) ? te.sessions : [];
    const teByDate = {};
    teSessions.forEach((row) => { teByDate[row.date] = row; });
    const gauge = (value, color) => `<div class="te-gauge" role="img" aria-label="${num(value, 1)} of 5">
      ${[0, 1, 2, 3, 4].map((i) => `<i style="--c:${color}"><b style="width:${Math.max(0, Math.min(1, value - i)) * 100}%"></b></i>`).join("")}
    </div>`;
    const workoutName = (row) => esc(row.name || (row.type || "Workout").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));
    const dated = sessions.slice().sort((a, b) => a.date.localeCompare(b.date));
    const latest = dated[dated.length - 1];
    const paceOf = (row) => has(row.pace_s_per_m)
      ? row.pace_s_per_m * 1000 / 60
      : has(row.distance_m) && row.distance_m && has(row.minutes) && row.minutes
        ? row.minutes / (row.distance_m / 1000)
        : null;
    const meanOf = (values) => values.length >= 2 ? values.reduce((a, c) => a + c, 0) / values.length : null;

    let latestCard = "";
    if (exerciseLive && latest) {
      const sameType = dated.slice(0, -1).filter((row) => row.type === latest.type);
      const peers = (sameType.length >= 2 ? sameType : dated.slice(0, -1)).slice(-8);
      const peerLabel = sameType.length >= 2
        ? `your last ${peers.length} ${(latest.type || "session").replace(/_/g, " ")} sessions`
        : `your last ${peers.length} sessions`;
      const values = (key) => peers.map((row) => row[key]).filter(has);
      const paceValues = peers.map(paceOf).filter(has);
      const compareRows = [];
      const addCompare = (label, current, peerValues, format, digits, suffix) => {
        if (!has(current)) return;
        const peer = meanOf(peerValues);
        if (peer === null) return;
        compareRows.push(`<div class="data-tr compare-tr">
          <span>${label}</span><b>${format(current)}</b><span>${format(peer)}</span>
          <span class="diff">${signed(current - peer, digits, suffix)}</span>
        </div>`);
      };
      addCompare("Duration", latest.minutes, values("minutes"), (v) => hm(v), 0, " min");
      addCompare("Average HR", latest.avg_hr, values("avg_hr"), (v) => `${num(v)} bpm`, 0, " bpm");
      addCompare("Calories", latest.calories, values("calories"), (v) => `${num(v)} kcal`, 0, " kcal");
      addCompare("Distance", latest.distance_m, values("distance_m"), (v) => `${num(v)} m`, 0, " m");
      addCompare("Steps", latest.steps, values("steps"), (v) => num(v), 0, "");
      addCompare("Pace", paceOf(latest), paceValues, (v) => `${v.toFixed(1)} min/km`, 1, " min/km");

      const mob = latest.mobility || {};
      const pace = paceOf(latest);
      const statPairs = [
        ["Started", latest.start_local, "Local start"],
        ["Duration", has(latest.minutes) ? hm(latest.minutes) : null, "This session"],
        ["Average HR", has(latest.avg_hr) ? `${num(latest.avg_hr)} bpm` : null, "Whole session"],
        ["Calories", has(latest.calories) ? `${num(latest.calories)} kcal` : null, "Session total"],
        ["Distance", has(latest.distance_m) ? `${num(latest.distance_m)} m` : null, "Session total"],
        ["Steps", has(latest.steps) ? num(latest.steps) : null, "Session total"],
        ["Active zone min", has(latest.active_zone_minutes) ? `${num(latest.active_zone_minutes)} min` : null, "Reported by device"],
        ["Elevation", has(latest.elevation_m) ? `${num(latest.elevation_m)} m` : null, "Gain"],
        ["Run VO₂ max", has(latest.run_vo2max) ? `${num(latest.run_vo2max, 1)} ml/kg/min` : null, "Running estimate"],
        [has(latest.pace_s_per_m) ? "Pace" : "Pace (from distance)", has(pace) ? `${pace.toFixed(1)} min/km` : null, has(latest.pace_s_per_m) ? "Reported by device" : "Calculated"],
        ["Speed", has(latest.speed_kmh) ? `${num(latest.speed_kmh, 1)} km/h` : null, "Reported by device"],
        ["Swim lengths", has(latest.swim_lengths) ? num(latest.swim_lengths) : null, "Pool workout"],
        ["Cadence", has(mob.cadence_spm) ? `${num(mob.cadence_spm)} spm` : null, "Running form"],
        ["Stride", has(mob.stride_m) ? `${num(mob.stride_m, 2)} m` : null, "Running form"],
        ["Ground contact", has(mob.ground_contact_ms) ? `${num(mob.ground_contact_ms)} ms` : null, "Running form"],
        ["Vertical oscillation", has(mob.vertical_cm) ? `${num(mob.vertical_cm, 1)} cm` : null, "Running form"],
        ["Vertical ratio", has(mob.vertical_ratio) ? num(mob.vertical_ratio, 1) : null, "Running form"],
      ].filter(([, value]) => has(value) && value !== "");
      const stats = statPairs.length ? `<div class="mini-grid">${statPairs.map(([label, value, detail]) =>
        `<div class="mini-metric"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(detail)}</small></div>`).join("")}</div>` : "";

      const zones = latest.zones;
      const zoneTotal = zones ? Object.values(zones).reduce((sum, value) => sum + (value || 0), 0) : 0;
      const zoneTable = zones && zoneTotal ? `<div class="data-table">
        <div class="data-tr zone-tr data-th"><span>Heart-rate zone</span><span>Time</span><span>Share</span></div>
        ${[["light", "Light"], ["moderate", "Moderate"], ["vigorous", "Vigorous"], ["peak", "Peak"]].map(([key, label]) => `<div class="data-tr zone-tr">
          <span>${label}</span><b>${hm(zones[key] || 0)}</b><span>${num(Math.round(100 * (zones[key] || 0) / zoneTotal))}%</span>
        </div>`).join("")}
      </div>` : "";

      const teNow = teByDate[latest.date];
      const easyOnly = zones && zoneTotal && (zones.light || 0) === zoneTotal;
      const teBlock = teNow ? `<div class="te-grid">
        <div>
          <div class="label">Aerobic effect</div>
          <div class="te-value">${num(teNow.aerobic, 1)}<small>/ 5</small></div>
          ${gauge(teNow.aerobic, "var(--chart)")}
          <div class="te-band">${esc(bandLabel(teNow.aerobic_band))}</div>
        </div>
        <div>
          <div class="label">Anaerobic effect</div>
          <div class="te-value">${num(teNow.anaerobic, 1)}<small>/ 5</small></div>
          ${gauge(teNow.anaerobic, "var(--warn)")}
          <div class="te-band">${esc(bandLabel(teNow.anaerobic_band))}</div>
        </div>
      </div>` : easyOnly ? `<p class="sub">All ${hm(zoneTotal)} was in the light zone, so this session has no aerobic or anaerobic training effect.</p>` : "";

      const history = teSessions.length > 1 ? `<details class="plain">
        <summary>Recent training effects</summary>
        <div class="te-table">
          <div class="te-tr te-th"><span>Date</span><span>Session</span><span>Aerobic</span><span>Anaerobic</span></div>
          ${teSessions.slice(0, -1).reverse().map((row) => `<div class="te-tr">
            <span class="muted">${shortDate(row.date)}</span>
            <span>${workoutName(row)} <span class="faint">${hm(row.minutes)}</span></span>
            <b class="te-a">${num(row.aerobic, 1)}</b>
            <b class="te-n">${num(row.anaerobic, 1)}</b>
          </div>`).join("")}
        </div>
      </details>` : "";

      latestCard = `<div class="card">
        <div class="card-head"><h3>Latest workout${info("workout")}</h3><span class="faint small">${shortDate(latest.date)} · ${workoutName(latest)}</span></div>
        ${stats}
        ${data.today && has(data.today.workout_effort && data.today.workout_effort.score)
          ? `<p class="note">Effort <b>${num(data.today.workout_effort.score)}</b> / 100${info("effort")} · from the reported one-minute heart rate.</p>` : ""}
        ${latest.notes ? `<p class="note">Notes: ${esc(latest.notes)}</p>` : ""}
        ${workoutHrChart(data, zones)}
        ${zoneTable ? `<div class="section-mini">Time in zones</div>${zoneTable}` : ""}
        ${teBlock ? `<div class="section-mini">Training effect</div>${teBlock}` : ""}
        ${compareRows.length ? `<div class="section-mini">Against ${peerLabel}</div>
          <div class="data-table">
            <div class="data-tr compare-tr data-th"><span>Measure</span><span>This session</span><span>Recent average</span><span>Difference</span></div>
            ${compareRows.join("")}
          </div>` : ""}
        ${teNow ? `<p class="note">Training effect is scored against your own ${num(te.scale_sessions)} workouts from the last ${num(te.window_days)} days${te.easy_sessions ? `, plus ${num(te.easy_sessions)} easy sessions with no effect` : ""}. This is not Garmin's Firstbeat score.</p>${study(te.evidence)}` : ""}
        ${history}
      </div>`;
    }

    const pair = (a, b) => (a && b ? `<div class="grid cols-2">${a}${b}</div>` : a || b);
    slot("activity").innerHTML = [
      latestCard,
      stats.length ? `<div class="tiles card">${stats.join("")}</div>` : "",
    ].filter(Boolean).join('<div style="height:16px"></div>') || `<p class="muted">No activity in this sync.</p>`;
    slot("activityLoad").innerHTML = pair(loadCard, mixCard) || `<p class="muted">No load data in this sync.</p>`;
    slot("activityRecord").innerHTML = consistency || `<p class="muted">No workout history in this sync.</p>`;

    const hrSamples = ((data.history && data.history.workout_hr) || []).filter((row) => has(row.bpm)).slice(-180);
    if (latestCard && hrSamples.length > 1) bindHrScrub(hrSamples, data.hr_zones || null, data.timezone);
  }

  /* ------------------------------------------------------------ insights -- */
  function renderInsights(data) {
    const recovery = (data.today && data.today.recovery) || {};
    const labels = (data.policy && data.policy.labels) || {};
    const factors = Array.isArray(recovery.factors) ? recovery.factors : [];
    const corr = data.correlations || {};
    const findings = corr.findings || [];
    const cards = (data.coaching && data.coaching.cards) || [];

    const patternCard = `<div class="card">
      <div class="card-head"><h3>Patterns in your data${info("patterns")}</h3><span class="faint small">${corr.window_days ? `Last ${corr.window_days} days` : ""}</span></div>
      ${findings.length ? findings.map((f) => `<div class="pattern">
        <div>
          <b>${esc(f.plain)}</b>
          <div class="sub">${esc(f.a_label)} and ${esc(f.b_label).toLowerCase()} · ${num(f.n)} paired days</div>
        </div>
        <div class="r" title="Correlation, from −1 to +1">${f.r >= 0 ? "+" : "−"}${Math.abs(f.r).toFixed(2)}</div>
      </div>`).join("") : `<p class="muted small">No pattern strong enough to show yet${has(corr.min_paired_days) && has(corr.min_r) ? `: a pair needs ${num(corr.min_paired_days)} paired days and a correlation of at least ${num(corr.min_r, 2)}` : ""}.</p>`}
      <p class="note">Associations across your own days, not causes.</p>
    </div>`;

    const coachCard = cards.length ? `<div class="card">
      <div class="card-head"><h3>What to do about it</h3></div>
      ${cards.map((c) => {
        const ev = c.evidence || {};
        return `<details class="coach">
          <summary><div><h3>${esc(c.title)}</h3><p>${esc(c.action)}</p></div></summary>
          <dl class="coach-body">
            <dt>Reading</dt><dd>${esc(c.reading)}</dd>
            <dt>Next step</dt><dd>${esc(c.progress)}</dd>
            <dt>Back off when</dt><dd>${esc(c.back_off)}</dd>
            ${ev.cite ? `<dt>Evidence</dt><dd>${esc(ev.cite)}: ${esc(ev.found)} Not settled: ${esc(ev.not)}</dd>` : ""}
          </dl>
        </details>`;
      }).join("")}
    </div>` : "";

    slot("insights").innerHTML = coachCard
      ? `<div class="grid cols-2">${patternCard}${coachCard}</div>`
      : patternCard;
  }

  /* ------------------------------------------------------------- sources -- */
  function renderSources(data) {
    const quality = data.data_quality || {};
    const metrics = Object.values(quality.metrics || {});
    const devices = (data.sources && data.sources.devices) || [];
    const clinical = data.clinical || {};

    slot("sources").innerHTML = `<details class="plain">
      <summary>Data sources and methods · ${num(quality.live_count)} of ${num(quality.total_count)} metric groups measured</summary>
      <div>
        <div class="prov">${metrics.map((m) => `<div><span>${esc(m.label)}</span><span>${m.source === "live" ? esc(m.note || "measured") : "not measured"}</span></div>`).join("")}</div>
        ${devices.length ? `<p class="note">Reported by: ${devices.map((d) => esc(d.label)).join(", ")}</p>` : ""}
        <p class="note">Measurements come from the Google Health API. Recovery, sleep performance, sleep need, training load and patterns are calculated here by documented rules (bio_policy.py); a metric the API did not return is left off the page rather than estimated.</p>
      </div>
    </details>`;

    slot("footer").innerHTML = `<span>Meridian Air · Google Health API v4 · AES-256-GCM vault</span>
      <span class="tnum">Synced ${data.generated_at ? esc(new Date(data.generated_at).toLocaleString()) : DASH} · ${esc(data.timezone || "")} · ${esc(clinical.score_source || "deterministic")}</span>`;
  }

  /* -------------------------------------------------------------- chrome -- */
  function renderChrome(data) {
    $("demoChip").hidden = !data.demo;
    // Signature: a status dot with the data's age, green while fresh.
    if (data.generated_at) {
      const ageH = (Date.now() - new Date(data.generated_at).getTime()) / 3600000;
      const fresh = ageH <= ((data.policy && data.policy.stale_after_hours) || 30);
      const age = ageH < 1 ? `${Math.max(1, Math.round(ageH * 60))}m ago` : ageH < 48 ? `${Math.round(ageH)}h ago` : `${Math.round(ageH / 24)}d ago`;
      $("syncText").className = `sync small ${fresh ? "fresh" : "stale"}`;
      $("syncText").textContent = `synced ${age}`;
      $("syncText").title = new Date(data.generated_at).toLocaleString();
    } else {
      $("syncText").textContent = "";
    }
    const banner = $("staleBanner");
    if (data.generated_at) {
      const hours = (Date.now() - new Date(data.generated_at).getTime()) / 3600000;
      const staleAfter = (data.policy && data.policy.stale_after_hours) || 30;
      banner.hidden = hours <= staleAfter;
      banner.textContent = `This data is ${Math.round(hours)} hours old. The daily sync has not published since ${new Date(data.generated_at).toLocaleString()}.`;
    }
  }

  /* -------------------------------------------------------------- render -- */
  function render(data) {
    state.payload = data;
    hideHelp();
    restoreResultCards();

    // New vaults carry two complete views so switching needs no refetch.
    // Old vaults are shown as-is with the control hidden.
    const views = data.views;
    let source = state.source;
    if (views && !views[source]) source = data.default_view || Object.keys(views)[0];
    if (!views) source = "all";
    state.source = source;
    const view = views ? views[source] : data;
    updateSourceUI(data);

    renderChrome(data);
    renderToday(view);
    bindFactorDeck();
    renderVitals(view);
    renderSleep(view);
    renderHeart(view);
    renderMarkers(view);
    renderActivity(view);
    renderInsights(view);
    renderSources(view);
    bindFoilTilt();
    if (state.stackMode) { collectResultCards(); stackTo(state.stackIndex); }
  }

  /* ------------------------------------------------------- remembered vault -- */
  // "Remember this browser" reopens the vault without retyping the passphrase.
  // The passphrase is what is kept, sealed under a device key generated here;
  // that key is non-extractable and lives in IndexedDB, so a copy of the browser
  // profile holds ciphertext plus a key only this origin can use. Keeping the
  // passphrase rather than the derived AES key is deliberate: every sync
  // re-encrypts the vault under a fresh salt, and a stored key would stop
  // opening it the next morning.
  const REMEMBER = {
    db: "meridian-air-vault",
    store: "device",
    key: "device-key",
    wrapped: "wrapped-passphrase",
    days: 30,
  };

  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB is unavailable in this browser"));
        return;
      }
      const request = indexedDB.open(REMEMBER.db, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(REMEMBER.store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbRun(mode, run) {
    return idbOpen().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(REMEMBER.store, mode);
          const request = run(tx.objectStore(REMEMBER.store));
          tx.oncomplete = () => {
            db.close();
            resolve(request ? request.result : undefined);
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        })
    );
  }

  async function deviceKey(create) {
    const existing = await idbRun("readonly", (store) => store.get(REMEMBER.key));
    if (existing) return existing;
    if (!create) return null;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idbRun("readwrite", (store) => store.put(key, REMEMBER.key));
    return key;
  }

  async function rememberPassphrase(passphrase) {
    try {
      const key = await deviceKey(true);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(passphrase));
      await idbRun("readwrite", (store) =>
        store.put({ iv: Array.from(iv), sealed: Array.from(new Uint8Array(sealed)), at: Date.now() }, REMEMBER.wrapped)
      );
    } catch (error) {
      // Private mode, or a denied store: the passphrase is simply asked for again.
    }
  }

  async function recallPassphrase() {
    try {
      const record = await idbRun("readonly", (store) => store.get(REMEMBER.wrapped));
      if (!record) return null;
      if (Date.now() - record.at > REMEMBER.days * 86400000) {
        await forgetPassphrase();
        return null;
      }
      const key = await deviceKey(false);
      if (!key) return null;
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(record.iv) }, key, new Uint8Array(record.sealed)
      );
      return new TextDecoder().decode(plain);
    } catch (error) {
      // The record no longer opens, so it is of no further use.
      await forgetPassphrase();
      return null;
    }
  }

  async function forgetPassphrase() {
    try {
      await idbRun("readwrite", (store) => store.delete(REMEMBER.wrapped));
    } catch (error) {
      /* nothing stored, nothing to forget */
    }
  }

  /* -------------------------------------------------------------- session -- */
  async function unlock(passphrase, persist) {
    const data = await decryptVault(passphrase);
    // Held in memory for this page's lifetime so Refresh can re-read the vault
    // without re-prompting. The only network request is the vault itself.
    state.passphrase = passphrase;
    $("lock").hidden = true;
    $("app").hidden = false;
    render(data);
    if (persist) await rememberPassphrase(passphrase);
    return data;
  }

  function lock() {
    restoreResultCards();
    state.passphrase = null;
    state.payload = null;
    // A manual lock means locked: leaving the remembered record behind would
    // reopen the vault on the next reload and make the button a lie.
    forgetPassphrase();
    hideHelp();
    // Every rendered value lives inside a slot, so emptying the slots purges
    // the data from the DOM rather than merely hiding it.
    document.querySelectorAll("[data-slot]").forEach((node) => { node.innerHTML = ""; });
    $("celebration").innerHTML = "";
    $("sourceMenu").innerHTML = "";
    $("stackCount").textContent = "";
    $("stackNextLabel").textContent = "";
    $("stackLive").textContent = "";
    $("pageTitle").textContent = "";
    $("stackRail").style.width = "0";
    $("syncText").textContent = "";
    closeSourceMenu();
    $("sourcePicker").hidden = true;
    $("staleBanner").hidden = true;
    $("app").hidden = true;
    $("lock").hidden = false;
    $("lockInput").value = "";
    $("lockError").textContent = "";
    $("lockHint").textContent = "Data purged from this tab and this browser forgotten.";
  }

  async function refresh() {
    if (!state.passphrase) return;
    const button = $("btnRefresh");
    button.disabled = true;
    try {
      render(await decryptVault(state.passphrase));
      button.title = "Up to date";
    } catch (error) {
      button.title = "Refresh failed";
    } finally {
      button.disabled = false;
    }
  }

  /* ----------------------------------------------------------------- init -- */
  function initControls() {
    $("btnTheme").addEventListener("click", (event) => {
      const next = state.theme === "dark" ? "light" : "dark";
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!document.startViewTransition || reduce) return applyTheme(next);
      // The new theme is revealed as a circle growing from the button until it
      // covers the farthest corner of the viewport.
      const box = event.currentTarget.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      const transition = document.startViewTransition(() => applyTheme(next));
      transition.ready.then(() => {
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          { duration: 700, easing: "cubic-bezier(.2, .8, .2, 1)", pseudoElement: "::view-transition-new(root)" }
        );
      }).catch(() => {});
    });
    $("btnPrint").addEventListener("click", () => window.print());
    $("btnCards").addEventListener("click", () => setMode(!state.stackMode));
    $("btnSound").addEventListener("click", toggleSound);
    $("btnGyro").addEventListener("click", toggleGyro);
    $("btnHelp").addEventListener("click", () => toggleShortcutHelp());
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#shortcutHelp, #btnHelp")) toggleShortcutHelp(false);
    });
    $("stackPrev").addEventListener("click", () => cycleStack(-1));
    $("stackNext").addEventListener("click", () => cycleStack(1));
    $("sourceButton").addEventListener("click", () => {
      const menu = $("sourceMenu");
      const open = menu && menu.hidden;
      if (menu) menu.hidden = !open;
      $("sourceButton").setAttribute("aria-expanded", String(Boolean(open)));
    });
    $("sourceMenu").addEventListener("click", (event) => {
      const option = event.target.closest(".source-option");
      if (option && !option.disabled) setSource(option.dataset.source);
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#sourcePicker")) closeSourceMenu();
    });
    $("btnLock").addEventListener("click", lock);
    $("btnRefresh").addEventListener("click", refresh);

    $("lockForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = $("lockInput").value;
      if (!value) return;
      $("lockError").textContent = "";
      try {
        const persist = $("rememberDevice").checked;
        if (!persist) await forgetPassphrase();
        await unlock(value, persist);
      } catch (error) {
        $("lockError").textContent =
          error.name === "OperationError"
            ? "That passphrase does not open this vault."
            : error.message || "Could not read the vault.";
      }
    });

    const links = Array.from(document.querySelectorAll(".nav a, .tabbar a"));
    links.forEach((link) => link.addEventListener("click", (event) => {
      if (!state.stackMode) return;
      const id = (link.getAttribute("href") || "").replace("#", "");
      if (!id) return;
      event.preventDefault();
      goToSection(id);
    }));
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => entries.forEach((entry) => {
          if (!entry.isIntersecting || state.stackMode) return;
          links.forEach((link) =>
            link.setAttribute("aria-current", String(link.getAttribute("href") === "#" + entry.target.id))
          );
          const current = links.find((link) => link.getAttribute("href") === "#" + entry.target.id);
          if (current) $("pageTitle").textContent = current.textContent.trim();
        }),
        { rootMargin: "-20% 0px -70% 0px" }
      );
      document.querySelectorAll("main section[id]").forEach((section) => observer.observe(section));
    }

    document.addEventListener("click", (event) => {
      const button = event.target.closest ? event.target.closest(".info") : null;
      if (button && button === helpButton) return hideHelp();
      if (button) return showHelp(button);
      if (!(event.target.closest && event.target.closest(".info-pop"))) hideHelp();
    });
    window.addEventListener("resize", hideHelp);

    // Navigation is buttons/arrows only. Dragging the card reveals its
    // hologram instead of flipping the deck.
    bindDeckDrag();

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { hideHelp(); closeSourceMenu(); toggleShortcutHelp(false); }
      const tag = (event.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || event.target.isContentEditable) return;
      if (event.key === "?") { toggleShortcutHelp(); event.preventDefault(); return; }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (state.stackMode && (event.key === "ArrowRight" || event.key === "ArrowLeft") && !event.target.closest(".hr-ribbon svg")) {
        cycleStack(event.key === "ArrowRight" ? 1 : -1);
        event.preventDefault();
        return;
      }
      if (tag === "button") return;
      if (event.key === "l") lock();
      if (event.key === "r") refresh();
    });
  }

  async function boot() {
    initTheme();
    initSource();
    initMode();
    initSound();
    initControls();
    $("lock").hidden = false;
    $("app").hidden = true;

    // A remembered browser opens straight to the data. If the record no longer
    // opens the vault it is dropped and the lock screen simply stays up.
    const remembered = await recallPassphrase();
    if (!remembered) return;
    try {
      await unlock(remembered, true);
    } catch (error) {
      await forgetPassphrase();
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
