/* Home page carousel: the recommendation cards scroll continuously and loop without gaps.
   The track is cloned until it is wider than two screens, then translated; when a full set has scrolled past,
   the offset wraps by the width of one set, which is invisible because every set is identical. */
(function () {
  var root = document.querySelector('[data-ww-carousel]');
  if (!root) return;
  var track = root.querySelector('.ww-carousel-track');
  var mask = root.querySelector('.ww-carousel-mask');
  var originals = Array.prototype.slice.call(track.children);
  if (originals.length < 2) return;

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SPEED = reduceMotion ? 0 : 32; // px per second while idle
  var gap = 20;
  var setWidth = 0;
  var offset = 0;
  var paused = false;
  var hovering = false;
  var idleUntil = 0;
  var tween = null;

  function gapSize() {
    var g = parseFloat(getComputedStyle(track).columnGap || getComputedStyle(track).gap || '20');
    return isNaN(g) ? 20 : g;
  }

  function fillClones() {
    gap = gapSize();
    setWidth = 0;
    originals.forEach(function (card) { setWidth += card.getBoundingClientRect().width + gap; });
    if (!setWidth) return;
    var need = mask.getBoundingClientRect().width * 2 + setWidth;
    var sets = 1;
    while (track.scrollWidth < need && sets < 12) {
      originals.forEach(function (card) {
        var clone = card.cloneNode(true);
        clone.setAttribute('aria-hidden', 'true');
        clone.querySelectorAll('a').forEach(function (a) { a.setAttribute('tabindex', '-1'); });
        track.appendChild(clone);
      });
      sets++;
    }
  }

  function render() {
    track.style.transform = 'translate3d(' + (-offset) + 'px, 0, 0)';
  }

  function wrap() {
    if (!setWidth) return;
    while (offset >= setWidth) offset -= setWidth;
    while (offset < 0) offset += setWidth;
  }

  var last = performance.now();
  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (tween) {
      var t = Math.min(1, (now - tween.start) / tween.duration);
      var eased = 1 - Math.pow(1 - t, 3);
      offset = tween.from + (tween.to - tween.from) * eased;
      if (t >= 1) tween = null;
    } else if (!paused && !hovering && !document.hidden && now > idleUntil) {
      offset += SPEED * dt;
    }
    wrap();
    render();
    requestAnimationFrame(frame);
  }

  function cardStep(direction) {
    // Jump by one card width (the card nearest the left edge) so arrows feel like a classic slider.
    var pos = 0;
    var cards = track.children;
    var i = 0;
    while (i < cards.length && pos + cards[i].getBoundingClientRect().width + gap <= offset + 1) { pos += cards[i].getBoundingClientRect().width + gap; i++; }
    var target;
    if (direction > 0) target = pos + cards[i % cards.length].getBoundingClientRect().width + gap;
    else target = offset - pos > 2 ? pos : pos - (cards[(i - 1 + cards.length) % cards.length].getBoundingClientRect().width + gap);
    tween = { from: offset, to: target, start: performance.now(), duration: reduceMotion ? 0 : 450 };
    idleUntil = performance.now() + 4000;
  }

  function bindArrow(el, direction) {
    if (!el) return;
    el.addEventListener('click', function (e) { e.preventDefault(); cardStep(direction); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cardStep(direction); } });
  }
  bindArrow(root.querySelector('[data-ww-next]'), 1);
  bindArrow(root.querySelector('[data-ww-prev]'), -1);

  root.addEventListener('mouseenter', function () { hovering = true; });
  root.addEventListener('mouseleave', function () { hovering = false; });

  // Drag / swipe.
  var drag = null;
  mask.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, startOffset: offset, moved: false, id: e.pointerId };
    tween = null;
    paused = true;
  });
  window.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x;
    var dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) { drag.moved = true; root.classList.add('is-dragging'); }
    if (drag.moved) { offset = drag.startOffset - dx; wrap(); render(); }
  });
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    if (drag.moved) {
      // Swallow the click that follows a drag so the card link does not open.
      var swallow = function (ev) { ev.preventDefault(); ev.stopPropagation(); track.removeEventListener('click', swallow, true); };
      track.addEventListener('click', swallow, true);
      setTimeout(function () { track.removeEventListener('click', swallow, true); }, 300);
    }
    root.classList.remove('is-dragging');
    drag = null;
    paused = false;
    idleUntil = performance.now() + 3000;
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      // Rebuild clones for the new width.
      Array.prototype.slice.call(track.children).forEach(function (c) { if (originals.indexOf(c) < 0) track.removeChild(c); });
      fillClones();
      wrap();
      render();
    }, 150);
  });

  fillClones();
  render();
  requestAnimationFrame(frame);
})();
