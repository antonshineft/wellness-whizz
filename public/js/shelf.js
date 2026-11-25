/* Shelf scan: draw the looping picture behind the opening, take up to three photos (dropped or chosen), resize them
   in the browser, send them as JSON and open the result. */
(function () {
  var form = document.getElementById('ww-shelf');
  if (!form) return;
  var LANG = ((document.documentElement.getAttribute('lang') || 'en').slice(0, 2) === 'es') ? 'es' : 'en';
  var T = LANG === 'es'
    ? { pick: 'Elige entre 1 y 3 fotos.', tooMany: 'Máximo 3 fotos; se usan las tres primeras.', sending: 'Leyendo las etiquetas. Suele tardar menos de un minuto.', done: 'Listo, abriendo el resultado…', failed: 'Algo salió mal. Inténtalo de nuevo.', notImage: 'Ese archivo no es una imagen.', drop: 'Suelta una foto', tap: 'o toca para elegir', of: ' de 3', more: 'toca para añadir otra', ready: 'listo para revisar', reading: 'Leyendo', wait: 'menos de un minuto', remove: 'Quitar la foto' }
    : { pick: 'Choose 1 to 3 photos.', tooMany: 'At most 3 photos; the first three are used.', sending: 'Reading the labels. This usually takes under a minute.', done: 'All set, opening your result…', failed: 'Something went wrong. Please try again.', notImage: 'That file is not an image.', drop: 'Drop a photo', tap: 'or tap to choose', of: ' of 3', more: 'tap to add another', ready: 'ready to check', reading: 'Reading', wait: 'under a minute', remove: 'Remove photo' };
  var input = document.getElementById('ww-shelf-files');
  var previews = document.getElementById('ww-shelf-previews');
  var submit = document.getElementById('ww-shelf-submit');
  var status = document.getElementById('ww-shelf-status');
  var art = document.getElementById('ww-scan-art');
  var next = document.getElementById('ww-scan-next');
  var hint = document.getElementById('ww-scan-hint');
  var holeTitle = document.getElementById('ww-scan-hole-title');
  var holeSub = document.getElementById('ww-scan-hole-sub');
  var chips = document.getElementById('ww-scan-chips');
  var goalInput = form.querySelector('[name=goal]');
  var images = [];
  var busy = false;
  var MAX = 1400;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* The picture: in each quarter a nest of rounded triangles steps outward as white fades over green, and the nest
     flows into the centre, where the words sit. One step in is one loop. */
  var canvas = art.querySelector('canvas'), x = canvas.getContext('2d');
  var W = 0, H = 0, U = 0, phase = 0.35, speed = 1, target = 1, k = 1, kT = 1, last = 0, on = false;
  var G = 1.5, CY = 0.4;
  function roundPoly(pts, r) {
    var n = pts.length, s = [(pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2];
    x.moveTo(s[0], s[1]);
    for (var i = 0; i < n; i++) { var p = pts[i], q = pts[(i + 1) % n]; x.arcTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, r); }
    x.closePath();
  }
  function rr(X, Y, w, h, r) { x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath(); }
  function size() {
    var r = canvas.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height; canvas.width = Math.round(W * d); canvas.height = Math.round(H * d); x.setTransform(d, 0, 0, d, 0, 0);
    U = Math.min(W, H * 1.25);
    art.style.setProperty('--hole-w', Math.round(U * 0.5) + 'px'); art.style.setProperty('--hole-h', Math.round(U * 0.34) + 'px');
    draw();
  }
  function draw() {
    if (!W) return;
    var cx = W / 2, cy = H * CY, b = U * 0.04, R = Math.sqrt(W * W + H * H), g, i;
    g = x.createRadialGradient(cx, cy, 0, cx, cy, R * 0.62); g.addColorStop(0, '#bcffb7'); g.addColorStop(0.45, '#a3ea9d'); g.addColorStop(1, '#87d581'); x.fillStyle = g; x.fillRect(0, 0, W, H);
    g = x.createRadialGradient(cx, cy, U * 0.2, cx, cy, U * 0.7); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.42, 'rgba(255,255,255,.35)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, W, H);
    var D0 = U * 0.2, N = Math.ceil(Math.log(R * 1.5 / D0) / Math.log(G));
    [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(function (q) {
      x.save(); x.translate(cx, cy); x.scale(q[0], q[1]);
      for (i = N; i >= -3; i--) {
        var D = D0 * Math.pow(G, i + phase) * k, a = b + D / (2 * G) * 0.72, e = b + D / 2;
        /* The innermost steps fade out as they reach the centre, where the words sit. */
        x.globalAlpha = Math.max(0, Math.min(1, (D / U - 0.1) / 0.16));
        x.beginPath(); roundPoly([[b, b], [b + D, b], [b, b + D]], Math.min(U * 0.085, D * 0.2));
        var g2 = x.createLinearGradient(a, a, e, e); g2.addColorStop(0, 'rgba(255,255,255,0)'); g2.addColorStop(0.55, 'rgba(255,255,255,.3)'); g2.addColorStop(1, 'rgba(255,255,255,.96)');
        x.fillStyle = g2; x.fill();
      }
      x.restore();
    });
  }
  function tick(t) {
    if (!on) return;
    var dt = Math.min(0.05, (t - last) / 1000 || 0); last = t;
    speed += (target - speed) * Math.min(1, dt * 3); k += (kT - k) * Math.min(1, dt * 6);
    phase -= dt * speed * 0.16; while (phase < 0) phase += 1;
    draw(); requestAnimationFrame(tick);
  }
  function start() { if (on || reduce) return; on = true; last = performance.now(); requestAnimationFrame(tick); }
  if (window.ResizeObserver) new ResizeObserver(size).observe(canvas); else window.addEventListener('resize', size);
  size();
  if (window.IntersectionObserver) new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) start(); else on = false; }); }).observe(art); else start();
  /* Grain, made once. */
  (function () {
    var n = document.createElement('canvas'); n.width = n.height = 160;
    var c = n.getContext('2d'), im = c.createImageData(160, 160);
    for (var i = 0; i < im.data.length; i += 4) { var v = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 34; }
    c.putImageData(im, 0, 0);
    var grain = art.querySelector('.ww-scan-grain'); if (grain) grain.style.backgroundImage = 'url(' + n.toDataURL() + ')';
  })();

  function say(text) { if (status) status.textContent = text || ''; }

  function resize(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) return reject(new Error(T.notImage));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, MAX / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var dataUrl = c.toDataURL('image/jpeg', 0.85);
        resolve({ media_type: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error(T.notImage)); };
      img.src = url;
    });
  }

  function render() {
    var n = images.length;
    if (busy) { holeTitle.textContent = T.reading; holeSub.textContent = T.wait; }
    else if (n) { holeTitle.textContent = n + T.of; holeSub.textContent = n < 3 ? T.more : T.ready; }
    else { holeTitle.textContent = T.drop; holeSub.textContent = T.tap; }
    art.classList.toggle('has-photos', n > 0 || busy);
    next.hidden = !n; hint.hidden = !!n;
    previews.innerHTML = images.map(function (o, i) {
      return '<span class="ww-scan-thumb" style="background-image:url(' + o.preview + ')"><button type="button" data-i="' + i + '" aria-label="' + T.remove + '">×</button></span>';
    }).join('');
    submit.disabled = busy || !n;
    target = busy ? 6 : 1;
  }

  /* A photo flies into the opening before it joins the row. */
  function fly(src) {
    if (reduce) return;
    var f = document.createElement('span'); f.className = 'ww-scan-fly'; f.style.backgroundImage = 'url(' + src + ')';
    art.appendChild(f); f.addEventListener('animationend', function () { f.remove(); }); speed = 9;
  }

  function take(list) {
    if (busy) return;
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    var room = 3 - images.length;
    say(files.length > room ? T.tooMany : '');
    Promise.all(files.slice(0, room).map(resize)).then(function (out) {
      out.forEach(function (o) { fly(o.preview); });
      images = images.concat(out);
      setTimeout(function () { render(); if (next.scrollIntoView && next.getBoundingClientRect().bottom > window.innerHeight) submit.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' }); }, reduce ? 0 : 600);
    }).catch(function (err) { say(err && err.message ? err.message : T.failed); });
  }

  input.addEventListener('change', function () { take(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach(function (ev) { art.addEventListener(ev, function (e) { e.preventDefault(); if (!busy) { target = 5; kT = 1.06; } }); });
  art.addEventListener('dragleave', function () { if (!busy) target = 1; kT = 1; });
  art.addEventListener('drop', function (e) { e.preventDefault(); kT = 1; if (!busy) target = 1; take(e.dataTransfer && e.dataTransfer.files); });
  previews.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || busy) return;
    images.splice(Number(b.getAttribute('data-i')), 1); render();
  });
  chips.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    var was = b.getAttribute('aria-pressed') === 'true';
    Array.prototype.forEach.call(chips.querySelectorAll('button'), function (c) { c.setAttribute('aria-pressed', 'false'); });
    b.setAttribute('aria-pressed', was ? 'false' : 'true');
    goalInput.value = was ? '' : b.textContent;
  });
  goalInput.addEventListener('input', function () { Array.prototype.forEach.call(chips.querySelectorAll('button'), function (c) { c.setAttribute('aria-pressed', 'false'); }); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!images.length) { say(T.pick); return; }
    busy = true; render();
    say(T.sending);
    var goal = goalInput.value || '';
    fetch('/api/shelf', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ images: images.map(function (i) { return { media_type: i.media_type, data: i.data }; }), goal: goal, lang: LANG })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (res.ok && res.body && res.body.url) { say(T.done); window.location.href = res.body.url; }
        else { busy = false; render(); say((res.body && res.body.error) || T.failed); }
      })
      .catch(function () { busy = false; render(); say(T.failed); });
  });
  render();
})();
