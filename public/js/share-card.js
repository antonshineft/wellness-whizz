/* Shareable result card.
 * The browser draws two images from the result data (a 1200x630 link preview and a 1080x1920 story), shows the
 * preview in the "Share your plan" block, and uploads both to the Worker so the page's og:image serves the real card
 * to X, WhatsApp, iMessage and the rest. Nothing personal goes on the card beyond the one-line profile. */
(function () {
  var dataEl = document.getElementById('ww-share-data');
  var root = document.getElementById('ww-share');
  if (!dataEl || !root) return;
  var data;
  try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }

  var DARK = '#1d272d', GREEN = '#87d581', YELLOW = '#fdf1cf';
  var FONT = 'Aeonik, "Helvetica Neue", Arial, sans-serif';
  var cardUrl = '/result/' + data.id + '/card.jpg';
  var preview = document.getElementById('ww-share-img');
  var rendered = { card: null, story: null };

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function loadImg(src) {
    return new Promise(function (resolve) {
      if (!src) return resolve(null);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }
  function ellipsis(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    var t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t.replace(/\s+$/, '') + '…';
  }
  function wrapLines(ctx, text, maxW, maxLines) {
    var words = String(text).split(/\s+/), lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width <= maxW || !line) line = test; else { lines.push(line); line = words[i]; }
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = ellipsis(ctx, lines[maxLines - 1] + ' ' + words.slice(-1), maxW); }
    return lines.map(function (l) { return ellipsis(ctx, l, maxW); });
  }
  function drawContain(ctx, img, x, y, w, h, pad) {
    if (!img) return;
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    var s = Math.min((w - pad * 2) / iw, (h - pad * 2) / ih);
    var dw = iw * s, dh = ih * s;
    ctx.save(); ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
  }
  function base(ctx, W, H, radius, inset, frameRadius) {
    var g = ctx.createLinearGradient(0, 0, W * 0.35, H);
    g.addColorStop(0, '#bcffb7'); g.addColorStop(0.55, '#dcffd8'); g.addColorStop(1, '#f3fff1');
    ctx.fillStyle = g; rr(ctx, 0, 0, W, H, radius); ctx.fill();
    ctx.strokeStyle = 'rgba(29,39,45,.16)'; ctx.lineWidth = 1.5;
    rr(ctx, inset, inset, W - inset * 2, H - inset * 2, frameRadius); ctx.stroke();
  }
  function brand(ctx, logo, x, y, size, fontPx) {
    if (logo) { ctx.save(); rr(ctx, x, y, size, size, size * 0.28); ctx.clip(); ctx.drawImage(logo, x, y, size, size); ctx.restore(); }
    ctx.fillStyle = DARK; ctx.font = '700 ' + fontPx + 'px ' + FONT; ctx.textBaseline = 'middle';
    ctx.fillText('Wellness Whizz', x + size + size * 0.3, y + size / 2);
  }
  function pill(ctx, text, rightX, y, h, fontPx, bg, color) {
    ctx.font = '700 ' + fontPx + 'px ' + FONT; ctx.textBaseline = 'middle';
    var w = ctx.measureText(text).width + h * 1.1;
    ctx.fillStyle = bg; rr(ctx, rightX - w, y, w, h, h / 2); ctx.fill();
    ctx.fillStyle = color; ctx.fillText(text, rightX - w + h * 0.55, y + h / 2 + 1);
    return w;
  }
  function bars(ctx, x, baseline, n, s) {
    for (var i = 0; i < 5; i++) {
      var h = (6 + i * 2) * s, w = 4 * s;
      ctx.fillStyle = i < n ? DARK : 'rgba(29,39,45,.2)';
      ctx.fillRect(x + i * 6 * s, baseline - h, w, h);
    }
    return 30 * s;
  }
  function tile(ctx, item, img, x, y, w, h, s) {
    ctx.fillStyle = 'rgba(255,255,255,.72)'; rr(ctx, x, y, w, h, 24 * s); ctx.fill();
    var pad = 12 * s, photoH = h * 0.56;
    ctx.fillStyle = YELLOW; rr(ctx, x + pad, y + pad, w - pad * 2, photoH, 18 * s); ctx.fill();
    drawContain(ctx, img, x + pad, y + pad, w - pad * 2, photoH, 10 * s);
    ctx.fillStyle = DARK; ctx.font = '700 ' + Math.round(17 * s) + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    var lines = wrapLines(ctx, item.name, w - pad * 2, 2), ty = y + pad + photoH + 12 * s;
    for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], x + w / 2, ty + i * 21 * s);
    var metaY = y + h - 26 * s;
    ctx.font = '700 ' + Math.round(12 * s) + 'px ' + FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    var score = item.score + '/5', tag = (item.safety || '').toUpperCase();
    var scoreW = ctx.measureText(score).width, tagW = tag ? ctx.measureText(tag).width + 16 * s : 0;
    var total = 30 * s + 6 * s + scoreW + (tag ? 8 * s + tagW : 0), bx = x + (w - total) / 2;
    bars(ctx, bx, metaY + 7 * s, item.score, s);
    ctx.fillStyle = DARK; ctx.fillText(score, bx + 36 * s, metaY);
    if (tag) {
      var tx = bx + 36 * s + scoreW + 8 * s;
      ctx.fillStyle = item.safe ? GREEN : 'rgba(29,39,45,.12)'; rr(ctx, tx, metaY - 9 * s, tagW, 18 * s, 9 * s); ctx.fill();
      ctx.fillStyle = DARK; ctx.fillText(tag, tx + 8 * s, metaY);
    }
    ctx.textAlign = 'left';
  }
  function qr(ctx, text, x, y, size) {
    if (typeof qrcode !== 'function') return;
    try {
      var q = qrcode(0, 'M'); q.addData(text); q.make();
      var n = q.getModuleCount(), pad = size * 0.09, cell = (size - pad * 2) / n;
      ctx.fillStyle = '#fff'; rr(ctx, x, y, size, size, size * 0.12); ctx.fill();
      ctx.fillStyle = DARK;
      for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect(x + pad + c * cell, y + pad + r * cell, cell + 0.4, cell + 0.4);
    } catch (e) { /* QR is decoration; the link is in the text */ }
  }
  function canvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  function renderCard(logo, images) {
    var W = 1200, H = 630, c = canvas(W, H), ctx = c.getContext('2d');
    base(ctx, W, H, 40, 26, 28);
    brand(ctx, logo, 66, 60, 44, 26);
    pill(ctx, 'Free 2-minute AI quiz', W - 66, 62, 42, 16, DARK, '#fff');
    ctx.fillStyle = DARK; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.font = '500 56px ' + FONT; ctx.fillText(data.title, 66, 190);
    ctx.font = '400 22px ' + FONT; ctx.fillStyle = 'rgba(29,39,45,.78)';
    ctx.fillText(ellipsis(ctx, data.line, W - 132), 66, 228);
    var n = data.items.length, gap = 18, areaW = W - 132, tw = (areaW - gap * (n - 1)) / n;
    for (var i = 0; i < n; i++) tile(ctx, data.items[i], images[i], 66 + i * (tw + gap), 254, tw, 236, 1);
    ctx.fillStyle = DARK; ctx.font = '700 22px ' + FONT; ctx.textBaseline = 'alphabetic';
    ctx.fillText(data.site, 66, 544);
    ctx.font = '400 18px ' + FONT; ctx.fillStyle = 'rgba(29,39,45,.7)';
    ctx.fillText('Scan to open this plan, or build your own in two minutes.', 66, 572);
    qr(ctx, data.url, W - 66 - 78, 500, 78);
    return c;
  }
  function renderStory(logo, images) {
    var W = 1080, H = 1920, c = canvas(W, H), ctx = c.getContext('2d');
    base(ctx, W, H, 40, 26, 28);
    brand(ctx, logo, 80, 86, 70, 40);
    pill(ctx, 'Free AI quiz', W - 80, 90, 64, 24, DARK, '#fff');
    ctx.fillStyle = DARK; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.font = '500 96px ' + FONT; ctx.fillText(ellipsis(ctx, data.title, W - 160), 80, 330);
    ctx.font = '400 36px ' + FONT; ctx.fillStyle = 'rgba(29,39,45,.78)';
    ctx.fillText(ellipsis(ctx, data.line, W - 160), 80, 392);
    var gap = 26, tw = (W - 160 - gap) / 2, th = 400, top = 440;
    for (var i = 0; i < data.items.length && i < 5; i++) {
      var col = i % 2, row = Math.floor(i / 2);
      tile(ctx, data.items[i], images[i], 80 + col * (tw + gap), top + row * (th + gap), tw, th, 1.75);
    }
    var slots = Math.ceil(data.items.length / 2) * 2;
    if (data.items.length < slots || data.items.length === 0) {
      var i2 = data.items.length, col2 = i2 % 2, row2 = Math.floor(i2 / 2);
      var cx = 80 + col2 * (tw + gap), cy = top + row2 * (th + gap);
      ctx.fillStyle = DARK; rr(ctx, cx, cy, tw, th, 34); ctx.fill();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = GREEN; ctx.font = '700 36px ' + FONT; ctx.fillText('Your turn', cx + tw / 2, cy + th / 2 - 44);
      ctx.fillStyle = '#fff'; ctx.font = '500 30px ' + FONT;
      ctx.fillText('Two minutes, no account.', cx + tw / 2, cy + th / 2 + 8); ctx.fillText('Link in bio or scan.', cx + tw / 2, cy + th / 2 + 48);
      ctx.textAlign = 'left';
    }
    ctx.fillStyle = DARK; ctx.font = '700 36px ' + FONT; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.fillText(data.site, 80, 1790);
    ctx.font = '400 30px ' + FONT; ctx.fillStyle = 'rgba(29,39,45,.7)'; ctx.fillText('Personal AI supplement quiz', 80, 1836);
    qr(ctx, data.url, W - 80 - 150, 1700, 150);
    return c;
  }
  function toBlob(c, quality) {
    return new Promise(function (resolve) {
      try { c.toBlob(function (b) { resolve(b); }, 'image/jpeg', quality); } catch (e) { resolve(null); } // a tainted canvas throws
    });
  }
  function upload(kind, blob) {
    return fetch('/api/result/' + encodeURIComponent(data.id) + '/card?kind=' + kind, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob })
      .then(function (r) { return r.ok; }).catch(function () { return false; });
  }
  function track(channel) {
    if (window.wwTrack) window.wwTrack({ type: 'share', slug: channel, page: window.location.pathname, session: data.id });
  }

  var assets = null;
  function loadAssets() {
    if (assets) return assets;
    var fonts = document.fonts && document.fonts.load
      ? Promise.all([document.fonts.load('500 56px Aeonik'), document.fonts.load('700 26px Aeonik'), document.fonts.load('400 22px Aeonik')]).catch(function () {})
      : Promise.resolve();
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 2500); });
    assets = Promise.race([fonts, timeout]).then(function () {
      return Promise.all([loadImg(data.logo)].concat(data.items.map(function (it) { return loadImg(it.image); })));
    }).then(function (imgs) { return { logo: imgs[0], images: imgs.slice(1) }; });
    return assets;
  }
  function getCard() {
    if (rendered.card) return Promise.resolve(rendered.card);
    return loadAssets().then(function (a) { rendered.card = renderCard(a.logo, a.images); return rendered.card; });
  }
  function getStory() {
    if (rendered.story) return Promise.resolve(rendered.story);
    return loadAssets().then(function (a) { rendered.story = renderStory(a.logo, a.images); return rendered.story; });
  }

  // 1. Make sure the server holds a real card for this result (crawlers read og:image from there).
  fetch(cardUrl, { method: 'HEAD' }).then(function (r) { return r.headers.get('x-ww-card'); }).catch(function () { return 'default'; })
    .then(function (state) {
      if (state === 'generated') return;
      return getCard().then(function (c) {
        try { if (preview) preview.src = c.toDataURL('image/jpeg', 0.9); } catch (e) { /* tainted canvas: keep the server image */ }
        return toBlob(c, 0.86).then(function (b) { return b && upload('card', b); })
          .then(function () { return getStory(); })
          .then(function (s) { return toBlob(s, 0.84).then(function (b) { return b && upload('story', b); }); });
      });
    });

  // 2. Buttons.
  var shareText = data.text, shareUrl = data.url;
  root.addEventListener('click', function (event) {
    var btn = event.target && event.target.closest ? event.target.closest('[data-share]') : null;
    if (!btn) return;
    var channel = btn.getAttribute('data-share');
    if (channel === 'x' || channel === 'whatsapp') { track(channel); return; } // plain links
    event.preventDefault();
    if (channel === 'copy') {
      var done = function () { btn.classList.add('is-done'); var label = btn.querySelector('b'); if (label) label.textContent = 'Copied'; track('copy'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(shareUrl).then(done, done); else done();
      return;
    }
    if (channel === 'native' && navigator.share) {
      navigator.share({ title: data.title, text: shareText, url: shareUrl }).then(function () { track('native'); }).catch(function () {});
      return;
    }
    if (channel === 'story') {
      btn.classList.add('is-busy');
      getStory().then(function (c) { return toBlob(c, 0.9); }).then(function (blob) {
        btn.classList.remove('is-busy');
        if (!blob) return;
        var file = new File([blob], 'wellness-whizz-plan.jpg', { type: 'image/jpeg' });
        if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
          navigator.share({ files: [file], title: data.title, text: shareText + ' ' + shareUrl }).then(function () { track('story'); }).catch(function () {});
          return;
        }
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'wellness-whizz-plan.jpg';
        document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
        track('story');
      });
    }
  });
  var nativeBtn = root.querySelector('[data-share="native"]');
  if (nativeBtn && navigator.share) nativeBtn.hidden = false;
})();
