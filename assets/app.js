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
    te: "How hard your workout was for you, Garmin-style. Aerobic counts steady effort (light to vigorous heart-rate zones); anaerobic counts all-out bursts (peak zone). 5.0 means as hard as your toughest recent sessions.",
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

    const blocks = [];
    if (has(recovery.score)) {
      blocks.push(scoreBlock({
        help: "recovery", label: "Recovery",
        figure: Math.round(recovery.score),
        unit: "%",
        ratio: recovery.score / 100,
        color: toneColor(recovery.band),
        band: recovery.band,
        sub: has(today.hrv && today.hrv.delta_pct) ? `HRV ${signed(today.hrv.delta_pct, 0, "%")} vs your median` : "",
      }));
    }
    const readiness = today.readiness || {};
    if (has(readiness.score)) {
      blocks.push(scoreBlock({
        help: "readiness", label: "Training readiness",
        figure: Math.round(readiness.score),
        unit: "",
        ratio: readiness.score / 100,
        color: toneColor(readiness.band),
        band: readiness.band,
        sub: "Recovery, tempered by load trend",
      }));
    }
    // Sleep performance: hours slept against the night's need, the same idea
    // WHOOP uses. Not the device's composite score.
    if (has(sleep.minutes) && sleep.need_minutes) {
      const pct = Math.min(100, (sleep.minutes / sleep.need_minutes) * 100);
      blocks.push(scoreBlock({
        help: "sleep_perf", label: "Sleep performance",
        figure: Math.round(pct),
        unit: "%",
        ratio: pct / 100,
        color: cssVar("--sleep"),
        bandText: pct >= 100 ? "Need met" : sleep.debt_minutes ? "Short of need" : "Near need",
        sub: `${hm(sleep.minutes)} of ${hm(sleep.need_minutes)} needed`,
      }));
    }
    // Training load is the acute:chronic minutes ratio, shown as itself rather
    // than rescaled to look like a proprietary strain score.
    if (has(load.acwr)) {
      blocks.push(scoreBlock({
        help: "load", label: "Training load",
        figure: load.acwr.toFixed(2),
        unit: "",
        ratio: Math.min(2, load.acwr) / 2,
        color: cssVar("--strain"),
        band: load.acwr_band,
        sub: `${num(load.acute_minutes)} min this week vs ${num(load.chronic_minutes)} usual`,
      }));
    }

    const device = (data.device && data.device.name) || "Fitbit";
    const dateText = today.date
      ? new Date(today.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })
      : "";
    const lede = recovery.band && recovery.band.plain ? recovery.band.plain : (data.clinical && data.clinical.headline) || "";

    slot("today").innerHTML = `<div class="hero">
      <div class="hero-meta">${esc(dateText)} · ${esc(device)}</div>
      <h1>${esc(has(recovery.score) ? `${bandLabel(recovery.band)} recovery` : "Today")}</h1>
      ${lede ? `<p class="hero-lede">${esc(lede)}</p>` : ""}
      ${blocks.length ? `<div class="scores">${blocks.join("")}</div>` : ""}
      <p class="calc-note">Scores are calculated from your own measurements by fixed rules. They are not WHOOP, Apple or Garmin scores.</p>
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
      ? `<div class="tiles">${rows.map((r) => `<div class="tile">
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

    slot("sleep").innerHTML = `<div class="grid cols-2-3">
      <div class="card">
        <div class="label">Last night${info("stages")}</div>
        <div class="figure">${hm(sleep.minutes)}</div>
        ${has(sleep.score) ? `<div class="sub">Score ${num(sleep.score)} of 100 · ${esc(bandLabel(sleep.band))}</div>` : ""}
        ${total ? `<div class="stagebar" role="img" aria-label="Sleep stages">${stageDefs
          .map(([, key, color]) => `<i style="width:${(stages[key] / total) * 100}%;background:var(${color})"></i>`).join("")}</div>
          <div class="legend">${stageDefs
            .map(([label, key, color]) => `<span><i style="background:var(${color})"></i>${label} <b>${hm(stages[key])}</b></span>`).join("")}</div>` : ""}
        ${kv.length ? `<dl class="kv">${kv.map(([k, v]) => `<div><dt>${k}${info({ "Efficiency": "efficiency", "Sleep debt, 14 nights": "debt", "Consistency": "consistency", "Social jetlag": "jetlag" }[k])}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
      </div>
      <div class="card">
        <div class="card-head"><h3>Last ${Math.min(21, history.length)} nights</h3><span class="faint small">Hover for detail</span></div>
        <div class="chart"><canvas id="sleepChart"></canvas><div id="sleepTip" class="tooltip"></div></div>
        <div class="legend">${[["Deep", "--sleep-deep"], ["REM", "--sleep-rem"], ["Light", "--sleep-light"], ["Awake", "--sleep-awake"]]
          .map(([l, c]) => `<span><i style="background:var(${c})"></i>${l}</span>`).join("")}</div>
      </div>
    </div>
    ${history.some((r) => has(r.bed_minutes)) ? `<div class="card" style="margin-top:16px">
      <div class="card-head"><h3>Sleep timing${info("jetlag")}</h3>${jet.available ? status(jet.band, `Social jetlag ${hm(jet.minutes)}`) : ""}</div>
      <div class="chart"><canvas id="timingChart"></canvas><div id="timingTip" class="tooltip"></div></div>
      <div class="legend"><span><i style="background:var(--sleep)"></i>Weeknight</span><span><i style="background:var(--sleep-rem)"></i>Weekend</span></div>
      ${jet.available ? `<p class="note">${esc(jet.band.plain)} You sleep ${jet.later_on_free_days ? "later" : "earlier"} on weekends, by ${hm(jet.minutes)} at mid-sleep.</p>${study(jet.evidence)}` : ""}
    </div>` : ""}`;

    const timingRows = history.slice(-28).map((r) => {
      const [y, mo, d] = r.date.split("-").map(Number);
      const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      return { date: r.date, bed: r.bed_minutes, wake: r.wake_minutes, bedText: r.bed, wakeText: r.wake, weekend: dow === 0 || dow === 6 };
    });
    chart("timingChart", (canvas) => window.Viz.timing(canvas, {
      rows: timingRows, height: 220, color: cssVar("--sleep"), weekendColor: cssVar("--sleep-rem"),
      tooltip: $("timingTip"),
      tipHTML: (i, r) => `<div class="tt-date">${shortDate(r.date)}${r.weekend ? " · weekend" : ""}</div>
        <div class="tt-row"><span>Asleep</span><b>${esc(r.bedText || "")}</b></div>
        <div class="tt-row"><span>Woke</span><b>${esc(r.wakeText || "")}</b></div>`,
    }));

    const rows = history.slice(-21).map((r) => ({
      date: r.date, deep: r.deep || 0, rem: r.rem || 0, light: r.light || 0, awake: r.awake || 0, minutes: r.minutes,
    }));
    chart("sleepChart", (canvas) => window.Viz.stacked(canvas, {
      rows,
      keys: ["deep", "rem", "light", "awake"],
      colors: ["--sleep-deep", "--sleep-rem", "--sleep-light", "--sleep-awake"].map(cssVar),
      height: 240,
      format: (v) => `${Math.round(v / 60)}h`,
      tooltip: $("sleepTip"),
      tipHTML: (i, r) => `<div class="tt-date">${shortDate(r.date)}</div>
        <div class="tt-row"><span>Asleep</span><b>${hm(r.minutes)}</b></div>
        <div class="tt-row"><span>Deep</span><b>${hm(r.deep)}</b></div>
        <div class="tt-row"><span>REM</span><b>${hm(r.rem)}</b></div>
        <div class="tt-row"><span>Awake</span><b>${hm(r.awake)}</b></div>`,
    }));
  }

  /* --------------------------------------------------------------- heart -- */
  function renderHeart(data) {
    const h = data.history || {};
    const t = data.today || {};
    const b = data.baselines || {};
    const hrv = (h.hrv || []).slice(-60);
    const rhr = (h.rhr || []).slice(-60);
    const hr = h.hr_intraday || [];
    const mk = data.markers || {};
    // The device's own VO2 max when it sent one; otherwise the labelled estimate.
    const vo2 = (h.vo2max || []).length ? h.vo2max : (mk.vo2max && mk.vo2max.series) || [];
    const vo2Est = !!(mk.vo2max && mk.vo2max.estimated);

    const cards = [];
    if (hrv.length) cards.push(`<div class="card">
      <div class="card-head"><h3>Heart rate variability${info("hrv")}</h3><span class="faint small">${hrv.length} nights</span></div>
      <div class="figure">${num(t.hrv && t.hrv.ms)}<small>ms</small></div>
      <div class="sub">Median ${num(b.hrv_ms)} ms</div>
      <div class="chart" style="margin-top:16px"><canvas id="hrvChart"></canvas><div id="hrvTip" class="tooltip"></div></div>
    </div>`);
    if (rhr.length) cards.push(`<div class="card">
      <div class="card-head"><h3>Resting heart rate${info("rhr")}</h3><span class="faint small">${rhr.length} days</span></div>
      <div class="figure">${num(t.rhr && t.rhr.bpm)}<small>bpm</small></div>
      <div class="sub">Median ${num(b.rhr_bpm)} bpm</div>
      <div class="chart" style="margin-top:16px"><canvas id="rhrChart"></canvas><div id="rhrTip" class="tooltip"></div></div>
    </div>`);
    const hrCard = hr.length > 1 ? `<div class="card" style="grid-column:1 / -1">
      <div class="card-head"><h3>Heart rate, last 24 hours</h3><span class="faint small">Hourly averages</span></div>
      <div class="chart"><canvas id="hrChart"></canvas></div>
    </div>` : "";
    if (vo2.length > 1) cards.push(`<div class="card">
      <div class="card-head"><h3>Cardio fitness${info("vo2")}</h3><span class="faint small">${vo2Est ? "Estimated from resting HR and age" : "Device VO₂ max"}</span></div>
      <div class="figure">${num(vo2[vo2.length - 1].value, 1)}<small>ml/kg/min</small></div>
      <div class="sub">${signed(vo2[vo2.length - 1].value - vo2[0].value, 1, "")} since ${shortDate(vo2[0].date)}</div>
      ${vo2Est ? study(mk.vo2max.method) : ""}
      <div class="chart" style="margin-top:16px"><canvas id="vo2Chart"></canvas><div id="vo2Tip" class="tooltip"></div></div>
    </div>`);

    const skin = (h.skin_temp || []).slice(-60);
    if (skin.length > 1) cards.push(`<div class="card">
      <div class="card-head"><h3>Skin temperature${info("skin")}</h3><span class="faint small">${skin.length} nights</span></div>
      <div class="figure">${signed(skin[skin.length - 1].delta_c, 1, "")}<small>°C vs baseline</small></div>
      <div class="sub">Dashed line is your 30-night baseline</div>
      <div class="chart" style="margin-top:16px"><canvas id="skinChart"></canvas><div id="skinTip" class="tooltip"></div></div>
    </div>`);

    if (hrCard) cards.push(hrCard);
    slot("heart").innerHTML = cards.length
      ? `<div class="grid cols-2">${cards.join("")}</div>`
      : `<p class="muted">No heart data in this sync.</p>`;

    const line = (id, rows, key, unit, baseline, digits = 0) =>
      chart(id, (canvas) => window.Viz.line(canvas, {
        rows, key, color: cssVar("--chart"), height: 160,
        band: has(baseline) ? { value: baseline } : null,
        format: (v) => (digits ? v.toFixed(digits) : Math.round(v)),
        tooltip: $(id.replace("Chart", "Tip")),
        tipHTML: (i, r) => `<div class="tt-date">${shortDate(r.date)}</div><div class="tt-row"><span></span><b>${num(r[key], digits)} ${unit}</b></div>`,
      }));
    line("hrvChart", hrv, "ms", "ms", b.hrv_ms);
    line("rhrChart", rhr, "bpm", "bpm", b.rhr_bpm);
    line("vo2Chart", vo2, "value", "", null, 1);
    chart("skinChart", (canvas) => window.Viz.line(canvas, {
      rows: skin, key: "delta_c", color: cssVar("--chart"), height: 160, band: { value: 0 },
      format: (v) => v.toFixed(1),
      tooltip: $("skinTip"),
      tipHTML: (i, r) => `<div class="tt-date">${shortDate(r.date)}</div><div class="tt-row"><span></span><b>${signed(r.delta_c, 1, " °C")}</b></div>`,
    }));
    chart("hrChart", (canvas) => window.Viz.area(canvas, { rows: hr, color: cssVar("--chart"), height: 140 }));
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
        <div class="figure">${num(hs.week_ms, 1)}<small>ms, 7-night average</small></div>
        <div class="sub">Your usual range ${num(lo, 1)}–${num(hi, 1)} ms, from ${num(hs.baseline_nights)} nights</div>
        <div class="chart" style="margin-top:20px"><canvas id="hrvStatusChart"></canvas><div id="hrvStatusTip" class="tooltip"></div></div>
        <div class="legend"><span><i style="background:var(--chart)"></i>7-night average</span><span><i style="background:var(--faint);border-radius:50%"></i>Nightly</span><span><i style="background:var(--range-fill)"></i>Usual range</span></div>
        <p class="note">${esc(hs.band.plain)}${has(hs.cv_pct) ? ` Night-to-night variation ${num(hs.cv_pct, 1)}%.` : ""}</p>
        ${study(hs.evidence)}
      </div>`);
    }

    const rows = [];
    if (m.vo2max) rows.push({
      help: "vo2", name: "Cardio fitness",
      value: `${m.vo2max.estimated ? "≈ " : ""}${num(m.vo2max.value, 1)} ml/kg/min`,
      detail: `${num(m.vo2max.mets, 1)} METs${has(m.vo2max.change_mets) ? ` · ${signed(m.vo2max.change_mets, 1, " MET")} since ${shortDate(m.vo2max.since)}` : ""}`,
      ev: m.vo2max.evidence,
      viz: spark((m.vo2max.series || []).map((r) => r.value), cssVar("--chart")),
    });
    if (m.rhr_trend) rows.push({
      help: "rhr_trend", name: "Resting heart rate, 30 days",
      value: `${num(m.rhr_trend.mean_30d, 1)} bpm`,
      detail: `${signed(m.rhr_trend.change, 1, " bpm")} vs the 30 days before`,
      ev: m.rhr_trend.evidence,
      viz: spark(((data.history && data.history.rhr) || []).slice(-60).map((r) => r.bpm), cssVar("--chart")),
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
        viz: (() => {
          const band = range || m.steps.plateaus.under_60;
          const max = Math.max(12000, m.steps.mean_28d * 1.15);
          const tint = "var(--range-fill)";
          return scale(m.steps.mean_28d, 0, max, [[band[0], band[1], tint]],
            [[0, "0"], [band[0], num(band[0])], [band[1], num(band[1])]]);
        })(),
      });
    }
    if (has(m.bmi)) rows.push({
      help: "bmi", name: "Body mass index",
      value: num(m.bmi, 1),
      detail: "From the height and weight in your profile. WHO bands shown",
      ev: null,
      viz: scale(m.bmi, 15, 35, [
        [15, 18.5, "var(--seg-1)"], [18.5, 25, "var(--range-fill)"], [25, 30, "var(--seg-2)"], [30, 35, "var(--seg-3)"],
      ], [[18.5, "18.5"], [25, "25"], [30, "30"]]),
    });

    if (rows.length) cards.push(`<div class="card">
      <div class="card-head"><h3>Heart and metabolic markers</h3></div>
      ${rows.map((r) => `<div class="marker">
        <div class="marker-head"><span>${esc(r.name)}${info(r.help)}</span><b class="tnum">${esc(r.value)}</b></div>
        <div class="sub">${esc(r.detail)}</div>
        ${r.viz ? `<div class="marker-viz">${r.viz}</div>` : ""}
        ${study(r.ev)}
      </div>`).join("")}
      <p class="note">Research context, not a diagnosis or a personal risk estimate. Insulin resistance and blood glucose are not estimated:
        ${m.metabolic_evidence ? esc(m.metabolic_evidence.not) : "they need blood tests."}</p>
    </div>`);

    $("markers").hidden = !cards.length;
    slot("markers").innerHTML = cards.length ? `<div class="grid cols-2">${cards.join("")}</div>` : "";

    if (hs.available) {
      // Display-only rolling mean, matching the 7-night window the status reads.
      const nights = ((data.history && data.history.hrv) || []).slice(-66);
      const rows = nights.map((row, i) => {
        const week = nights.slice(Math.max(0, i - 6), i + 1).map((r) => r.ms).filter(has);
        return { date: row.date, ms: row.ms, avg: week.length >= 5 ? week.reduce((a, b) => a + b, 0) / week.length : null };
      }).slice(-60);
      chart("hrvStatusChart", (canvas) => window.Viz.line(canvas, {
        rows, key: "avg", dotsKey: "ms", range: hs.range_ms, color: cssVar("--chart"), height: 170,
        format: (v) => Math.round(v),
        tooltip: $("hrvStatusTip"),
        tipHTML: (i, r) => `<div class="tt-date">${shortDate(r.date)}</div>
          <div class="tt-row"><span>7-night average</span><b>${num(r.avg, 1)} ms</b></div>
          <div class="tt-row"><span>That night</span><b>${num(r.ms)} ms</b></div>`,
      }));
    }
  }

  /** Inline SVG sparkline; the last point is marked. */
  function spark(values, color) {
    const v = values.filter(has);
    if (v.length < 2) return "";
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    const pts = v.map((y, i) => [(i / (v.length - 1)) * 196 + 2, 30 - ((y - lo) / span) * 26]);
    const [lx, ly] = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 200 34" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")}" fill="none" stroke="${color}" stroke-width="1.75" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      <circle cx="${lx}" cy="${ly}" r="2.5" fill="${color}" />
    </svg>`;
  }

  /** A horizontal scale with shaded segments and a marker at `value`. */
  function scale(value, min, max, segments, labels) {
    const pos = (x) => Math.max(0, Math.min(100, ((x - min) / (max - min)) * 100));
    return `<div class="scale" role="img">
      ${segments.map(([a, b, color]) => `<span class="seg" style="left:${pos(a)}%;width:${pos(b) - pos(a)}%;background:${color}"></span>`).join("")}
      <span class="mark" style="left:${pos(value)}%"></span>
    </div>
    <div class="scale-labels">${labels.map(([x, text]) => `<span style="left:${pos(x)}%">${text}</span>`).join("")}</div>`;
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
    if (has(steps.count)) stats.push(`<div class="card">
      <div class="label">Steps today</div>
      <div class="figure">${num(steps.count)}</div>
      <div class="sub">of ${num(steps.goal)} target</div>
      <div class="progress"><i class="${steps.pct >= 100 ? "done" : ""}" style="width:${Math.min(100, steps.pct || 0)}%"></i></div>
    </div>`);
    if (has(week.minutes)) stats.push(`<div class="card">
      <div class="label">Active minutes, this week${info("active")}</div>
      <div class="figure">${num(week.minutes)}</div>
      <div class="sub">of ${num(week.target)} min${week.days && week.days < 7 ? ` · ${num(week.days)} of 7 days` : ""}</div>
      <div class="progress"><i class="${week.pct >= 100 ? "done" : ""}" style="width:${Math.min(100, week.pct || 0)}%"></i></div>
    </div>`);
    if (has(calories.today)) stats.push(`<div class="card">
      <div class="label">Calories today</div>
      <div class="figure">${num(calories.today)}</div>
      ${has(calories.mean_7d) ? `<div class="sub">7-day average ${num(calories.mean_7d)}</div>` : ""}
    </div>`);
    if (has(steps.mean_7d)) stats.push(`<div class="card">
      <div class="label">Steps, 7-day average</div>
      <div class="figure">${num(steps.mean_7d)}</div>
      ${has(steps.mean_28d) ? `<div class="sub">28-day average ${num(steps.mean_28d)}</div>` : ""}
    </div>`);

    const days = Array.isArray(load.daily) ? load.daily : [];
    const maxMinutes = Math.max(0, ...days.map((d) => Number(d.minutes) || 0));
    const loadCard = has(load.acwr) && exerciseLive ? `<div class="card">
      <div class="card-head"><h3>Training load${info("load")}</h3>${status(load.acwr_band)}</div>
      <div class="figure">${load.acwr.toFixed(2)}<small>acute : chronic</small></div>
      <div class="sub">${num(load.acute_minutes)} min in 7 days against ${num(load.chronic_minutes)} min per usual week · ${num(load.sessions_28d)} sessions in 28 days</div>
      ${load.acwr_band && load.acwr_band.plain ? `<p class="note">${esc(load.acwr_band.plain)}</p>` : ""}
      <div class="daybars" role="img" aria-label="Training minutes per day, 28 days">${days.map((d) => {
        const m = Math.max(0, Number(d.minutes) || 0);
        return `<span class="${m ? "" : "empty"}" style="height:${maxMinutes ? Math.max(4, (m / maxMinutes) * 100) : 0}%" title="${esc(d.date)}: ${m ? m + " min" : "rest"}"></span>`;
      }).join("")}</div>
      <div class="axis"><span>28 days ago</span><span>Today</span></div>
    </div>` : "";

    const stepRows = (h.steps || []).slice(-30).map((r) => ({ date: r.date, value: r.count }));
    const stepsCard = stepRows.length ? `<div class="card">
      <div class="card-head"><h3>Steps, 30 days</h3><span class="faint small">Line is your ${num(steps.goal)} target</span></div>
      <div class="chart"><canvas id="stepsChart"></canvas><div id="stepsTip" class="tooltip"></div></div>
    </div>` : "";

    const sessions = exerciseLive ? (h.exercise || []).filter((s) => s.date).slice(-6).reverse() : [];
    const workouts = sessions.length ? `<div class="card">
      <div class="card-head"><h3>Recent workouts</h3></div>
      <div class="list">${sessions.map((s) => `<div class="list-row">
        <span class="muted tnum">${shortDate(s.date)}</span>
        <span>${esc((s.type || s.name || "Workout").replace(/^./, (c) => c.toUpperCase()))}</span>
        <span class="meta">${[hm(s.minutes), has(s.avg_hr) ? `${num(s.avg_hr)} bpm` : "", has(s.distance_m) ? `${num(s.distance_m / 1000, 1)} km` : ""].filter(Boolean).join(" · ")}</span>
      </div>`).join("")}</div>
    </div>` : "";

    // Garmin-style training effect, on a 0-5 scale relative to your own
    // hardest sessions (see bio_policy). Replaces the plain workout list.
    const te = (data.markers && data.markers.training_effect) || {};
    const gauge = (value, band, color) => `<div class="te-gauge" role="img" aria-label="${num(value, 1)} of 5">
      ${[0, 1, 2, 3, 4].map((i) => `<i style="--fill:${Math.max(0, Math.min(1, value - i)) * 100}%;--c:${color}"></i>`).join("")}
    </div>`;
    const typeName = (s) => esc((s.type || "Workout").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));
    const last = te.available ? te.sessions[te.sessions.length - 1] : null;
    const teCard = last ? `<div class="card">
      <div class="card-head"><h3>Training effect${info("te")}</h3><span class="faint small">Last workout · ${shortDate(last.date)} · ${typeName(last)} · ${hm(last.minutes)}</span></div>
      <div class="te-grid">
        <div>
          <div class="label">Aerobic</div>
          <div class="te-value">${num(last.aerobic, 1)}<small>/ 5</small></div>
          ${gauge(last.aerobic, last.aerobic_band, "var(--chart)")}
          <div class="te-band">${esc(bandLabel(last.aerobic_band))}</div>
        </div>
        <div>
          <div class="label">Anaerobic</div>
          <div class="te-value">${num(last.anaerobic, 1)}<small>/ 5</small></div>
          ${gauge(last.anaerobic, last.anaerobic_band, "var(--warn)")}
          <div class="te-band">${esc(bandLabel(last.anaerobic_band))}</div>
        </div>
      </div>
      <div class="list" style="margin-top:20px">${te.sessions.slice(0, -1).reverse().map((s) => `<div class="list-row te-row">
        <span class="muted tnum">${shortDate(s.date)}</span>
        <span>${typeName(s)} <span class="faint">· ${hm(s.minutes)}</span></span>
        <span class="meta"><b class="te-a">${num(s.aerobic, 1)}</b> aerobic · <b class="te-n">${num(s.anaerobic, 1)}</b> anaerobic</span>
      </div>`).join("")}</div>
      <p class="note">Scored against your own ${num(te.scale_sessions)} workouts from the last ${num(te.window_days)} days: 5.0 matches your hardest. This is not Garmin's Firstbeat score.</p>
      ${study(te.evidence)}
    </div>` : "";

    const heat = exerciseLive ? `<div class="card">
      <div class="card-head"><h3>Consistency, 13 weeks${info("heatmap")}</h3><span class="faint small">Darker is longer</span></div>
      <div class="heatmap-layout">
        <div class="heatmap-days" aria-hidden="true"><span>M</span><span></span><span>W</span><span></span><span>F</span><span></span><span>S</span></div>
        <div id="heatmap" class="heatmap" role="img" aria-label="Training minutes by day over 13 weeks"></div>
      </div>
    </div>` : "";

    const mix = (data.markers && data.markers.intensity) || {};
    const mixCard = mix.available ? `<div class="card">
      <div class="card-head"><h3>Aerobic vs high intensity${info("intensity")}</h3>${status(mix.band)}</div>
      <div class="figure">${num(100 - mix.pct_hard)}<small>% easy</small></div>
      <div class="sub">Heart-rate zone time across ${num(mix.sessions)} workouts, ${num(mix.window_days)} days</div>
      <div class="stagebar"><i style="width:${100 - mix.pct_hard}%;background:var(--chart)"></i><i style="width:${mix.pct_hard}%;background:var(--warn)"></i></div>
      <div class="legend">
        <span><i style="background:var(--chart)"></i>Aerobic, light + moderate <b>${hm(mix.easy_minutes)}</b></span>
        <span><i style="background:var(--warn)"></i>High intensity, vigorous + peak <b>${hm(mix.hard_minutes)}</b></span>
      </div>
      <p class="note">${esc(mix.band.plain)}</p>
      ${study(mix.evidence)}
    </div>` : "";

    const pair = (a, b) => (a && b ? `<div class="grid cols-2">${a}${b}</div>` : a || b);
    slot("activity").innerHTML = [
      stats.length ? `<div class="grid cols-4">${stats.join("")}</div>` : "",
      pair(loadCard, mixCard),
      pair(stepsCard, heat),
      teCard || workouts,
    ].filter(Boolean).join('<div style="height:16px"></div>') || `<p class="muted">No activity in this sync.</p>`;

    chart("stepsChart", (canvas) => window.Viz.bars(canvas, {
      rows: stepRows, key: "value", color: cssVar("--chart"), goal: steps.goal, height: 180,
      format: (v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)),
      tooltip: $("stepsTip"),
      tipHTML: (i, r) => `<div class="tt-date">${shortDate(r.date)}</div><div class="tt-row"><span>Steps</span><b>${num(r.value)}</b></div>`,
    }));
    renderHeatmap(data);
  }

  function renderHeatmap(data) {
    const container = $("heatmap");
    if (!container) return;
    // 13 Monday-first weeks ending this week, built in UTC so a timezone ahead
    // of UTC cannot shift every cell by a day.
    const byDate = {};
    ((data.history && data.history.exercise) || []).forEach((s) => {
      if (s.date) byDate[s.date] = (byDate[s.date] || 0) + (s.minutes || 0);
    });
    const todayISO = (data.today && data.today.date) || new Date().toISOString().slice(0, 10);
    const [y, m, d] = todayISO.split("-").map(Number);
    const todayUTC = Date.UTC(y, m - 1, d);
    const monday = todayUTC - ((new Date(todayUTC).getUTCDay() + 6) % 7) * 86400000;
    const start = monday - 12 * 7 * 86400000;
    let html = "";
    for (let i = 0; i < 91; i += 1) {
      const stamp = start + i * 86400000;
      const iso = new Date(stamp).toISOString().slice(0, 10);
      if (stamp > todayUTC) {
        html += `<div class="heat-cell future"></div>`;
        continue;
      }
      const min = byDate[iso] || 0;
      const level = min === 0 ? 0 : min < 25 ? 1 : min < 45 ? 2 : min < 70 ? 3 : 4;
      html += `<div class="heat-cell" data-level="${level}" title="${iso}: ${min ? min + " min" : "rest"}"></div>`;
    }
    container.innerHTML = html;
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
    $("syncText").textContent = data.generated_at
      ? "Synced " + new Date(data.generated_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : "";
    const banner = $("staleBanner");
    if (data.generated_at) {
      const hours = (Date.now() - new Date(data.generated_at).getTime()) / 3600000;
      const staleAfter = (data.policy && data.policy.stale_after_hours) || 30;
      banner.hidden = hours <= staleAfter;
      banner.textContent = `This data is ${Math.round(hours)} hours old. The daily sync has not published since ${new Date(data.generated_at).toLocaleString()}.`;
    }
  }

  /* -------------------------------------------------------------- charts -- */
  function chart(id, draw) {
    const canvas = $(id);
    if (!canvas || !window.Viz) return;
    const run = () => draw(canvas);
    window.Viz.register(canvas, run);
    run();
  }

  /* -------------------------------------------------------------- render -- */
  function render(data) {
    state.payload = data;
    hideHelp();
    if (window.Viz) window.Viz.reset();
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
    if (window.Viz) window.Viz.reset();
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

    const links = Array.from(document.querySelectorAll(".nav a"));
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          links.forEach((link) =>
            link.setAttribute("aria-current", String(link.getAttribute("href") === "#" + entry.target.id))
          );
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
