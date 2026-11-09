/* Caffeine-through-the-day chart for the caffeine half-life guide (<ww-caffeine-chart>). Plain JS, no dependencies.
   Model: each drink is absorbed quickly (peak after about 45 minutes) and then cleared with the chosen half-life.
   Time runs from 06:00 to 06:00 the next morning, in minutes. */
(function () {
  var DRINKS = [
    ['Cup of coffee', 95], ['Espresso shot', 63], ['Large coffee', 190], ['Black tea', 47], ['Green tea', 28],
    ['Cola, one can', 34], ['Energy drink, 250 ml', 80], ['Pre-workout scoop', 200], ['Caffeine tablet', 200]
  ];
  var START = 360, DAY = 1440, KA = Math.LN2 / 0.15, TARGET = 50, NOTICE = 100;
  function clock(min) { var m = ((Math.round(min) + START) % DAY + DAY) % DAY; return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
  function fromClock(s) { var p = String(s).split(':'); var m = (+p[0]) * 60 + (+p[1] || 0); return isFinite(m) ? ((m - START) % DAY + DAY) % DAY : 0; }
  function el(name, attrs, parent) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function init(root) {
    var list = root.querySelector('[data-drinks]'), plot = root.querySelector('[data-plot]'), out = root.querySelector('[data-result]');
    var bedInput = root.querySelector('input[name="bed"]'), halfInput = root.querySelector('select[name="half"]'), addBtn = root.querySelector('[data-add]');
    if (!list || !plot || !out || !bedInput || !halfInput || !addBtn) return;
    var state = { drinks: [{ mg: 95, name: 'Cup of coffee', t: fromClock('08:00') }, { mg: 95, name: 'Cup of coffee', t: fromClock('11:00') }, { mg: 95, name: 'Cup of coffee', t: fromClock('15:30') }], bed: fromClock('23:00'), half: 5 };
    var tip = document.createElement('div'); tip.className = 'ww-caf-tip'; tip.hidden = true;
    var svg = el('svg', { role: 'img', 'aria-label': 'Caffeine in your body through the day. The same figures are in the text below the chart.' });
    plot.appendChild(svg); plot.appendChild(tip);
    var geo = null, ruler = null;

    function one(mg, dtMin, ke) { if (dtMin <= 0) return 0; var h = dtMin / 60; return mg * KA / (KA - ke) * (Math.exp(-ke * h) - Math.exp(-KA * h)); }
    function level(t, skip, extra) {
      var ke = Math.LN2 / state.half, sum = 0;
      for (var i = 0; i < state.drinks.length; i++) if (i !== skip) sum += one(state.drinks[i].mg, t - state.drinks[i].t, ke);
      if (extra) sum += one(extra.mg, t - extra.t, ke);
      return sum;
    }
    /* The highest level from bedtime through the next three hours: a drink taken just before bed has not been absorbed yet. */
    function nightLevel(skip, extra) { var m = 0; for (var t = state.bed; t <= state.bed + 180; t += 10) m = Math.max(m, level(t, skip, extra)); return m; }

    function drinkRows() {
      list.innerHTML = '';
      state.drinks.forEach(function (d, i) {
        var row = document.createElement('div'); row.className = 'ww-caf-drink';
        var sel = document.createElement('select'); sel.setAttribute('aria-label', 'Drink ' + (i + 1));
        var match = false;
        DRINKS.forEach(function (x) { var o = document.createElement('option'); o.value = x[1]; o.textContent = x[0] + ' (' + x[1] + ' mg)'; if (!match && x[1] === d.mg && d.name === x[0]) { o.selected = true; match = true; } sel.appendChild(o); });
        var custom = document.createElement('option'); custom.value = 'custom'; custom.textContent = 'Other amount'; if (!match) custom.selected = true; sel.appendChild(custom);
        var mg = document.createElement('input'); mg.type = 'number'; mg.min = 1; mg.max = 600; mg.step = 1; mg.value = d.mg; mg.setAttribute('aria-label', 'Caffeine in milligrams'); mg.inputMode = 'numeric';
        var unit = document.createElement('span'); unit.className = 'ww-caf-unit'; unit.textContent = 'mg at';
        var time = document.createElement('input'); time.type = 'time'; time.value = clock(d.t); time.setAttribute('aria-label', 'Time of drink ' + (i + 1));
        var del = document.createElement('button'); del.type = 'button'; del.className = 'ww-caf-del'; del.setAttribute('aria-label', 'Remove drink ' + (i + 1)); del.textContent = '×';
        sel.addEventListener('change', function () { if (sel.value !== 'custom') { d.mg = +sel.value; d.name = sel.options[sel.selectedIndex].textContent.replace(/ \(\d+ mg\)$/, ''); mg.value = d.mg; draw(); } });
        mg.addEventListener('input', function () { var v = Math.max(0, Math.min(600, +mg.value || 0)); d.mg = v; d.name = ''; sel.value = 'custom'; draw(); });
        time.addEventListener('change', function () { if (time.value) { d.t = fromClock(time.value); draw(); } });
        del.addEventListener('click', function () { state.drinks.splice(i, 1); drinkRows(); draw(); });
        d.timeInput = time;
        row.appendChild(sel); row.appendChild(mg); row.appendChild(unit); row.appendChild(time); row.appendChild(del);
        list.appendChild(row);
      });
      addBtn.disabled = state.drinks.length >= 8;
    }

    function draw() {
      var W = Math.max(280, plot.clientWidth), H = W < 480 ? 250 : 290, L = 38, R = 14, T = 44, B = 58;
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', W); svg.setAttribute('height', H);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      var pts = [], peak = { v: 0, t: 0 }, t;
      for (t = 0; t <= DAY; t += 5) { var v = level(t); pts.push([t, v]); if (v > peak.v) peak = { v: v, t: t }; }
      var top = Math.max(150, Math.ceil(Math.max(peak.v, NOTICE) * 1.15 / 50) * 50);
      var x = function (m) { return L + m / DAY * (W - L - R); }, y = function (v) { return T + (1 - v / top) * (H - T - B); };
      geo = { W: W, H: H, L: L, R: R, T: T, B: B, x: x, y: y, inv: function (px) { return Math.max(0, Math.min(DAY, (px - L) / (W - L - R) * DAY)); } };
      var step = top > 400 ? 100 : 50, g;
      for (g = 0; g <= top; g += step) {
        el('line', { x1: L, x2: W - R, y1: y(g), y2: y(g), 'class': g === 0 ? 'ww-caf-axis' : 'ww-caf-grid' }, svg);
        el('text', { x: L - 6, y: y(g) + 4, 'text-anchor': 'end', 'class': 'ww-caf-tick' }, svg).textContent = g;
      }
      for (g = 0; g <= DAY; g += 180) { if (W < 420 && g % 360) continue; el('text', { x: x(g), y: H - B + 16, 'text-anchor': 'middle', 'class': 'ww-caf-tick' }, svg).textContent = clock(g).slice(0, 2); }
      el('rect', { x: x(state.bed), y: T, width: Math.max(0, W - R - x(state.bed)), height: H - T - B, 'class': 'ww-caf-sleep' }, svg);
      el('line', { x1: L, x2: W - R, y1: y(NOTICE), y2: y(NOTICE), 'class': 'ww-caf-ref' }, svg);
      el('text', { x: W - R - 4, y: y(NOTICE) - 5, 'text-anchor': 'end', 'class': 'ww-caf-tick' }, svg).textContent = '100 mg';
      var path = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); }).join(' ');
      el('path', { d: path + ' L' + x(DAY) + ' ' + y(0) + ' L' + x(0) + ' ' + y(0) + ' Z', 'class': 'ww-caf-area' }, svg);
      el('path', { d: path, 'class': 'ww-caf-line' }, svg);
      var bedV = level(state.bed), bx = x(state.bed), right = bx > W * 0.62;
      el('line', { x1: bx, x2: bx, y1: T - 30, y2: H - B, 'class': 'ww-caf-bed' }, svg);
      el('circle', { cx: bx, cy: y(bedV), r: 4.5, 'class': 'ww-caf-dot' }, svg);
      var bl = el('text', { x: bx + (right ? -7 : 7), y: T - 20, 'text-anchor': right ? 'end' : 'start', 'class': 'ww-caf-label' }, svg); bl.textContent = 'Bed ' + clock(state.bed);
      var bl2 = el('text', { x: bx + (right ? -7 : 7), y: T - 6, 'text-anchor': right ? 'end' : 'start', 'class': 'ww-caf-sub' }, svg); bl2.textContent = Math.round(bedV) + ' mg still in you';
      if (peak.v > 1 && Math.abs(x(peak.t) - bx) > (W < 480 ? 56 : 96)) {
        var px = x(peak.t), pr = px > W * 0.7;
        el('circle', { cx: px, cy: y(peak.v), r: 4.5, 'class': 'ww-caf-dot' }, svg);
        el('text', { x: px + (pr ? -8 : 8), y: Math.max(T - 6, y(peak.v) - 8), 'text-anchor': pr ? 'end' : 'start', 'class': 'ww-caf-sub' }, svg).textContent = 'Peak ' + Math.round(peak.v) + ' mg, ' + clock(peak.t);
      }
      ruler = el('g', { visibility: 'hidden' }, svg);
      el('line', { x1: 0, x2: 0, y1: T, y2: H - B, 'class': 'ww-caf-ruler' }, ruler);
      el('circle', { cx: 0, cy: 0, r: 5, 'class': 'ww-caf-rdot' }, ruler);
      /* Handles: one per drink under the axis, and the bedtime handle. Hit areas are larger than the marks. */
      state.drinks.forEach(function (d, i) {
        var h = el('g', { 'class': 'ww-caf-handle', tabindex: 0, role: 'slider', 'aria-label': 'Drink ' + (i + 1) + ' at ' + clock(d.t) + '. Drag to move it.', 'aria-valuetext': clock(d.t) }, svg);
        el('line', { x1: x(d.t), x2: x(d.t), y1: H - B, y2: H - B + 30, 'class': 'ww-caf-stem' }, h);
        el('circle', { cx: x(d.t), cy: H - B + 38, r: 9, 'class': 'ww-caf-cup' }, h);
        el('circle', { cx: x(d.t), cy: H - B + 38, r: 22, fill: 'transparent' }, h);
        drag(h, function (m) { d.t = m; if (d.timeInput) d.timeInput.value = clock(m); });
      });
      var bh = el('g', { 'class': 'ww-caf-handle', tabindex: 0, role: 'slider', 'aria-label': 'Bedtime ' + clock(state.bed) + '. Drag to move it.', 'aria-valuetext': clock(state.bed) }, svg);
      el('rect', { x: bx - 22, y: T - 34, width: 44, height: H - B - T + 34, fill: 'transparent' }, bh);
      el('rect', { x: bx - 4, y: T - 34, width: 8, height: 14, rx: 3, 'class': 'ww-caf-grip' }, bh);
      drag(bh, function (m) { state.bed = m; bedInput.value = clock(m); });
      summary(bedV, peak);
    }

    function drag(handle, set) {
      function at(e) { var r = svg.getBoundingClientRect(); return Math.round(geo.inv((e.clientX - r.left) * geo.W / r.width) / 5) * 5 % DAY; }
      handle.addEventListener('pointerdown', function (e) {
        e.preventDefault(); hideRuler();
        var move = function (ev) { set(at(ev)); draw(); };
        var up = function () { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      });
      handle.addEventListener('keydown', function (e) {
        var stepKey = e.key === 'ArrowLeft' ? -15 : e.key === 'ArrowRight' ? 15 : 0;
        if (!stepKey) return;
        e.preventDefault();
        var r = handle.querySelector('circle, rect'), cur = geo.inv(+(r.getAttribute('cx') || (+r.getAttribute('x') + 22)));
        set(Math.max(0, Math.min(DAY - 5, Math.round((cur + stepKey) / 5) * 5))); draw();
      });
    }

    function hideRuler() { tip.hidden = true; if (ruler) ruler.setAttribute('visibility', 'hidden'); }
    function showRuler(e) {
      if (!geo || (e.target.closest && e.target.closest('.ww-caf-handle'))) return hideRuler();
      var r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * geo.W / r.width;
      if (px < geo.L || px > geo.W - geo.R) return hideRuler();
      var m = Math.round(geo.inv(px) / 5) * 5, v = level(m), cx = geo.x(m);
      ruler.setAttribute('visibility', 'visible');
      ruler.firstChild.setAttribute('x1', cx); ruler.firstChild.setAttribute('x2', cx);
      ruler.lastChild.setAttribute('cx', cx); ruler.lastChild.setAttribute('cy', geo.y(v));
      tip.innerHTML = '<b>' + clock(m) + '</b>' + Math.round(v) + ' mg in you';
      tip.hidden = false;
      var left = cx * r.width / geo.W + 10; if (left + tip.offsetWidth > r.width) left = cx * r.width / geo.W - tip.offsetWidth - 10;
      tip.style.left = Math.max(0, left) + 'px'; tip.style.top = Math.max(0, geo.y(v) * r.height / geo.H - 44) + 'px';
    }
    svg.addEventListener('pointermove', showRuler); svg.addEventListener('pointerdown', showRuler); svg.addEventListener('pointerleave', hideRuler);

    function summary(bedV, peak) {
      if (!state.drinks.length) { out.innerHTML = '<p>Add a drink to see the curve.</p>'; return; }
      var total = state.drinks.reduce(function (s, d) { return s + d.mg; }, 0), cups = bedV / 95;
      var verdict = bedV >= NOTICE ? 'That is at or above 100 mg, the amount the European Food Safety Authority says can lengthen the time it takes to fall asleep and shorten sleep in some adults.'
        : bedV >= TARGET ? 'That is under 100 mg, but people who are sensitive to caffeine can still feel this much.'
          : 'That is low enough that most people will not notice it.';
      var html = '<p class="ww-calc-headline">At ' + clock(state.bed) + ' you still have about <strong>' + Math.round(bedV) + ' mg of caffeine</strong> in you' + (cups >= 0.25 ? ', roughly ' + (cups < 0.75 ? 'half a cup' : cups < 1.25 ? 'one cup' : (Math.round(cups * 2) / 2) + ' cups') + ' of coffee' : '') + '.</p><p>' + verdict + '</p>';
      /* The last drink before bed: how late could it be while the night stays under the target? */
      var last = -1; state.drinks.forEach(function (d, i) { if (d.t <= state.bed && (last < 0 || d.t > state.drinks[last].t)) last = i; });
      if (last >= 0 && state.drinks[last].mg > 0) {
        var d = state.drinks[last], rest = nightLevel(last), name = (d.name || (d.mg + ' mg drink')).toLowerCase();
        if (rest > TARGET) html += '<p>Even without your last drink you would be above ' + TARGET + ' mg at bedtime, so the earlier drinks need to move or shrink too.</p>';
        else {
          var best = -1; for (var t = state.bed; t >= 0; t -= 5) if (nightLevel(last, { mg: d.mg, t: t }) <= TARGET) { best = t; break; }
          if (best < 0) html += '<p>With this half-life a ' + name + ' today keeps you above ' + TARGET + ' mg at bedtime whenever you take it.</p>';
          else if (nightLevel() <= TARGET) html += '<p>You stay under ' + TARGET + ' mg through the night. Your last ' + name + ' could be as late as <strong>' + clock(best) + '</strong>.</p>';
          else html += '<p>To be under ' + TARGET + ' mg at bedtime, have your last ' + name + ' by <strong>' + clock(best) + '</strong>.</p>';
        }
      }
      html += '<p class="ww-calc-note">Today: ' + Math.round(total) + ' mg in ' + state.drinks.length + (state.drinks.length === 1 ? ' drink' : ' drinks') + ', peaking at ' + Math.round(peak.v) + ' mg around ' + clock(peak.t) + '. ' + (total > 400 ? 'That is over the 400 mg a day that regulators consider safe for most healthy adults.' : 'Regulators put the safe daily amount for most healthy adults at 400 mg.') + '</p>';
      out.innerHTML = html;
    }

    addBtn.addEventListener('click', function () { if (state.drinks.length < 8) { var lastT = state.drinks.length ? Math.max.apply(null, state.drinks.map(function (d) { return d.t; })) : 0; state.drinks.push({ mg: 95, name: 'Cup of coffee', t: Math.min(DAY - 60, lastT + 120) }); drinkRows(); draw(); } });
    bedInput.addEventListener('change', function () { if (bedInput.value) { state.bed = fromClock(bedInput.value); draw(); } });
    halfInput.addEventListener('change', function () { state.half = +halfInput.value || 5; draw(); });
    if (window.ResizeObserver) new ResizeObserver(function () { if (!geo || Math.abs(geo.W - plot.clientWidth) > 2) draw(); }).observe(plot);
    else window.addEventListener('resize', draw);
    drinkRows(); draw();
  }
  function start() { Array.prototype.forEach.call(document.querySelectorAll('[data-caffeine-chart]'), init); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
