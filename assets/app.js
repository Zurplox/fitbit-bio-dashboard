/* ==========================================================================
   Meridian Air — render layer
   One decrypt boundary, one render pass, no arithmetic on thresholds: every
   band, tone and label arrives resolved in the payload. A metric the payload
   does not carry is left out, never shown as a placeholder.
   ========================================================================== */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = { payload: null, passphrase: null, theme: null };

  /* ------------------------------------------------------------- helpers -- */
  const DASH = "–";
  const has = (value) => value !== null && value !== undefined && !Number.isNaN(value);

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
    recovery: "How ready your body is today, from 0 to 100%. It compares last night's HRV, resting heart rate, sleep and breathing with your own normal. Higher means better recovered.",
    readiness: "Your recovery, adjusted for how quickly your training has been ramping up. A quick answer to: is today a good day to go hard?",
    sleep_perf: "The hours you slept divided by the hours your body needed. 100% means you got all the sleep you needed.",
    load: "Training minutes in the last 7 days compared with your usual week. About 0.8 to 1.3 is a healthy build. Above 1.5 is a sudden jump that raises injury risk.",
    hrv: "Heart rate variability: tiny differences in time between heartbeats, measured while you sleep. Above your normal usually means rested. Below can mean fatigue, stress, illness or alcohol.",
    rhr: "Your heart rate at complete rest. A few beats above your normal can signal fatigue or illness. Lower over months usually means fitter.",
    resp: "Breaths per minute while asleep. It barely changes from night to night, so a rise can be an early sign of getting sick.",
    spo2: "How much oxygen your blood is carrying, measured overnight. 95 to 100% is typical.",
    skin: "How warm your skin was overnight compared with your own usual. It can rise with illness, alcohol, a warm room or the menstrual cycle.",
    stages: "Deep sleep restores the body, REM supports memory and mood, and light sleep makes up the rest. Short wake-ups are normal.",
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
    workout_hr: "One-minute average heart rate during the workout. Each stretch is coloured by the heart-rate zone your device reported for that date: grey below light, blue light, amber vigorous, red peak. If the device sent no samples or no zone limits, the chart says so rather than guessing.",
    te: "How hard your workout was for you, Garmin-style. Aerobic counts steady effort (moderate and vigorous heart-rate zones; easy light-zone time doesn't count, as with Fitbit's Active Zone Minutes); anaerobic counts all-out bursts (peak zone). 5.0 means as hard as your toughest recent sessions.",
    heatmap: "Each square is one day. Darker squares mean more training minutes.",
    factors: "How each signal scored against your own normal, and how much it counts toward your recovery score.",
    patterns: "A number from −1 to +1 showing how closely two of your measures move together. Closer to ±1 is stronger. It shows a link, not a cause.",
  };

  const info = (key) =>
    HELP[key]
      ? `<button class="info" type="button" data-help="${key}" aria-expanded="false" aria-label="What does this mean?">i</button>`
      : "";

  let helpPop = null;
  let helpButton = null;

  function hideHelp() {
    if (helpPop) helpPop.remove();
    if (helpButton) helpButton.setAttribute("aria-expanded", "false");
    helpPop = helpButton = null;
  }

  function showHelp(button) {
    hideHelp();
    const pop = document.createElement("div");
    pop.className = "info-pop";
    pop.setAttribute("role", "note");
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

  /* --------------------------------------------------------------- today -- */
  const RING_R = 52;
  const RING_C = 2 * Math.PI * RING_R;

  function ring(ratio, color, inner) {
    const bounded = has(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
    return `<div class="ring-wrap">
      <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
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

    const score = has(recovery.score) ? Math.round(recovery.score) : null;
    const dateText = today.date
      ? new Date(today.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })
      : "";
    const device = (data.device && data.device.name) || "Fitbit";
    const lede = recovery.band && recovery.band.plain
      ? recovery.band.plain
      : (data.clinical && data.clinical.headline) || "";

    const small = (label, value, note, help) => `<div class="hero-stat">
      <div class="label">${label}${info(help)}</div>
      <div class="hero-stat-value">${value}</div>
      <div class="sub">${esc(note)}</div>
    </div>`;

    const perf = has(sleep.minutes) && sleep.need_minutes
      ? Math.min(100, (sleep.minutes / sleep.need_minutes) * 100) : null;
    const stats = [
      perf !== null ? small("Sleep", `${Math.round(perf)}%`, `${hm(sleep.minutes)} of ${hm(sleep.need_minutes)} needed`, "sleep_perf") : "",
      has(readiness.score) ? small("Readiness", String(Math.round(readiness.score)), bandLabel(readiness.band), "readiness") : "",
      has(load.acwr) ? small("Load", load.acwr.toFixed(2), bandLabel(load.acwr_band), "load") : "",
    ].filter(Boolean).join("");

    $("pageTitle").textContent = "Today";
    slot("today").innerHTML = `<div class="hero-card">
      <div class="hero-main">
        ${score !== null ? ring(score / 100, toneColor(recovery.band), `<div class="hero-ring-value">${score}<small>%</small></div>`) : ""}
        <div class="hero-copy">
          <p class="eyebrow">${esc(dateText)} · ${esc(device)}</p>
          <h1>${score !== null ? esc(bandLabel(recovery.band)) : "Today"}</h1>
          ${lede ? `<p class="hero-lede">${esc(lede)}</p>` : ""}
        </div>
      </div>
      ${stats ? `<div class="hero-stats">${stats}</div>` : ""}
    </div>`;
  }

  /* -------------------------------------------------------------- vitals -- */
  function renderVitals(data) {
    const t = data.today || {};
    const hrv = t.hrv || {};
    const rhr = t.rhr || {};
    const resp = t.resp || {};
    const spo2 = t.spo2 || {};
    const skin = t.skin_temp || {};

    const rows = [
      has(hrv.ms) && {
        help: "hrv", name: "HRV", value: `${num(hrv.ms)} ms`,
        base: has(hrv.baseline) ? `${num(hrv.baseline)} ms` : "", change: signed(hrv.delta_pct, 0, "%"), band: hrv.band,
      },
      has(rhr.bpm) && {
        help: "rhr", name: "Resting HR", value: `${num(rhr.bpm)} bpm`,
        base: has(rhr.baseline) ? `${num(rhr.baseline)} bpm` : "", change: signed(rhr.delta, 0, " bpm"), band: rhr.band,
      },
      has(resp.brpm) && {
        help: "resp", name: "Breathing rate", value: `${num(resp.brpm, 1)} /min`,
        base: has(resp.baseline) ? `${num(resp.baseline, 1)} /min` : "", change: signed(resp.delta, 1, ""), band: resp.band,
      },
      has(spo2.pct) && {
        help: "spo2", name: "Blood oxygen", value: `${num(spo2.pct, 1)}%`, base: "", change: "", band: spo2.band,
      },
      // The API gives skin temperature with its own 30-night baseline; there
      // is no published threshold for it here, so it carries no status colour.
      has(skin.delta_c) && {
        help: "skin", name: "Skin temp", value: `${signed(skin.delta_c, 1, " °C")}`, base: "30-night median", change: "",
        band: null, bandText: "Not scored",
      },
    ].filter(Boolean);

    const illness = (data.clinical && data.clinical.illness) || null;

    slot("vitals").innerHTML = rows.length
      ? `<div class="tiles card">${rows.map((r) => `<div class="tile">
          <div class="tile-name">${esc(r.name)}${info(r.help)}</div>
          <div class="tile-value">${esc(r.value)}</div>
          <div class="tile-meta">${esc([r.base && r.base !== "30-night median" ? `Usual ${r.base}` : r.base, r.change].filter(Boolean).join(" · "))}</div>
          <div class="tile-status">${status(r.band, r.bandText)}</div>
        </div>`).join("")}</div>
        ${illness && illness.headline ? `<p class="note">${status({ tone: illness.tone }, illness.headline)}${
          (illness.drivers || []).length ? ` · ${esc(illness.drivers.join(", "))}` : ""}</p>` : ""}`
      : `<p class="muted">No overnight vitals in this sync.</p>`;
  }

  /* --------------------------------------------------------------- sleep -- */
  function readouts(items) {
    const rows = items.filter(([, value]) => has(value));
    return rows.length ? `<div class="readouts">${rows.map(([label, value]) =>
      `<div class="readout"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}</div>` : "";
  }

  /* ------------------------------------------- latest workout HR trace -- */
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

  function workoutHrChart(data) {
    const samples = ((data.history && data.history.workout_hr) || []).filter((row) => has(row.bpm)).slice(-180);
    if (samples.length < 2) {
      return `<div class="section-mini">Heart rate${info("workout_hr")}</div>
        <p class="sub">No per-minute heart-rate samples were returned for this workout. The measured average is above; no line is drawn from an estimate.</p>`;
    }

    const zones = data.hr_zones || null;
    const w = 720, h = 220, left = 44, right = 18, top = 16, bottom = 30;
    const values = samples.map((row) => row.bpm);
    const low = Math.max(30, Math.floor((Math.min(...values) - 8) / 10) * 10);
    const high = Math.ceil((Math.max(...values) + 8) / 10) * 10;
    const xAt = (index) => left + (index / (samples.length - 1)) * (w - left - right);
    const yAt = (bpm) => top + ((high - bpm) / (high - low)) * (h - top - bottom);
    const points = samples.map((row, index) => ({ x: xAt(index), y: yAt(row.bpm), bpm: row.bpm }));

    const bands = zones ? Object.keys(HR_ZONES).filter((key) => zones[key]).map((key) => {
      const [a, b] = zones[key];
      const y1 = yAt(Math.min(high, Math.max(low, b)));
      const y2 = yAt(Math.min(high, Math.max(low, a)));
      if (y2 <= y1) return "";
      return `<rect x="${left}" y="${y1.toFixed(1)}" width="${w - left - right}" height="${(y2 - y1).toFixed(1)}"
        fill="var(${HR_ZONES[key][0]})" opacity="0.08" />`;
    }).join("") : "";

    const grid = [low, Math.round((low + high) / 2), high].map((value) => `
      <line x1="${left}" y1="${yAt(value).toFixed(1)}" x2="${w - right}" y2="${yAt(value).toFixed(1)}" stroke="var(--line)" />
      <text x="${left - 10}" y="${yAt(value).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${value}</text>`).join("");

    const used = new Set();
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
      const zone = zones ? hrZone((p1.bpm + p2.bpm) / 2, zones) : "moderate";
      used.add(zone);
      strokes += `<path d="M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}"
        fill="none" stroke="var(${HR_ZONES[zone][0]})" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`;
    }

    const topIndex = values.indexOf(Math.max(...values));
    const topPoint = points[topIndex];
    const marker = `<circle cx="${topPoint.x.toFixed(1)}" cy="${topPoint.y.toFixed(1)}" r="4" fill="var(--surface)" stroke="var(--text)" stroke-width="2" />
      <text x="${Math.min(w - right - 34, topPoint.x + 10).toFixed(1)}" y="${Math.max(top + 12, topPoint.y - 12).toFixed(1)}" text-anchor="start" fill="var(--text)" font-size="12">${topPoint.bpm} bpm</text>`;

    const legend = zones
      ? [...used].map((key) => `<span><i style="background:var(${HR_ZONES[key][0]})"></i>${HR_ZONES[key][1]}${
          zones[key] ? ` <b>${zones[key][0]}–${zones[key][1]}</b>` : ""}</span>`).join("")
      : `<span><i style="background:var(--zone-moderate)"></i>Heart rate · zone limits not reported</span>`;

    return `<div class="section-mini">Heart rate during workout${info("workout_hr")}</div>
      <div class="hr-ribbon">
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Heart rate during the latest workout, coloured by heart-rate zone">
          ${bands}${grid}${strokes}${marker}
        </svg>
        <div class="hr-axis"><span>${clockInZone(samples[0].t, data.timezone)}</span><span>${clockInZone(samples[samples.length - 1].t, data.timezone)}</span></div>
      </div>
      <div class="legend hr-legend">${legend}</div>`;
  }

  function renderSleep(data) {
    const sleep = (data.today && data.today.sleep) || {};
    const circ = data.circadian || {};
    const jet = (data.markers && data.markers.social_jetlag) || {};
    const history = (data.history && data.history.sleep) || [];
    if (!has(sleep.minutes) && !history.length) {
      slot("sleep").innerHTML = `<p class="muted">No sleep recorded in this sync.</p>`;
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

    slot("sleep").innerHTML = `<div class="grid cols-2-3">
      <div class="card">
        <div class="label">Last night${info("stages")}</div>
        <div class="figure">${hm(sleep.minutes)}</div>
        ${has(sleep.score) ? `<div class="sub">Score ${num(sleep.score)} of 100 · ${esc(bandLabel(sleep.band))}</div>` : ""}
        ${total ? `<div class="stagebar" role="img" aria-label="Sleep stages">${stageDefs
          .map(([, key, color]) => `<i style="width:${(stages[key] / total) * 100}%;background:var(${color})"></i>`).join("")}</div>
          <div class="legend">${stageDefs
            .map(([label, key, color]) => `<span><i style="background:var(${color})"></i>${label} <b>${hm(stages[key])}</b></span>`).join("")}</div>` : ""}
        ${kv.length ? `<dl class="kv">${kv.map(([k, v]) => `<div><dt>${k}${info({ "Efficiency": "efficiency", "Sleep debt, 14 nights": "debt", "Consistency": "consistency" }[k])}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
      </div>
      <div class="card">
        <div class="card-head"><h3>Recent nights</h3><span class="faint small">Last ${recent.length}</span></div>
        ${recent.length ? `<div class="data-table">
          <div class="data-tr data-th"><span>Night</span><span>Asleep</span><span>Deep</span><span>REM</span><span>Eff.</span></div>
          ${recent.map((r) => `<div class="data-tr">
            <span class="muted">${shortDate(r.date)}</span>
            <b>${hm(r.minutes)}</b>
            <span>${r.deep ? hm(r.deep) : DASH}</span>
            <span>${r.rem ? hm(r.rem) : DASH}</span>
            <span>${has(r.efficiency) ? `${num(r.efficiency)}%` : DASH}</span>
          </div>`).join("")}
        </div>` : `<p class="muted">No recent nights recorded.</p>`}
        ${spanText ? `<p class="note">Across these nights, sleep ran from ${spanText}.</p>` : ""}
      </div>
    </div>
    ${timing ? `<div style="height:16px"></div>${timing}` : ""}`;
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

    slot("heart").innerHTML = cards.length
      ? `<div class="grid cols-2">${cards.join("")}</div>`
      : `<p class="muted">No heart data in this sync.</p>`;
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
    const consistency = exerciseLive && sessions.length ? `<div class="card">
      <div class="card-head"><h3>Training record</h3><span class="faint small">History</span></div>
      ${readouts([
        ["Sessions recorded", num(sessions.length)],
        ["Days trained", num(trainedDays)],
        ["Total time", hm(totalMinutes)],
        ["Last 28 days", `${num(load.sessions_28d)} sessions`],
      ])}
    </div>` : "";

    // Latest workout: every measurement the API sent, plus a comparison with
    // recent sessions. No chart; all of it is numbers and short tables.
    const te = (data.markers && data.markers.training_effect) || {};
    const teByDate = {};
    (te.sessions || []).forEach((row) => { teByDate[row.date] = row; });
    const gauge = (value, color) => `<div class="te-gauge" role="img" aria-label="${num(value, 1)} of 5">
      ${[0, 1, 2, 3, 4].map((i) => `<i style="--fill:${Math.max(0, Math.min(1, value - i)) * 100}%;--c:${color}"></i>`).join("")}
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
      const stats = readouts([
        ["Started", latest.start_local],
        ["Duration", has(latest.minutes) ? hm(latest.minutes) : null],
        ["Average HR", has(latest.avg_hr) ? `${num(latest.avg_hr)} bpm` : null],
        ["Calories", has(latest.calories) ? `${num(latest.calories)} kcal` : null],
        ["Distance", has(latest.distance_m) ? `${num(latest.distance_m)} m` : null],
        ["Steps", has(latest.steps) ? num(latest.steps) : null],
        ["Active zone min", has(latest.active_zone_minutes) ? `${num(latest.active_zone_minutes)} min` : null],
        ["Elevation", has(latest.elevation_m) ? `${num(latest.elevation_m)} m` : null],
        ["Run VO₂ max", has(latest.run_vo2max) ? `${num(latest.run_vo2max, 1)} ml/kg/min` : null],
        [has(latest.pace_s_per_m) ? "Pace" : "Pace (from distance)", has(pace) ? `${pace.toFixed(1)} min/km` : null],
        ["Speed", has(latest.speed_kmh) ? `${num(latest.speed_kmh, 1)} km/h` : null],
        ["Swim lengths", has(latest.swim_lengths) ? num(latest.swim_lengths) : null],
        ["Cadence", has(mob.cadence_spm) ? `${num(mob.cadence_spm)} spm` : null],
        ["Stride", has(mob.stride_m) ? `${num(mob.stride_m, 2)} m` : null],
        ["Ground contact", has(mob.ground_contact_ms) ? `${num(mob.ground_contact_ms)} ms` : null],
        ["Vertical oscillation", has(mob.vertical_cm) ? `${num(mob.vertical_cm, 1)} cm` : null],
        ["Vertical ratio", has(mob.vertical_ratio) ? num(mob.vertical_ratio, 1) : null],
      ]);

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

      const history = te.sessions && te.sessions.length > 1 ? `<details class="plain">
        <summary>Recent training effects</summary>
        <div class="te-table">
          <div class="te-tr te-th"><span>Date</span><span>Session</span><span>Aerobic</span><span>Anaerobic</span></div>
          ${te.sessions.slice(0, -1).reverse().map((row) => `<div class="te-tr">
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
        ${workoutHrChart(data)}
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
      pair(loadCard, mixCard),
      consistency,
    ].filter(Boolean).join('<div style="height:16px"></div>') || `<p class="muted">No activity in this sync.</p>`;
  }

  /* ------------------------------------------------------------ insights -- */
  function renderInsights(data) {
    const recovery = (data.today && data.today.recovery) || {};
    const labels = (data.policy && data.policy.labels) || {};
    const factors = Array.isArray(recovery.factors) ? recovery.factors : [];
    const corr = data.correlations || {};
    const findings = corr.findings || [];
    const cards = (data.coaching && data.coaching.cards) || [];

    const factorCard = factors.length ? `<div class="card">
      <div class="card-head"><h3>What moved your recovery${info("factors")}</h3><span class="faint small">Weight in score</span></div>
      ${factors.map((f) => {
        const score = Math.max(0, Math.min(100, Number(f.contribution) || 0));
        return `<div class="factor">
          <div class="factor-head"><b>${esc(labels[f.key] || f.key)}</b><span class="muted tnum">${Math.round(Number(f.weight) || 0)}%</span></div>
          <div class="factor-read">${esc(f.read || "")}</div>
          <div class="progress"><i style="width:${score}%"></i></div>
        </div>`;
      }).join("")}
    </div>` : "";

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

    slot("insights").innerHTML = `<div class="grid cols-2">${factorCard}${patternCard}</div>
      ${coachCard ? `<div style="height:16px"></div>${coachCard}` : ""}`;
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
      $("syncText").className = `sync mono small ${fresh ? "fresh" : "stale"}`;
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
    renderChrome(data);
    renderToday(data);
    renderVitals(data);
    renderSleep(data);
    renderHeart(data);
    renderMarkers(data);
    renderActivity(data);
    renderInsights(data);
    renderSources(data);
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
    state.passphrase = null;
    state.payload = null;
    // A manual lock means locked: leaving the remembered record behind would
    // reopen the vault on the next reload and make the button a lie.
    forgetPassphrase();
    hideHelp();
    // Every rendered value lives inside a slot, so emptying the slots purges
    // the data from the DOM rather than merely hiding it.
    document.querySelectorAll("[data-slot]").forEach((node) => { node.innerHTML = ""; });
    $("syncText").textContent = "";
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
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
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

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideHelp();
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (event.key === "l") lock();
      if (event.key === "r") refresh();
    });
  }

  async function boot() {
    initTheme();
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
