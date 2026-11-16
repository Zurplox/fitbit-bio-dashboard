/* ==========================================================================
   Meridian Air — render layer
   One decrypt boundary, one render pass, no arithmetic on thresholds: every
   band, tone and label arrives resolved in the payload.
   ========================================================================== */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = { payload: null, passphrase: null, theme: null };

  /* ------------------------------------------------------------- helpers -- */
  const DASH = "--";

  function num(value, digits = 0) {
    if (value === null || value === undefined || Number.isNaN(value)) return DASH;
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function hm(minutes) {
    if (minutes === null || minutes === undefined) return DASH;
    const total = Math.round(minutes);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  }

  function signed(value, digits, suffix) {
    if (value === null || value === undefined) return DASH;
    const rounded = Number(value).toFixed(digits);
    return (value > 0 ? "+" : "") + rounded + (suffix || "");
  }

  function bandTone(band) {
    return (band && band.tone) || "neutral";
  }

  function bandLabel(band) {
    return (band && band.label) || "Not measured";
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value === null || value === undefined ? DASH : value;
  }

  function setHTML(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }

  function escapeHTML(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  function shortDate(iso) {
    if (!iso) return "";
    const [, month, day] = iso.slice(0, 10).split("-");
    return `${day}/${month}`;
  }

  /* -------------------------------------------------------------- vault --- */
  function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function decryptVault(passphrase) {
    const response = await fetch("data/biometrics.enc.json?ts=" + Date.now(), {
      cache: "no-store",
    });
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
      "raw",
      new TextEncoder().encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: Number(envelope.iterations),
        hash: "SHA-256",
      },
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
    const button = $("btnTheme");
    if (button) button.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    if (state.payload && window.Viz) window.Viz.redrawAll();
  }

  function initTheme() {
    let stored = null;
    try {
      stored = localStorage.getItem("ma-theme");
    } catch (error) {
      stored = null;
    }
    const preferred =
      stored ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark");
    applyTheme(preferred);
  }

  /* ---------------------------------------------------------------- hero -- */
  function renderHero(data) {
    const today = data.today || {};
    setText("heroHeadline", data.clinical ? data.clinical.headline : "");
    setText(
      "heroLede",
      (data.clinical && data.clinical.paragraphs && data.clinical.paragraphs[0] &&
        data.clinical.paragraphs[0].plain) ||
        "No narrative in this payload."
    );

    // Health Connect can relay several apps into the same series, so the device
    // line names them instead of implying one watch produced everything.
    const deviceSources = ((data.device && data.device.sources) || []).filter(
      (label) => label !== (data.device && data.device.name)
    );
    setText(
      "metaDevice",
      ((data.device && data.device.name) || DASH) +
        (deviceSources.length ? " · " + deviceSources.join(", ") : "")
    );
    setText(
      "metaSync",
      data.generated_at ? new Date(data.generated_at).toLocaleString() : DASH
    );
    setText(
      "metaSource",
      (data.device && data.device.api ? data.device.api : "Google Health") +
        (data.demo ? " · demo" : "")
    );
    setText(
      "metaWindow",
      `${(data.history && data.history.sleep && data.history.sleep.length) || 0} nights · ${
        (data.history && data.history.rhr && data.history.rhr.length) || 0
      } days`
    );

    const demoChip = $("demoChip");
    if (demoChip) demoChip.hidden = !data.demo;

    const quality = data.data_quality || {};
    const liveChip = $("liveChip");
    if (liveChip) {
      const tone = quality.degraded && quality.degraded.length ? "warn" : "good";
      liveChip.className = `chip dot-${tone}`;
      liveChip.innerHTML = `<span class="dot"></span>${quality.live_count || 0}/${
        quality.total_count || 0
      } live`;
      liveChip.title = quality.degraded && quality.degraded.length
        ? "Not measured: " + quality.degraded.join(", ")
        : "Every metric group in this payload came from the API";
    }

    const banner = $("staleBanner");
    if (banner && data.generated_at) {
      const hours = (Date.now() - new Date(data.generated_at).getTime()) / 3600000;
      const staleAfter = (data.policy && data.policy.stale_after_hours) || 30;
      if (hours > staleAfter) {
        banner.hidden = false;
        banner.textContent = `This vault is ${Math.round(hours)} hours old. The daily sync has not published since ${new Date(
          data.generated_at
        ).toLocaleString()}.`;
      } else {
        banner.hidden = true;
      }
    }
  }

  /* --------------------------------------------------------- whoop ring band -- */
  const RING_CIRCUMFERENCE = 2 * Math.PI * 63;

  function setRing(arcId, ratio, color) {
    const arc = $(arcId);
    if (!arc) return;
    arc.setAttribute("stroke-dasharray", String(RING_CIRCUMFERENCE));
    // A missing value leaves the ring empty: an unfilled arc is honest, a
    // zero-length one at full opacity would read as a measurement of nothing.
    const bounded = ratio === null || ratio === undefined ? 0 : Math.max(0, Math.min(1, ratio));
    arc.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - bounded)));
    arc.style.stroke = color;
  }

  /** WHOOP shows strain on a 0-21 scale. The payload holds ACWR and minutes, so
   *  the ratio is mapped onto that span and labelled as what it is. */
  function strainFrom(load) {
    if (load.acwr === null || load.acwr === undefined) return null;
    return Math.max(0, Math.min(21, (load.acwr / 2) * 21));
  }

  function renderBand(data) {
    const today = data.today || {};
    const load = data.load || {};
    const recovery = today.recovery || {};
    const sleep = today.sleep || {};
    const hrv = today.hrv || {};
    const rhr = today.rhr || {};
    const spo2 = today.spo2 || {};

    const toneColor = (band) => {
      const tone = bandTone(band);
      return cssVar(tone === "neutral" ? "--accent" : `--${tone}`);
    };

    // ---- Recovery ring
    setRing("rcRecArc", (recovery.score ?? null) === null ? null : recovery.score / 100, toneColor(recovery.band));
    setText("rcRecScore", recovery.score === null || recovery.score === undefined ? DASH : Math.round(recovery.score));
    setText("rcRecBand", bandLabel(recovery.band));
    setHTML(
      "rcRecFoot",
      `HRV <b>${signed(hrv.delta_pct, 0, "%")}</b> vs your median<br/>` +
        `RHR <b>${num(rhr.bpm)}</b> bpm · SpO₂ <b>${num(spo2.pct, 1)}%</b>`
    );

    // ---- Strain ring
    const strain = strainFrom(load);
    setRing("rcStrArc", strain === null ? null : strain / 21, cssVar("--strain"));
    setText("rcStrScore", strain === null ? DASH : strain.toFixed(1));
    setText("rcStrBand", bandLabel(load.acwr_band));
    setHTML(
      "rcStrFoot",
      load.acwr === null || load.acwr === undefined
        ? "No sessions in the window"
        : `ACWR <b>${load.acwr.toFixed(2)}</b> · ${hm(load.acute_minutes)} trained this week`
    );

    // ---- Sleep ring: need met, not the device's composite score
    const needPct =
      sleep.minutes !== null && sleep.minutes !== undefined && sleep.need_minutes
        ? Math.min(100, (sleep.minutes / sleep.need_minutes) * 100)
        : null;
    setRing("rcSlpArc", needPct === null ? null : needPct / 100, cssVar("--sleep"));
    setText("rcSlpScore", needPct === null ? DASH : Math.round(needPct));
    setText("rcSlpBand", needPct === null ? DASH : needPct >= 100 ? "Fully repaid" : sleep.debt_minutes ? "In debt" : "At baseline");
    setHTML(
      "rcSlpFoot",
      `${hm(sleep.minutes)} of <b>${hm(sleep.need_minutes)}</b> need<br/>` +
        (sleep.debt_minutes ? `Debt <b>${hm(sleep.debt_minutes)}</b> over 14 nights` : `No accumulated debt`)
    );

    renderStrip(data);
  }

  function deltaCell(value, unit, invert) {
    // For HRV higher is better; for resting rate lower is better. `invert`
    // flips which colour means good, so both read as movement plus meaning.
    if (value === null || value === undefined) return '<div class="d flat">no baseline</div>';
    const good = invert ? value <= 0 : value >= 0;
    const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "•";
    const cls = value === 0 ? "flat" : good ? "up" : "down";
    return `<div class="d ${cls}">${arrow} ${Math.abs(value).toFixed(unit === "%" ? 0 : 1)}${unit}</div>`;
  }

  function renderStrip(data) {
    const container = $("strip");
    if (!container) return;
    const today = data.today || {};
    const steps = today.steps || {};
    const resp = today.resp || {};
    const readiness = today.readiness || {};

    const cells = [
      {
        k: "Readiness",
        v: readiness.score === null || readiness.score === undefined ? DASH : `${num(readiness.score)}<u>/100</u>`,
        d: `<div class="d ${bandTone(readiness.band) === "good" ? "up" : bandTone(readiness.band) === "bad" ? "down" : "flat"}">${escapeHTML(bandLabel(readiness.band))}</div>`,
      },
      { k: "Resting HR", v: `${num(today.rhr && today.rhr.bpm)}<u>bpm</u>`, d: deltaCell(today.rhr && today.rhr.delta, " bpm", true) },
      { k: "HRV", v: `${num(today.hrv && today.hrv.ms, 1)}<u>ms</u>`, d: deltaCell(today.hrv && today.hrv.delta_pct, "%", false) },
      { k: "Breathing", v: `${num(resp.brpm, 1)}<u>brpm</u>`, d: deltaCell(resp.delta, " brpm", true) },
      { k: "SpO₂", v: `${num(today.spo2 && today.spo2.pct, 1)}<u>%</u>`, d: `<div class="d flat">${num(today.spo2 && today.spo2.nights_recorded)} of ${num(today.spo2 && today.spo2.window_days)} nights</div>` },
      {
        k: "Steps",
        v: num(steps.count),
        d: steps.pct === null || steps.pct === undefined ? '<div class="d flat">not measured</div>' : `<div class="d ${steps.pct >= 100 ? "up" : "flat"}">${num(steps.pct)}% of ${num(steps.goal)}</div>`,
      },
    ];

    container.innerHTML = cells
      .map((cell) => `<div class="cell" role="listitem"><div class="k">${cell.k}</div><div class="v">${cell.v}</div>${cell.d}</div>`)
      .join("");
  }

  /* --------------------------------------------------------------- vitals -- */
  function renderVitals(data) {
    const today = data.today || {};
    const sleep = today.sleep || {};
    const hrv = today.hrv || {};
    const rhr = today.rhr || {};
    const spo2 = today.spo2 || {};
    const resp = today.resp || {};

    setText("kpiSleep", hm(sleep.minutes));
    setText("kpiSleepSub", `score ${num(sleep.score)} · need ${hm(sleep.need_minutes)}`);
    setHTML(
      "kpiSleepBand",
      `<span class="inline-band ${bandTone(sleep.band)}"><i></i>${escapeHTML(bandLabel(sleep.band))}</span>`
    );

    // A median is only a baseline once it has nights behind it. The payload
    // carries how many it used, so say so rather than letting two nights read
    // like a month.
    const hrvNights = (data.baselines && data.baselines.hrv_nights) || null;
    const hrvBasis =
      hrvNights !== null && hrvNights < 7
        ? ` from ${hrvNights} ${hrvNights === 1 ? "night" : "nights"}`
        : "";

    setText("kpiHrv", `${num(hrv.ms, 1)}`);
    setText(
      "kpiHrvSub",
      `median ${num(hrv.baseline, 1)} ms${hrvBasis} · ${signed(hrv.delta_pct, 0, "%")}`
    );
    setHTML(
      "kpiHrvBand",
      `<span class="inline-band ${bandTone(hrv.band)}"><i></i>${escapeHTML(bandLabel(hrv.band))}</span>`
    );

    setText("kpiRhr", `${num(rhr.bpm)}`);
    setText("kpiRhrSub", `median ${num(rhr.baseline)} bpm · ${signed(rhr.delta, 0, " bpm")}`);
    setHTML(
      "kpiRhrBand",
      `<span class="inline-band ${bandTone(rhr.band)}"><i></i>${escapeHTML(bandLabel(rhr.band))}</span>`
    );

    setText("kpiSpo2", `${num(spo2.pct, 1)}%`);
    setText(
      "kpiSpo2Sub",
      `${num(spo2.nights_recorded)} of ${num(spo2.window_days)} nights recorded · breathing ${num(
        resp.brpm,
        1
      )} brpm`
    );
    setHTML(
      "kpiSpo2Band",
      `<span class="inline-band ${bandTone(spo2.band)}"><i></i>${escapeHTML(bandLabel(spo2.band))}</span>`
    );

    // Sleep detail panel
    const stages = sleep.stages || {};
    const totalStage = (stages.deep || 0) + (stages.light || 0) + (stages.rem || 0) + (stages.awake || 0);
    [["Deep", "deep"], ["Light", "light"], ["REM", "rem"], ["Awake", "awake"]].forEach(([label, key]) => {
      const value = stages[key] || 0;
      const pct = totalStage ? (value / totalStage) * 100 : 0;
      const fill = $(`stage${label}`);
      if (fill) {
        fill.style.width = pct + "%";
        fill.style.background = `var(--${
          key === "deep" ? "sleep" : key === "rem" ? "hrv" : key === "awake" ? "bad" : "neutral"
        })`;
      }
      setText(`stage${label}Mins`, value ? `${Math.round(value)}m` : DASH);
    });

    setText("sleepBed", sleep.bed || DASH);
    setText("sleepWake", sleep.wake || DASH);
    setText("sleepEfficiency", sleep.efficiency === null || sleep.efficiency === undefined ? DASH : `${num(sleep.efficiency, 0)}%`);
    setText("sleepNeed", hm(sleep.need_minutes));
    setText("sleepDebt", sleep.debt_minutes ? hm(sleep.debt_minutes) : "none");
    setText("sleepNeedSource", sleep.need_source === "measured" ? "from your 14-night debt" : "adult floor");
    setText("sleepScoreBig", `${num(sleep.score)}`);
    setText("sleepScoreBand", bandLabel(sleep.band));

    const circadian = data.circadian || {};
    setText("circadianOnset", circadian.median_onset || DASH);
    setText("circadianSpread", circadian.spread_minutes !== undefined ? `${circadian.spread_minutes} min` : DASH);
    setText("circadianAlign", circadian.alignment_pct !== undefined ? `${circadian.alignment_pct}%` : DASH);
    setText("circadianTarget", circadian.bedtime_target || DASH);
  }

  /* --------------------------------------------------------------- charts -- */
  function renderCharts(data) {
    if (!window.Viz) return;
    window.Viz.reset();
    const history = data.history || {};

    const sleepRows = (history.sleep || []).slice(-21).map((row) => ({
      date: row.date,
      deep: row.deep || 0,
      light: row.light || 0,
      rem: row.rem || 0,
      awake: row.awake || 0,
      minutes: row.minutes,
    }));

    const sleepCanvas = $("sleepChart");
    if (sleepCanvas && sleepRows.length) {
      const draw = () =>
        window.Viz.stacked(sleepCanvas, {
          rows: sleepRows,
          keys: ["deep", "light", "rem", "awake"],
          colors: [cssVar("--sleep"), cssVar("--neutral"), cssVar("--hrv"), cssVar("--bad")],
          height: 210,
          format: (v) => `${Math.round(v / 60)}h`,
          tooltip: $("sleepTooltip"),
          tipHTML: (index, row) => `
            <div class="tt-date">${row.date}</div>
            <div class="tt-row"><span>Deep</span><b>${Math.round(row.deep)}m</b></div>
            <div class="tt-row"><span>REM</span><b>${Math.round(row.rem)}m</b></div>
            <div class="tt-row"><span>Light</span><b>${Math.round(row.light)}m</b></div>
            <div class="tt-row"><span>Awake</span><b>${Math.round(row.awake)}m</b></div>`,
        });
      window.Viz.register(sleepCanvas, draw);
      draw();
    }

    const hrvRows = (history.hrv || []).slice(-60);
    const hrvCanvas = $("hrvChart");
    if (hrvCanvas && hrvRows.length) {
      const draw = () =>
        window.Viz.line(hrvCanvas, {
          rows: hrvRows,
          key: "ms",
          color: cssVar("--hrv"),
          height: 190,
          band: data.baselines && data.baselines.hrv_ms !== null ? { value: data.baselines.hrv_ms } : null,
          format: (v) => Math.round(v),
          tooltip: $("hrvTooltip"),
          tipHTML: (index, row) => `
            <div class="tt-date">${row.date}</div>
            <div class="tt-row"><span>Overnight HRV</span><b>${num(row.ms, 1)} ms</b></div>`,
        });
      window.Viz.register(hrvCanvas, draw);
      draw();
    }

    const rhrRows = (history.rhr || []).slice(-60);
    const rhrCanvas = $("rhrChart");
    if (rhrCanvas && rhrRows.length) {
      const draw = () =>
        window.Viz.line(rhrCanvas, {
          rows: rhrRows,
          key: "bpm",
          color: cssVar("--rhr"),
          height: 190,
          band: data.baselines && data.baselines.rhr_bpm !== null ? { value: data.baselines.rhr_bpm } : null,
          format: (v) => Math.round(v),
          tooltip: $("rhrTooltip"),
          tipHTML: (index, row) => `
            <div class="tt-date">${row.date}</div>
            <div class="tt-row"><span>Resting rate</span><b>${num(row.bpm)} bpm</b></div>`,
        });
      window.Viz.register(rhrCanvas, draw);
      draw();
    }

    const hrCanvas = $("hrChart");
    const hrRows = history.hr_intraday || [];
    if (hrCanvas) {
      if (hrRows.length > 1) {
        const draw = () => window.Viz.area(hrCanvas, { rows: hrRows, color: cssVar("--rhr"), height: 150 });
        window.Viz.register(hrCanvas, draw);
        draw();
        if ($("hrEmpty")) $("hrEmpty").hidden = true;
      } else if ($("hrEmpty")) {
        $("hrEmpty").hidden = false;
      }
    }

    const stepRows = (history.steps || []).slice(-30).map((row) => ({
      date: row.date,
      value: row.count,
    }));
    const stepsCanvas = $("stepsChart");
    if (stepsCanvas && stepRows.length) {
      const goal = data.today && data.today.steps ? data.today.steps.goal : null;
      const draw = () =>
        window.Viz.bars(stepsCanvas, {
          rows: stepRows,
          key: "value",
          color: cssVar("--steps"),
          goal,
          height: 175,
          format: (v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)),
          tooltip: $("stepsTooltip"),
          tipHTML: (index, row) => `
            <div class="tt-date">${row.date}</div>
            <div class="tt-row"><span>Steps</span><b>${num(row.value)}</b></div>`,
        });
      window.Viz.register(stepsCanvas, draw);
      draw();
    }

    renderHeatmap(data);
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
  }

  /* ------------------------------------------------------------- heat map -- */
  function renderHeatmap(data) {
    const container = $("heatmap");
    if (!container) return;

    // 13 weeks of columns, Monday-first, ending with this week. Built in UTC so
    // a timezone ahead of UTC cannot shift every cell by a day, and anchored to
    // a Monday so the 7-row grid reads as weeks rather than as stripes.
    const byDate = {};
    ((data.history && data.history.exercise) || []).forEach((session) => {
      if (!session.date) return;
      byDate[session.date] = (byDate[session.date] || 0) + (session.minutes || 0);
    });

    const todayISO = (data.today && data.today.date) || new Date().toISOString().slice(0, 10);
    const [year, month, dayOfMonth] = todayISO.split("-").map(Number);
    const todayUTC = Date.UTC(year, month - 1, dayOfMonth);
    const dayOfWeek = new Date(todayUTC).getUTCDay(); // 0 = Sunday
    const mondayOfThisWeek = todayUTC - ((dayOfWeek + 6) % 7) * 86400000;
    const startUTC = mondayOfThisWeek - 12 * 7 * 86400000;

    container.innerHTML = "";
    for (let index = 0; index < 13 * 7; index += 1) {
      const stamp = startUTC + index * 86400000;
      const iso = new Date(stamp).toISOString().slice(0, 10);
      const cell = document.createElement("div");
      cell.className = "heat-cell";

      if (stamp > todayUTC) {
        cell.dataset.level = "0";
        cell.style.opacity = "0.35";
        cell.title = `${iso} — not yet`;
      } else {
        const minutes = byDate[iso] || 0;
        const level = minutes === 0 ? 0 : minutes < 25 ? 1 : minutes < 45 ? 2 : minutes < 70 ? 3 : 4;
        cell.dataset.level = String(level);
        cell.title = `${iso} — ${minutes ? minutes + " min trained" : "no session logged"}`;
      }
      container.appendChild(cell);
    }
  }

  /* ---------------------------------------------------------------- load --- */
  function renderLoad(data) {
    const load = data.load || {};
    const today = data.today || {};
    const dialSvg = $("loadDial");
    const band = load.acwr_band || {};

    if (dialSvg && load.acwr !== null && load.acwr !== undefined) {
      window.Viz &&
        window.Viz.dial(dialSvg, {
          value: Math.min(2, load.acwr) * 50,
          max: 100,
          color: cssVar(`--${bandTone(band) === "neutral" ? "neutral" : bandTone(band)}`),
        });
    }

    setText("loadScore", load.acwr !== null && load.acwr !== undefined ? load.acwr.toFixed(2) : DASH);
    setHTML(
      "loadBand",
      `<span class="inline-band ${bandTone(band)}"><i></i>${escapeHTML(bandLabel(band))}</span>`
    );
    setText(
      "loadText",
      load.acwr !== null && load.acwr !== undefined
        ? `${num(load.acute_minutes)} min in the last 7 days against ${num(
            load.chronic_minutes
          )} min/week chronic, from ${num(load.sessions_28d)} sessions.`
        : "Not enough logged sessions to compute a ratio."
    );
    setText("loadNote", band.plain || "");

    const steps = today.steps || {};
    setText("stepsBig", num(steps.count));
    setText("stepsGoal", `of ${num(steps.goal)} target`);
    setText("stepsMean", `7-day mean ${num(steps.mean_7d)} · 28-day mean ${num(steps.mean_28d)}`);

    const active = today.active_minutes || {};
    const week = active.week || {};
    setText("activeToday", num(active.today));
    setText("activeWeek", week.minutes !== null && week.minutes !== undefined ? `${num(week.minutes)} / ${num(week.target)} min` : DASH);
    setText("activePct", week.pct !== null && week.pct !== undefined ? `${num(week.pct)}%` : DASH);
    const bar = $("activeBar");
    if (bar) bar.style.width = Math.min(100, week.pct || 0) + "%";

    const calories = today.calories || {};
    setText("caloriesToday", num(calories.today));
    setText("caloriesMean", `7-day mean ${num(calories.mean_7d)}`);
    setText("vo2max", num(today.vo2max && today.vo2max.value, 1));
  }

  /* ------------------------------------------------------------- patterns -- */
  function renderPatterns(data) {
    const corr = data.correlations || {};
    const container = $("patternList");
    if (!container) return;
    setText(
      "patternNote",
      corr.findings && corr.findings.length
        ? `${corr.findings.length} patterns found in your last ${corr.window_days} days`
        : "No pattern strong enough to publish yet"
    );
    setText(
      "patternMethod",
      `Checked ${corr.tested_pairs || 0} curated pairs in a ${corr.window_days || 0}-day window. A pair needs at least ${
        corr.min_paired_days || 0
      } paired days and |r| ≥ ${corr.min_r || 0} to be published.`
    );

    container.innerHTML = "";
    (corr.findings || []).forEach((finding) => {
      const row = document.createElement("div");
      row.className = "pattern";
      row.innerHTML = `
        <div>
          <div class="line">
            <span>${escapeHTML(finding.a_label)}</span>
            <span class="dir">${finding.direction === "up" ? "↑ → ↑" : "↑ → ↓"}</span>
            <span>${escapeHTML(finding.b_label)}</span>
          </div>
          <div class="note">${escapeHTML(finding.plain)}</div>
          <button class="info-btn" data-info="why-${escapeHTML(finding.a)}-${escapeHTML(finding.b)}" aria-expanded="false" aria-label="Why these two move together">i</button>
          <div class="disclosure" id="why-${escapeHTML(finding.a)}-${escapeHTML(finding.b)}">${escapeHTML(
        finding.why
      )} <strong>This is an association, not a cause.</strong></div>
        </div>
        <div class="r"><b>${finding.r.toFixed(2)}</b><span>r · n=${finding.n}</span></div>`;
      container.appendChild(row);
    });

    if (!(corr.findings || []).length) {
      container.innerHTML =
        '<p class="muted">Nothing cleared both floors in this window. That is a result: it means the pairs you have were noise.</p>';
    }
  }

  /* ---------------------------------------------------------------- coach -- */
  function renderCoach(data) {
    const container = $("coachGrid");
    if (!container) return;
    const coaching = data.coaching || {};
    container.innerHTML = "";

    (coaching.cards || []).forEach((card) => {
      const el = document.createElement("article");
      el.className = "card coach-card reveal";
      const evidence = card.evidence || {};
      el.innerHTML = `
        <div class="card-head">
          <h3>${escapeHTML(card.title)}</h3>
          <span class="spacer"></span>
          <span class="chip dot-${card.tone === "good" ? "good" : card.tone === "warn" ? "warn" : card.tone === "bad" ? "bad" : "good"}">
            <span class="dot"></span>${card.measured ? "measured" : "not measured"}
          </span>
        </div>
        <p class="reading">${escapeHTML(card.reading)}</p>
        <p class="action">${escapeHTML(card.action)}</p>
        <div class="lines">
          <div><dt>Progress</dt><dd>${escapeHTML(card.progress)}</dd></div>
          <div><dt>Back off</dt><dd>${escapeHTML(card.back_off)}</dd></div>
        </div>
        <button class="info-btn" data-info="ev-${escapeHTML(card.key)}" aria-expanded="false" aria-label="Evidence behind this rule">i</button>
        <div class="disclosure" id="ev-${escapeHTML(card.key)}">
          <strong>${escapeHTML(evidence.cite || "No citation")}</strong> found that ${escapeHTML(
        evidence.found || ""
      )} It does not settle: ${escapeHTML(evidence.not || "")}
        </div>`;
      container.appendChild(el);
    });
  }

  /* ----------------------------------------------------------- provenance -- */
  // Which app or device produced each metric. Fitbit writes its own points;
  // Garmin, Google Fit and the phone's step counter arrive relayed by Health
  // Connect, and the API hands them over as one series without saying so.
  function renderSources(data) {
    const metrics = (data.sources && data.sources.metrics) || {};



    // Attribute each visible metric group. Never infer a make/model when the
    // Google Health API did not return source metadata for the sampled points.
    const specs = {
      "Sleep": ["sleep", true],
      "Overnight HRV": ["hrv", false],
      "Resting rate": ["rhr", false],
      "Blood oxygen": ["spo2", false],
      "Nightly stages": ["sleep", false],
      "Last night": ["sleep", true],
      "The night in clocks": ["sleep", true],
      "Circadian timing": ["sleep", true],
      "Resting heart rate": ["rhr", false],
      "Today's heart rate": ["heart_rate", false],
      "Workload balance": ["", true],
      "This week": ["active_minutes,calories,vo2max", false],
      "Steps": ["steps", false],
      "Training consistency": ["exercise", false],
      "Correlations": ["", true],
    };
    const badge = (key) => {
      const entry = key && metrics[key];
      const node = document.createElement("span");
      node.className = "source-badge";
      if (!entry) {
        node.classList.add("unreported");
        node.textContent = "Source unreported";
        node.title = "The API did not provide source attribution for this metric sample.";
      } else {
        const names = (entry.sources || []).map((item) => item.label).filter(Boolean);
        const unique = [...new Set(names)];
        node.classList.toggle("mixed", unique.length > 1);
        node.textContent = unique.length > 1 ? `${entry.dominant} +${unique.length - 1}` : (entry.dominant || unique[0] || "Source reported");
        node.title = `${entry.label || key}: ${(entry.sources || []).map((item) => `${item.label}: ${item.points}`).join(" · ")} (${entry.sampled || 0} sampled points)`;
      }
      return node;
    };
    const addBadges = (host, keys, derived) => {
      if (!host || host.querySelector(":scope > .source-badges")) return;
      const group = document.createElement("span");
      group.className = "source-badges";
      (keys || []).filter(Boolean).forEach((key) => group.appendChild(badge(key)));
      if (derived) {
        const item = document.createElement("span");
        item.className = "source-badge derived";
        item.textContent = "Derived";
        item.title = "Calculated by Meridian from measured data and documented rules.";
        group.appendChild(item);
      }
      if (group.childElementCount) host.appendChild(group);
    };
    document.querySelectorAll(".card-head").forEach((head) => {
      const title = head.querySelector(".card-title, h3");
      if (!title) return;
      const spec = specs[title.textContent.trim()];
      if (spec) addBadges(title.parentElement, spec[0].split(","), spec[1]);
      else if (title.tagName === "H3") addBadges(title.parentElement, [], true);
    });
    document.querySelectorAll(".ringcard").forEach((card, index) => {
      const foot = card.querySelector(".ringfoot");
      const keys = [["hrv", "rhr", "spo2"], [], ["sleep"]][index] || [];
      addBadges(foot, keys, true);
    });
    document.querySelectorAll("#strip .cell").forEach((cell, index) => {
      const keys = [[""], ["rhr"], ["hrv"], ["resp"], ["spo2"], ["steps"]][index] || [];
      addBadges(cell, keys, index === 0);
    });

    const box = $("sources");
    if (!box) return;
    const devices = (data.sources && data.sources.devices) || [];
    box.innerHTML = devices
      .map(
        (device) =>
          `<div class="source-item"><span class="dot ${
            device.platform === "FITBIT" ? "own" : "relay"
          }"></span><b>${escapeHTML(device.label)}</b><span>${escapeHTML(
            device.metrics.join(" · ")
          )}</span></div>`
      )
      .join("");
  }

  function renderProvenance(data) {
    const container = $("provenance");
    if (!container) return;
    const quality = data.data_quality || {};
    container.innerHTML = "";
    Object.values(quality.metrics || {}).forEach((metric) => {
      const el = document.createElement("div");
      el.className = "prov-item";
      el.innerHTML = `<span class="name">${escapeHTML(metric.label)} <span class="faint">· ${
        metric.source === "live" ? "live" : "missing"
      }</span></span><span class="note">${escapeHTML(metric.note || "")}</span>`;
      container.appendChild(el);
    });

    const clinical = data.clinical || {};
    setText(
      "footerMeta",
      `Scores: ${clinical.score_source || "deterministic"} · Narrative: ${
        clinical.narrative_source || "rules"
      } · Schema ${data.schema || 1}`
    );
    setText("footerSync", data.generated_at ? new Date(data.generated_at).toLocaleString() : DASH);
    setText("footerTz", data.timezone || DASH);
  }

  /* ---------------------------------------------------------------- render -- */
  function render(data) {
    state.payload = data;
    renderBand(data);
    renderHero(data);
    renderVitals(data);
    renderLoad(data);
    renderPatterns(data);
    renderCoach(data);
    renderSources(data);
    renderProvenance(data);
    renderCharts(data);
    attachDisclosures();
    observeReveals();
  }

  function attachDisclosures() {
    document.querySelectorAll(".info-btn").forEach((button) => {
      if (button.dataset.bound) return;
      button.dataset.bound = "1";
      button.addEventListener("click", () => {
        const target = document.getElementById(button.dataset.info);
        if (!target) return;
        const open = target.classList.toggle("open");
        button.setAttribute("aria-expanded", String(open));
      });
    });
  }

  function observeReveals() {
    if (!("IntersectionObserver" in window)) {
      document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
      return;
    }
    let revealed = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            revealed += 1;
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "-40px 0px -8% 0px", threshold: 0.02 }
    );
    document.querySelectorAll(".reveal:not(.in)").forEach((el) => observer.observe(el));

    // Failsafe, not a schedule: if the observer has revealed nothing at all the
    // animation is broken, so publish every card. A working observer keeps the
    // reveal tied to the reader's scroll instead of firing on a timer.
    window.setTimeout(() => {
      if (revealed > 0) return;
      document.querySelectorAll(".reveal:not(.in)").forEach((el) => el.classList.add("in"));
    }, 2500);
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
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    await idbRun("readwrite", (store) => store.put(key, REMEMBER.key));
    return key;
  }

  async function rememberPassphrase(passphrase) {
    try {
      const key = await deviceKey(true);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(passphrase)
      );
      await idbRun("readwrite", (store) =>
        store.put(
          { iv: Array.from(iv), sealed: Array.from(new Uint8Array(sealed)), at: Date.now() },
          REMEMBER.wrapped
        )
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
        { name: "AES-GCM", iv: new Uint8Array(record.iv) },
        key,
        new Uint8Array(record.sealed)
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

  // Everything the render pass writes into, so locking can actually empty it.
  // Hiding a container is not purging: the text would still sit in the DOM.
  const RENDERED_IDS = [
    "rcRecScore", "rcRecBand", "rcRecFoot", "rcStrScore", "rcStrBand", "rcStrFoot",
    "rcSlpScore", "rcSlpBand", "rcSlpFoot",
    "heroHeadline", "heroLede", "metaDevice", "metaSync",
    "metaSource", "metaWindow", "kpiSleep", "kpiSleepSub", "kpiSleepBand", "kpiHrv", "kpiHrvSub",
    "kpiHrvBand", "kpiRhr", "kpiRhrSub", "kpiRhrBand", "kpiSpo2", "kpiSpo2Sub", "kpiSpo2Band",
    "sleepScoreBig", "sleepScoreBand", "stageDeepMins", "stageLightMins", "stageRemMins",
    "stageAwakeMins", "sleepBed", "sleepWake", "sleepEfficiency", "sleepNeed", "sleepDebt",
    "sleepNeedSource", "circadianOnset", "circadianSpread", "circadianAlign", "circadianTarget",
    "loadScore", "loadBand", "loadText", "loadNote", "stepsBig", "stepsGoal", "stepsMean",
    "activeToday", "activeWeek", "activePct", "caloriesToday", "caloriesMean", "vo2max",
    "patternNote", "patternMethod", "footerMeta", "footerSync", "footerTz",
    "srcSleep", "srcHrv", "srcRhr", "srcSpo2", "srcSteps",
  ];

  function purgeRendered() {
    ["patternList", "coachGrid", "sources", "provenance", "heatmap"].forEach((id) => {
      const node = $(id);
      if (node) node.innerHTML = "";
    });
    RENDERED_IDS.forEach((id) => setText(id, DASH));
    ["rcRecArc", "rcStrArc", "rcSlpArc"].forEach((id) => setRing(id, 0, cssVar("--line-strong")));
    const strip = $("strip");
    if (strip) strip.innerHTML = "";
    const dial = $("loadDial");
    if (dial) dial.innerHTML = "";
    const bar = $("activeBar");
    if (bar) bar.style.width = "0%";
    ["stageDeep", "stageLight", "stageRem", "stageAwake"].forEach((id) => {
      const fill = $(id);
      if (fill) fill.style.width = "0%";
    });
  }

  function lock() {
    state.passphrase = null;
    state.payload = null;
    // A manual lock means locked: leaving the remembered record behind would
    // reopen the vault on the next reload and make the button a lie.
    forgetPassphrase();
    if (window.Viz) window.Viz.reset();
    purgeRendered();
    $("app").hidden = true;
    $("lock").hidden = false;
    $("lockInput").value = "";
    $("lockError").textContent = "";
    $("lockHint").textContent =
      "Data purged from this tab and this browser forgotten. Enter the passphrase to read it again.";
  }

  async function refresh() {
    if (!state.passphrase) return;
    const button = $("btnRefresh");
    const label = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Reading…";
    }
    try {
      const data = await decryptVault(state.passphrase);
      render(data);
      if (button) button.textContent = "Up to date";
      setTimeout(() => {
        if (button) button.textContent = label || "Refresh";
      }, 1800);
    } catch (error) {
      if (button) button.textContent = "Failed";
      setTimeout(() => {
        if (button) button.textContent = label || "Refresh";
      }, 1800);
    } finally {
      if (button) button.disabled = false;
    }
  }

  /* ----------------------------------------------------------------- init -- */
  function initControls() {
    $("btnTheme").addEventListener("click", () =>
      applyTheme(state.theme === "dark" ? "light" : "dark")
    );
    $("btnPrint").addEventListener("click", () => window.print());
    $("btnLock").addEventListener("click", lock);
    const refreshButton = $("btnRefresh");
    if (refreshButton) refreshButton.addEventListener("click", refresh);

    $("lockForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = $("lockInput").value;
      if (!value) return;
      $("lockError").textContent = "";
      try {
        const box = $("rememberDevice");
        const persist = box ? box.checked : false;
        if (!persist) await forgetPassphrase();
        await unlock(value, persist);
      } catch (error) {
        $("lockError").textContent =
          error.name === "OperationError"
            ? "That passphrase does not open this vault."
            : error.message || "Could not read the vault.";
      }
    });

    // Active section in the nav
    const links = Array.from(document.querySelectorAll(".nav a"));
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            links.forEach((link) =>
              link.setAttribute(
                "aria-current",
                link.getAttribute("href") === "#" + entry.target.id ? "true" : "false"
              )
            );
          });
        },
        { rootMargin: "-20% 0px -70% 0px" }
      );
      document.querySelectorAll("main section[id]").forEach((section) => observer.observe(section));
    }

    document.addEventListener("keydown", (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (event.key === "l") lock();
      if (event.key === "r") refresh();
    });

    window.addEventListener("themechange", () => window.Viz && window.Viz.redrawAll());
  }

  async function boot() {
    initTheme();
    initControls();
    $("lock").hidden = false;
    $("app").hidden = true;

    // A remembered browser opens straight to the data. If the record no longer
    // opens the vault it is dropped and the lock screen simply stays up, which
    // is the same thing the reader would do by hand.
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
