/* How it works: marks the section being read in the side menu, and keeps that item in view on phones. */
(function () {
  var rail = document.getElementById('ww-how-rail');
  if (!rail || !('IntersectionObserver' in window)) return;
  var strip = rail.querySelector('.ww-how-rail-in');
  var links = [].slice.call(rail.querySelectorAll('a'));
  var secs = links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); });
  var current = -1;
  function mark(i) {
    if (i === current || i < 0) return;
    current = i;
    links.forEach(function (a, k) { if (k === i) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
    if (strip.scrollWidth > strip.clientWidth) {
      var a = links[i];
      var to = a.offsetLeft - (strip.clientWidth - a.offsetWidth) / 2;
      var calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      strip.scrollTo({ left: Math.max(0, to), behavior: calm ? 'auto' : 'smooth' });
    }
  }
  function pick() {
    var line = window.innerHeight * 0.35, best = 0;
    secs.forEach(function (s, i) { if (s && s.getBoundingClientRect().top <= line) best = i; });
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
      for (var i = secs.length - 1; i >= 0; i--) { if (secs[i] && secs[i].getBoundingClientRect().top < window.innerHeight) { best = i; break; } }
    }
    mark(best);
  }
  var tick = false;
  window.addEventListener('scroll', function () {
    if (tick) return; tick = true;
    requestAnimationFrame(function () { tick = false; pick(); });
  }, { passive: true });
  window.addEventListener('resize', pick);
  pick();
})();
