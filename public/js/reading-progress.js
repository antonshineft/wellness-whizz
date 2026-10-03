/* Thin green bar at the very top of article pages showing how far down the page the reader is. */
(function () {
  var bar = document.querySelector('.ww-progress');
  if (!bar) return;
  var ticking = false;
  function update() {
    ticking = false;
    var doc = document.documentElement;
    var max = (doc.scrollHeight || document.body.scrollHeight) - window.innerHeight;
    var pct = max > 0 ? Math.min(100, Math.max(0, (window.scrollY || doc.scrollTop) / max * 100)) : 0;
    bar.style.width = pct + '%';
  }
  function onScroll() { if (!ticking) { ticking = true; window.requestAnimationFrame(update); } }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  update();
})();
