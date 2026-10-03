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
        say(res.body.message || 'Thank you, you are on the list.', 'is-success');
        if (input) input.value = '';
        window.wwTrack({ type: 'subscribe', slug: form.getAttribute('data-source') || 'newsletter', page: window.location.pathname });
      })
      .catch(function () { say('Something went wrong. Please try again.', 'is-error'); if (button) button.disabled = false; });
  }, true);

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
