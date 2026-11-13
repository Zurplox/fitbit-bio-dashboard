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
    const recovery = today.recovery || {};
    const band = recovery.band || {};
    const score = recovery.score;

    setText("athleteName", (data.athlete && data.athlete.name) || "Athlete");
    setText("heroHeadline", data.clinical ? data.clinical.headline : "");
    setText(
      "heroLede",
      (data.clinical && data.clinical.paragraphs && data.clinical.paragraphs[0] &&
        data.clinical.paragraphs[0].plain) ||
        "No narrative in this payload."
    );

    const ring = $("ringArc");
    if (ring) {
      const radius = 54;
      const circumference = 2 * Math.PI * radius;
      ring.setAttribute("stroke-dasharray", String(circumference));
      const ratio = Math.max(0, Math.min(1, (score || 0) / 100));
      ring.setAttribute("stroke-dashoffset", String(circumference * (1 - ratio)));
      ring.style.stroke = `var(--${bandTone(band) === "neutral" ? "accent" : bandTone(band)})`;
    }

    setText("ringScore", score === null || score === undefined ? DASH : Math.round(score));
    setHTML(
      "ringBand",
      `<span class="inline-band ${bandTone(band)}"><i></i>${escapeHTML(bandLabel(band))}</span>`
    );
    setText("ringSub", `Readiness ${num(today.readiness && today.readiness.score)} / 100`);
    setText("metaDevice", (data.device && data.device.name) || DASH);
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

    setText("kpiHrv", `${num(hrv.ms, 1)}`);
    setText("kpiHrvSub", `median ${num(hrv.baseline, 1)} ms · ${signed(hrv.delta_pct, 0, "%")}`);
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

    // 13 weeks ending today, Monday-first, from measured sessions only. An empty
    // cell means no session was logged, not that the day was bad for you.
    const byDate = {};
    ((data.history && data.history.exercise) || []).forEach((session) => {
      if (!session.date) return;
      byDate[session.date] = (byDate[session.date] || 0) + (session.minutes || 0);
    });

    const today = new Date((data.today && data.today.date) || Date.now());
    const weeks = 13;
    const days = weeks * 7;
    const start = new Date(today);
    start.setDate(start.getDate() - (days - 1));

    const cells = [];
    for (let index = 0; index < days; index += 1) {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      const iso = day.toISOString().slice(0, 10);
      cells.push({ date: iso, minutes: byDate[iso] || 0 });
    }

    container.innerHTML = "";
    cells.forEach((row) => {
      const cell = document.createElement("div");
      const minutes = row.minutes;
      const level = minutes === 0 ? 0 : minutes < 25 ? 1 : minutes < 45 ? 2 : minutes < 70 ? 3 : 4;
      cell.className = "heat-cell";
      cell.dataset.level = String(level);
      cell.title = `${row.date} — ${minutes ? minutes + " min trained" : "no session logged"}`;
      container.appendChild(cell);
    });
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
    const container = $("patterns");
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
    const container = $("coach");
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
    renderHero(data);
    renderVitals(data);
    renderLoad(data);
    renderPatterns(data);
    renderCoach(data);
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
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "-40px 0px -8% 0px", threshold: 0.02 }
    );
    document.querySelectorAll(".reveal:not(.in)").forEach((el) => observer.observe(el));
  }

  /* -------------------------------------------------------------- session -- */
  async function unlock(passphrase) {
    const data = await decryptVault(passphrase);
    // Held in memory for this page's lifetime only, so Refresh can re-read the
    // vault without re-prompting. It is never written to storage and never sent
    // anywhere: the only network request is the vault itself.
    state.passphrase = passphrase;
    $("lock").hidden = true;
    $("app").hidden = false;
    render(data);
    return data;
  }

  function lock() {
    state.passphrase = null;
    state.payload = null;
    if (window.Viz) window.Viz.reset();
    $("app").hidden = true;
    $("lock").hidden = false;
    $("lockInput").value = "";
    $("lockError").textContent = "";
    $("lockHint").textContent = "Data purged from this tab. Enter the passphrase to read it again.";
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
        await unlock(value);
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
    // The vault is the first paint's only source; there is no cached plaintext
    // anywhere in the page, so a reload always starts at the lock screen.
    $("lock").hidden = false;
    $("app").hidden = true;
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
