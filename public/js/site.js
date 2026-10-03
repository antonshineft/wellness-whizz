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
