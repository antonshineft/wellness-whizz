/* Shared behaviour for every page: Google Ads conversion reporting hooks.
   Set window.GTAG_CONVERSION_LABEL to your "AW-11471478571/XXXXXXXX" label to enable conversion events. */
(function () {
  window.GTAG_CONVERSION_LABEL = window.GTAG_CONVERSION_LABEL || '';
  window.gtag_report_conversion = function () {
    if (window.GTAG_CONVERSION_LABEL && typeof window.gtag === 'function') {
      window.gtag('event', 'conversion', { send_to: window.GTAG_CONVERSION_LABEL });
    }
    return true;
  };
  document.addEventListener('DOMContentLoaded', function () {
    var buttons = document.querySelectorAll('.link-block-2, .outbutton, .fakebutton');
    Array.prototype.forEach.call(buttons, function (el) {
      el.addEventListener('click', function () { window.gtag_report_conversion(); });
    });
  });
})();
