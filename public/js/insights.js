/* Supplement page, Health Insights.
   1. Stacking cards: each card sticks under the heading. A card taller than the screen sticks once its bottom is
      in view, so all of it can be read before the next card slides over it.
   2. The share row under "Why consider": copy the link, or the phone's own share sheet where there is one. */
(function () {
  var stack = document.querySelector('[data-ww-stack]');
  if (stack) {
    var head = stack.querySelector('.ww-stack-head');
    var cards = [].slice.call(stack.querySelectorAll('.ww-stack-card'));
    var place = function () {
      var vh = window.innerHeight;
      var phone = window.innerWidth < 768;
      var headH = head ? head.getBoundingClientRect().height : 0;
      var bottomPad = phone ? 96 : 24; // room for the buy bar on phones
      cards.forEach(function (card, i) {
        var top = headH + 8 + i * (phone ? 8 : 12);
        var h = card.getBoundingClientRect().height;
        if (h > vh - top - bottomPad) top = vh - h - bottomPad;
        card.style.setProperty('--stack-top', Math.round(top) + 'px');
        card.style.zIndex = String(i + 1);
      });
    };
    var tick = false;
    var onScroll = function () {
      if (tick) return; tick = true;
      requestAnimationFrame(function () {
        tick = false;
        if (!head) return;
        var stuck = head.getBoundingClientRect().top <= 0.5 && stack.getBoundingClientRect().bottom > 80;
        if (stuck !== head.classList.contains('is-stuck')) { head.classList.toggle('is-stuck', stuck); place(); }
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, { passive: true });
    if ('ResizeObserver' in window) { var ro = new ResizeObserver(place); cards.forEach(function (c) { ro.observe(c); }); }
    if (head) head.addEventListener('transitionend', place);
  }

  var share = document.querySelector('[data-ishare]');
  if (share) {
    var url = share.getAttribute('data-url') || location.href;
    var title = share.getAttribute('data-title') || document.title;
    var copy = share.querySelector('[data-ishare-copy]');
    if (copy) {
      var label = copy.querySelector('b');
      var original = label.textContent;
      copy.addEventListener('click', function () {
        var done = function (text) {
          label.textContent = text; copy.classList.add('is-done');
          setTimeout(function () { label.textContent = original; copy.classList.remove('is-done'); }, 2000);
        };
        if (navigator.share && window.innerWidth < 768) {
          navigator.share({ title: title, url: url }).catch(function () {});
          return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () { done('Copied'); }, function () { done('Copy failed'); });
        } else { done('Copy failed'); }
      });
    }
  }
})();
