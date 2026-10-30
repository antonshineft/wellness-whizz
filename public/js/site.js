/* Shared behaviour for every page: funnel events and Google Ads conversion hooks.
   Set window.GTAG_CONVERSION_LABEL to your "AW-11471478571/XXXXXXXX" label to enable conversion events. */
(function () {
  window.GTAG_CONVERSION_LABEL = window.GTAG_CONVERSION_LABEL || '';
  window.gtag_report_conversion = function () {
    if (window.GTAG_CONVERSION_LABEL && typeof window.gtag === 'function') {
      window.gtag('event', 'conversion', { send_to: window.GTAG_CONVERSION_LABEL });
    }
    return true;
  };

  // Send a funnel event to the Worker without delaying navigation.
  window.wwTrack = function (payload) {
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/event', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true });
      }
    } catch (err) { /* measurement must never break the page */ }
  };

  // Email capture boxes (results page, blog): POST to /api/subscribe and show the outcome inline.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.hasAttribute || !form.hasAttribute('data-ww-subscribe')) return;
    event.preventDefault();
    var input = form.querySelector('input[type="email"]');
    var button = form.querySelector('button');
    var note = form.querySelector('.ww-capture-note');
    var email = (input && input.value || '').trim();
    var say = function (text, cls) { if (note) { note.textContent = text; note.className = 'ww-capture-note' + (cls ? ' ' + cls : ''); } };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { say('Please enter a valid email address.', 'is-error'); if (input) input.focus(); return; }
    if (button) button.disabled = true;
    fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email: email, source: form.getAttribute('data-source') || 'newsletter', session_id: form.getAttribute('data-session') || null, page: window.location.pathname })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok) { say((res.body && res.body.error) || 'Something went wrong. Please try again.', 'is-error'); if (button) button.disabled = false; return; }
        var thanks = form.getAttribute('data-source') === 'results' ? 'Thank you. Your results are on their way to your inbox.' : 'Thank you, you are on the list.';
        say(/already/i.test(res.body.message || '') ? res.body.message : thanks, 'is-success');
        form.classList.add('is-done');
        if (input) input.value = '';
      })
      .catch(function () { say('Something went wrong. Please try again.', 'is-error'); if (button) button.disabled = false; });
  }, true);

  // Blog index: "Show more" reveals the next batch of hidden cards and disappears when none are left.
  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('.ww-more') : null;
    if (!button) return;
    var grid = document.getElementById(button.getAttribute('data-target') || '');
    if (!grid) return;
    var step = parseInt(button.getAttribute('data-step') || '6', 10) || 6;
    var hidden = grid.querySelectorAll('.is-hidden');
    for (var i = 0; i < hidden.length && i < step; i++) hidden[i].classList.remove('is-hidden');
    if (grid.querySelectorAll('.is-hidden').length === 0) button.parentNode.removeChild(button);
  });

  // Every link marked data-track="outbound_click" (Buy on iHerb buttons, product photos) is an affiliate click.
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[data-track]') : null;
    if (!link) return;
    window.wwTrack({
      type: link.getAttribute('data-track'),
      slug: link.getAttribute('data-slug') || '',
      product: link.getAttribute('data-product') || '',
      page: window.location.pathname,
      href: link.href
    });
    if (link.getAttribute('data-track') === 'outbound_click') window.gtag_report_conversion();
  }, true);
})();

// ---------- "Explore manually": a square preview of the supplement's product on hover (desktop only) ----------
(function () {
  if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  var list = document.querySelector('.linksnav');
  if (!list) return;
  var peek = null, img = null, timer = null, current = null;
  function ensure() {
    if (peek) return;
    peek = document.createElement('div');
    peek.className = 'ww-peek';
    peek.setAttribute('aria-hidden', 'true');
    img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    peek.appendChild(img);
    document.body.appendChild(peek);
  }
  function place(link) {
    var r = link.getBoundingClientRect(), w = 170, h = 170, gap = 10;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    var top = r.top - gap - h >= 8 ? r.top - gap - h : r.bottom + gap;
    peek.style.left = Math.round(left + window.scrollX) + 'px';
    peek.style.top = Math.round(top + window.scrollY) + 'px';
  }
  function show(link) {
    var src = link.getAttribute('data-img');
    if (!src) return;
    ensure();
    current = link;
    img.style.mixBlendMode = link.getAttribute('data-blend') === '1' ? 'multiply' : '';
    place(link);
    var on = function () { if (current === link) peek.classList.add('is-on'); };
    if (img.getAttribute('src') !== src) {
      peek.classList.remove('is-on');
      img.onload = on;
      img.src = src;
    } else {
      on();
    }
  }
  function hide() {
    current = null;
    clearTimeout(timer);
    if (peek) peek.classList.remove('is-on');
  }
  list.addEventListener('mouseover', function (e) {
    var a = e.target.closest ? e.target.closest('a.link[data-img]') : null;
    if (!a || a === current) return;
    clearTimeout(timer);
    timer = setTimeout(function () { show(a); }, 60);
  });
  list.addEventListener('mouseout', function (e) {
    var a = e.target.closest ? e.target.closest('a.link[data-img]') : null;
    if (!a) return;
    if (e.relatedTarget && a.contains(e.relatedTarget)) return;
    hide();
  });
  window.addEventListener('scroll', hide, { passive: true });
})();
