/* ==========================================================================
   Meridian Air — canvas chart kit
   No dependencies. Every chart is one `paint(highlight)` function over a
   payload slice; the page owns the data, this file owns pixels.

   Two rules learned the hard way:
   * hover listeners are bound once per canvas, because `paint` runs on every
     resize and a listener per paint is a leak;
   * a hover repaints the whole chart, because drawing a marker over the
     previous marker leaves a picket fence behind the pointer.
   ========================================================================== */
(function () {
  "use strict";

  const Viz = {};
  const registry = [];
  const hoverBound = new WeakSet();
  // The canvas keeps one listener; the holder behind it is swapped on every
  // paint, so a re-render cannot leave hover reading the previous payload.
  const holders = new WeakMap();

  const css = (name, fallback) => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback || "#888";
  };

  function prep(canvas, height) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(120, canvas.parentElement.clientWidth || canvas.clientWidth || 320);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    canvas.style.width = "100%";
    canvas.style.height = height + "px";

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = "10px " + css("--mono", "monospace");
    ctx.textBaseline = "middle";
    return { ctx, w: width, h: height };
  }

  function niceTicks(min, max, count) {
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const raw = (max - min) / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    const low = Math.floor(min / step) * step;
    const high = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = low; v <= high + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
    return { ticks, low, high };
  }

  function grid(ctx, box, ticks, low, high, format) {
    ctx.save();
    ctx.strokeStyle = css("--line", "rgba(255,255,255,.08)");
    ctx.fillStyle = css("--faint", "#666");
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ticks.forEach((value) => {
      const y = box.bottom - ((value - low) / (high - low)) * box.height;
      ctx.beginPath();
      ctx.moveTo(box.left, Math.round(y) + 0.5);
      ctx.lineTo(box.right, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillText(format ? format(value) : String(value), box.left - 8, y);
    });
    ctx.restore();
  }

  function box(w, h, pad) {
    return {
      left: pad.left,
      right: w - pad.right,
      top: pad.top,
      bottom: h - pad.bottom,
      width: w - pad.left - pad.right,
      height: h - pad.top - pad.bottom,
    };
  }

  function showTip(element, canvas, html, x, y) {
    if (!element) return;
    element.innerHTML = html;
    element.style.left = Math.max(64, Math.min(canvas.clientWidth - 64, x)) + "px";
    element.style.top = Math.max(44, y) + "px";
    element.classList.add("on");
  }

  function hideTip(element) {
    if (element) element.classList.remove("on");
  }

  /**
   * Bind hover once per canvas. `holder.positions` and `holder.onIndex` are
   * replaced by each paint, so the listener always reads current geometry.
   */
  function bindHover(canvas, holder) {
    holders.set(canvas, holder);
    if (hoverBound.has(canvas)) return;
    hoverBound.add(canvas);

    const nearest = (clientX) => {
      const holder = holders.get(canvas);
      if (!holder) return -1;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      let best = -1;
      let distance = Infinity;
      (holder.positions || []).forEach((point, index) => {
        const d = Math.abs(point.x - x);
        if (d < distance) {
          distance = d;
          best = index;
        }
      });
      return best >= 0 && distance < 44 ? best : -1;
    };

    canvas.addEventListener("mousemove", (event) => {
      const holder = holders.get(canvas);
      if (holder && holder.onIndex) holder.onIndex(nearest(event.clientX));
    });
    canvas.addEventListener("mouseleave", () => {
      const holder = holders.get(canvas);
      if (holder && holder.onIndex) holder.onIndex(-1);
    });
    canvas.addEventListener(
      "touchmove",
      (event) => {
        const holder = holders.get(canvas);
        if (event.touches.length && holder && holder.onIndex) {
          holder.onIndex(nearest(event.touches[0].clientX));
        }
      },
      { passive: true }
    );
  }

  /* --------------------------------------------------------------- line ---- */
  Viz.line = function (canvas, options) {
    const {
      rows,
      key = "value",
      color = css("--hrv"),
      height = 180,
      pad = { left: 38, right: 12, top: 14, bottom: 24 },
      format = (v) => Math.round(v),
      tooltip: tipEl,
      tipHTML = () => "",
      band = null,
      goal = null,
    } = options;

    const points = (rows || []).filter((row) => row[key] !== null && row[key] !== undefined);
    if (!points.length) return;

    const values = points.map((row) => row[key]);
    const extra = [];
    if (band && band.value !== null && band.value !== undefined) extra.push(band.value);
    if (goal !== null && goal !== undefined) extra.push(goal);
    let min = Math.min(...values, ...extra);
    let max = Math.max(...values, ...extra);
    const padY = (max - min) * 0.18 || 2;
    min -= padY;
    max += padY;

    const holder = { positions: [], onIndex: null };

    const paint = (highlight = -1) => {
      const { ctx, w, h } = prep(canvas, height);
      const bx = box(w, h, pad);
      const { ticks, low, high } = niceTicks(min, max, 4);
      grid(ctx, bx, ticks, low, high, format);

      const xAt = (index) =>
        bx.left + (points.length === 1 ? bx.width / 2 : (index / (points.length - 1)) * bx.width);
      const yAt = (value) => bx.bottom - ((value - low) / (high - low)) * bx.height;

      if (band && band.value !== null && band.value !== undefined) {
        const y = yAt(band.value);
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = css("--line-strong", "rgba(255,255,255,.2)");
        ctx.beginPath();
        ctx.moveTo(bx.left, y);
        ctx.lineTo(bx.right, y);
        ctx.stroke();
        ctx.restore();
      }

      if (goal !== null && goal !== undefined) {
        const y = yAt(goal);
        ctx.save();
        ctx.setLineDash([2, 5]);
        ctx.strokeStyle = css("--faint", "#777");
        ctx.beginPath();
        ctx.moveTo(bx.left, y);
        ctx.lineTo(bx.right, y);
        ctx.stroke();
        ctx.restore();
      }

      const gradient = ctx.createLinearGradient(0, bx.top, 0, bx.bottom);
      gradient.addColorStop(0, color + "1a");
      gradient.addColorStop(1, color + "00");
      ctx.beginPath();
      points.forEach((row, index) => {
        const x = xAt(index);
        const y = yAt(row[key]);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.lineTo(xAt(points.length - 1), bx.bottom);
      ctx.lineTo(xAt(0), bx.bottom);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      ctx.beginPath();
      points.forEach((row, index) => {
        const x = xAt(index);
        const y = yAt(row[key]);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.75;
      ctx.lineJoin = "round";
      ctx.stroke();

      const last = points.length - 1;
      ctx.beginPath();
      ctx.arc(xAt(last), yAt(points[last][key]), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      ctx.fillStyle = css("--faint", "#666");
      ctx.textAlign = "left";
      ctx.fillText(points[0].date.slice(5), bx.left, h - 8);
      ctx.textAlign = "right";
      ctx.fillText(points[last].date.slice(5), bx.right, h - 8);

      if (highlight >= 0) {
        const x = xAt(highlight);
        ctx.save();
        ctx.strokeStyle = css("--line-strong", "rgba(255,255,255,.25)");
        ctx.beginPath();
        ctx.moveTo(x, bx.top);
        ctx.lineTo(x, bx.bottom);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, yAt(points[highlight][key]), 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();
      }

      holder.positions = points.map((_, index) => ({ x: xAt(index), y: bx.top }));
    };

    holder.onIndex = (index) => {
      paint(index);
      if (index < 0) return hideTip(tipEl);
      showTip(tipEl, canvas, tipHTML(index, points[index]), holder.positions[index].x, 18);
    };

    bindHover(canvas, holder);
    paint();
  };

  /* -------------------------------------------------------- stacked bars --- */
  Viz.stacked = function (canvas, options) {
    const {
      rows,
      keys,
      colors,
      height = 190,
      pad = { left: 34, right: 10, top: 12, bottom: 24 },
      format = (v) => Math.round(v),
      tooltip: tipEl,
      tipHTML = () => "",
    } = options;

    const data = (rows || []).filter((row) => row && row.minutes !== null && row.minutes !== undefined);
    if (!data.length) return;

    const totals = data.map((row) => keys.reduce((sum, key) => sum + (row[key] || 0), 0));
    const holder = { positions: [], onIndex: null };

    const paint = () => {
      const { ctx, w, h } = prep(canvas, height);
      const bx = box(w, h, pad);
      const { ticks, low, high } = niceTicks(0, Math.max(...totals), 3);
      grid(ctx, bx, ticks, low, high, format);

      const slot = bx.width / data.length;
      const barWidth = Math.max(2, Math.min(14, slot - 2));

      data.forEach((row, index) => {
        const x = bx.left + slot * index + (slot - barWidth) / 2;
        let cursor = bx.bottom;
        keys.forEach((key, keyIndex) => {
          const value = row[key] || 0;
          if (!value) return;
          const heightPx = (value / (high - low)) * bx.height;
          cursor -= heightPx;
          ctx.fillStyle = colors[keyIndex];
          ctx.beginPath();
          ctx.roundRect(x, cursor, barWidth, heightPx, [2, 2, 0, 0]);
          ctx.fill();
        });
      });

      ctx.fillStyle = css("--faint", "#666");
      ctx.textAlign = "left";
      ctx.fillText(data[0].date.slice(5), bx.left, h - 8);
      ctx.textAlign = "right";
      ctx.fillText(data[data.length - 1].date.slice(5), bx.right, h - 8);

      holder.positions = data.map((_, index) => ({
        x: bx.left + slot * index + slot / 2,
        y: bx.top,
      }));
    };

    holder.onIndex = (index) => {
      if (index < 0) return hideTip(tipEl);
      showTip(tipEl, canvas, tipHTML(index, data[index]), holder.positions[index].x, 18);
    };

    bindHover(canvas, holder);
    paint();
  };

  /* ---------------------------------------------------------------- bars --- */
  Viz.bars = function (canvas, options) {
    const {
      rows,
      key = "value",
      color = css("--steps"),
      height = 170,
      goal = null,
      format = (v) => Math.round(v),
      tooltip: tipEl,
      tipHTML = () => "",
    } = options;

    const data = (rows || []).filter((row) => row[key] !== null && row[key] !== undefined);
    if (!data.length) return;

    const maxValue = Math.max(...data.map((row) => row[key]), goal || 0) * 1.15;
    const holder = { positions: [], onIndex: null };

    const paint = () => {
      const { ctx, w, h } = prep(canvas, height);
      const bx = box(w, h, { left: 40, right: 10, top: 14, bottom: 24 });
      const { ticks, low, high } = niceTicks(0, maxValue, 3);
      grid(ctx, bx, ticks, low, high, format);

      const slot = bx.width / data.length;
      const barWidth = Math.max(2, Math.min(10, slot - 2));

      data.forEach((row, index) => {
        const value = row[key];
        const heightPx = (value / (high - low)) * bx.height;
        const x = bx.left + slot * index + (slot - barWidth) / 2;
        ctx.fillStyle = value >= (goal || Infinity) ? color : color + "99";
        ctx.beginPath();
        ctx.roundRect(x, bx.bottom - heightPx, barWidth, heightPx, [2, 2, 0, 0]);
        ctx.fill();
      });

      if (goal) {
        const y = bx.bottom - (goal / (high - low)) * bx.height;
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = css("--line-strong", "rgba(255,255,255,.25)");
        ctx.beginPath();
        ctx.moveTo(bx.left, y);
        ctx.lineTo(bx.right, y);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = css("--faint", "#777");
        ctx.textAlign = "right";
        ctx.fillText(format(goal), bx.right, y - 8);
      }

      holder.positions = data.map((_, index) => ({
        x: bx.left + slot * index + slot / 2,
        y: bx.top,
      }));
    };

    holder.onIndex = (index) => {
      if (index < 0) return hideTip(tipEl);
      showTip(tipEl, canvas, tipHTML(index, data[index]), holder.positions[index].x, 18);
    };

    bindHover(canvas, holder);
    paint();
  };

  /* ---------------------------------------------------------------- area --- */
  Viz.area = function (canvas, options) {
    const { rows, color = css("--rhr"), height = 150 } = options;
    const data = (rows || []).filter((row) => row.bpm);
    if (data.length < 2) return;

    const values = data.map((row) => row.bpm);
    const min = Math.min(...values) - 4;
    const max = Math.max(...values) + 4;
    const { ctx, w, h } = prep(canvas, height);
    const bx = box(w, h, { left: 34, right: 10, top: 12, bottom: 20 });
    const { ticks, low, high } = niceTicks(min, max, 3);
    grid(ctx, bx, ticks, low, high, (v) => Math.round(v));

    const xAt = (index) => bx.left + (index / (data.length - 1)) * bx.width;
    const yAt = (value) => bx.bottom - ((value - low) / (high - low)) * bx.height;

    const gradient = ctx.createLinearGradient(0, bx.top, 0, bx.bottom);
    gradient.addColorStop(0, color + "1f");
    gradient.addColorStop(1, color + "00");

    ctx.beginPath();
    data.forEach((row, index) => {
      const x = xAt(index);
      const y = yAt(row.bpm);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xAt(data.length - 1), bx.bottom);
    ctx.lineTo(xAt(0), bx.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    data.forEach((row, index) => {
      const x = xAt(index);
      const y = yAt(row.bpm);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.stroke();

    ctx.fillStyle = css("--faint", "#666");
    ctx.textAlign = "left";
    ctx.fillText(String(data[0].t).slice(11, 16), bx.left, h - 6);
    ctx.textAlign = "right";
    ctx.fillText(String(data[data.length - 1].t).slice(11, 16), bx.right, h - 6);
  };

  /* ---------------------------------------------------------------- dial --- */
  Viz.dial = function (svg, options) {
    const { value, max = 100, color = css("--accent"), trackColor = css("--line") } = options;
    const radius = 62;
    const circumference = Math.PI * radius;
    svg.setAttribute("viewBox", "0 0 150 88");
    svg.innerHTML = "";

    const ns = "http://www.w3.org/2000/svg";
    const arc = (stroke, dash, width) => {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", `M 13 76 A ${radius} ${radius} 0 0 1 137 76`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", stroke);
      path.setAttribute("stroke-width", width);
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-dasharray", dash);
      return path;
    };

    svg.appendChild(arc(trackColor, `${circumference}`, 9));
    const ratio = Math.max(0, Math.min(1, (value || 0) / max));
    const filled = arc(color, `${circumference * ratio} ${circumference}`, 9);
    svg.appendChild(filled);
  };

  /* ------------------------------------------------------------ registry --- */
  Viz.register = function (canvas, draw) {
    const entry = { canvas, draw, observer: null };
    registry.push(entry);
    if (typeof ResizeObserver === "undefined") return;
    let frame = null;
    let lastWidth = 0;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0].contentRect.width);
      // A redraw cannot change a chart's own width; bail if it did not move.
      if (width === lastWidth) return;
      lastWidth = width;
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          draw();
        } catch (error) {
          console.warn("chart redraw failed", error);
        }
      });
    });
    observer.observe(canvas.parentElement);
    entry.observer = observer;
  };

  Viz.redrawAll = function () {
    registry.forEach(({ draw }) => {
      try {
        draw();
      } catch (error) {
        console.warn("chart redraw failed", error);
      }
    });
  };

  Viz.reset = function () {
    // Disconnect, or every lock/re-render leaves a live observer behind that
    // redraws a canvas the page no longer shows.
    registry.forEach((entry) => {
      if (entry.observer) entry.observer.disconnect();
      entry.canvas.getContext("2d").clearRect(0, 0, entry.canvas.width, entry.canvas.height);
    });
    registry.length = 0;
  };

  window.Viz = Viz;
})();
