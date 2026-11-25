/* Supplement page, Health Insights.
   1. Stacking cards: each card sticks under the heading. A card taller than the screen sticks once its bottom is
      in view, so all of it can be read before the next card slides over it.
   2. The share row under "Why consider": copy the link, or the phone's own share sheet where there is one. */
(function () {
  var stack = document.querySelector('[data-ww-stack]');
  if (stack) {
    var head = stack.querySelector('.ww-stack-head');
    var items = [].slice.call(stack.querySelectorAll('.ww-stack-card')).map(function (card) {
      return { card: card, mark: card.previousElementSibling, space: card.nextElementSibling, scroll: card.querySelector('.ww-stack-scroll'), extra: 0, top: 0 };
    });
    var lastItem = items[items.length - 1];
    var measure = function () {
      var vh = window.innerHeight;
      var phone = window.innerWidth < 768;
      var base = phone ? 56 : 78;
      var bottomPad = phone ? 96 : 24; // room for the buy bar on phones
      var room = Math.max(260, vh - base - bottomPad);
      items.forEach(function (it, i) {
        var last = it === lastItem;
        it.top = base; // every frame locks at the same line, so no edge of an earlier one shows
        it.card.style.setProperty('--stack-top', it.top + 'px');
        it.card.style.zIndex = String(i + 1);
        it.card.classList.toggle('is-last', last);
        it.card.style.setProperty('--stack-h', 'auto');
        it.card.style.minHeight = '';
        if (last) {
          // the last frame is not locked: it covers the ones before it, then scrolls away with the page
          it.extra = 0;
          // a little taller than the locked frames (by their bottom margin), so none of them shows above or below it
          it.card.style.minHeight = (room + (phone ? 12 : 20)) + 'px';
        } else {
          var natural = it.card.getBoundingClientRect().height;
          it.extra = Math.max(0, Math.round(natural - room));
          it.card.style.setProperty('--stack-h', it.extra ? room + 'px' : 'auto');
        }
        if (it.space) it.space.style.setProperty('--stack-space', it.extra + 'px');
      });
      move();
    };
    var move = function () {
      items.forEach(function (it) {
        if (!it.scroll) return;
        var past = it.mark ? it.top - it.mark.getBoundingClientRect().top : 0;
        var y = it.extra ? Math.min(it.extra, Math.max(0, past)) : 0;
        it.scroll.style.transform = y ? 'translate3d(0,' + -y + 'px,0)' : '';
        var clip = it.scroll.parentElement;
        if (clip) {
          // fade grows with the distance scrolled, up to 40px, so text at rest is never dimmed
          clip.style.setProperty('--fade-t', Math.min(40, y) + 'px');
          clip.style.setProperty('--fade-b', Math.min(40, Math.max(0, it.extra - y)) + 'px');
        }
      });
      if (head) {
        head.classList.toggle('is-stuck', head.getBoundingClientRect().top <= 0.5);
        // once the last frame reaches the line, the heading steps aside so the frame never passes under it
        head.classList.toggle('is-gone', lastItem.card.getBoundingClientRect().top <= lastItem.top + 1);
      }
    };
    var tick = false;
    window.addEventListener('scroll', function () {
      if (tick) return; tick = true;
      requestAnimationFrame(function () { tick = false; move(); });
    }, { passive: true });
    window.addEventListener('resize', measure);
    if ('ResizeObserver' in window) {
      var ro = new ResizeObserver(measure);
      items.forEach(function (it) { if (it.scroll) ro.observe(it.scroll); });
    }
    // keep keyboard users in view: a focused link inside a clipped card scrolls the page to it
    stack.addEventListener('focusin', function (e) {
      var r = e.target.getBoundingClientRect();
      if (r.top < 120 || r.bottom > window.innerHeight - 110) window.scrollBy(0, r.top - window.innerHeight / 2);
    });
    measure();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    window.addEventListener('load', measure);
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
