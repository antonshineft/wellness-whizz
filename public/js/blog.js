/* Blog index: quick search and category chips over the article cards, six cards at a time.
   Every card is already in the HTML; this only hides and shows. The chosen category and search live in the URL
   (?category=&q=) so a filtered view can be shared. Without JavaScript the first cards simply show. */
(function () {
  var root = document.querySelector('[data-blog-filter]');
  var list = document.querySelector('[data-blog-list]');
  if (!root || !list) return;
  var cards = Array.prototype.slice.call(list.querySelectorAll('.ww-post-card'));
  var search = root.querySelector('[data-blog-search]');
  var count = root.querySelector('[data-blog-count]');
  var empty = document.querySelector('[data-blog-empty]');
  var more = document.querySelector('[data-blog-more]');
  var pageSize = parseInt(root.getAttribute('data-page-size'), 10) || 6;
  // Count and button wording comes from the page (translated on /es), with {n} and {x} filled in here.
  var strings = {};
  Array.prototype.forEach.call(root.querySelectorAll('[data-blog-strings] [data-k]'), function (el) { strings[el.getAttribute('data-k')] = el.textContent; });
  var moreLabel = more ? more.textContent : '';
  function fmt(key, n, x) { return (strings[key] || '').replace('{n}', n).replace('{x}', x); }
  var params = new URLSearchParams(window.location.search);
  var state = { category: params.get('category') || '', q: (params.get('q') || '').trim(), shown: pageSize };
  if (state.category && !root.querySelector('[data-category="' + state.category + '"]')) state.category = '';
  if (search && state.q) search.value = state.q;

  function words() {
    return state.q.toLowerCase().split(/\s+/).filter(Boolean);
  }
  function matches(card, terms) {
    if (state.category && card.getAttribute('data-category') !== state.category) return false;
    if (!terms.length) return true;
    var hay = card.getAttribute('data-search') || '';
    for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) return false;
    return true;
  }

  function render() {
    var terms = words();
    var matched = 0;
    cards.forEach(function (card) {
      var ok = matches(card, terms);
      var visible = ok && matched < state.shown;
      if (ok) matched++;
      card.classList.toggle('is-hidden', !visible);
    });
    var visibleCount = Math.min(matched, state.shown);
    if (count) {
      count.textContent = matched === 0 ? '' : matched === cards.length && visibleCount === matched ? fmt('all', matched) : fmt(matched === cards.length ? 'some' : 'match', visibleCount, matched);
    }
    if (empty) empty.hidden = matched !== 0;
    if (more) {
      var left = matched - visibleCount;
      more.style.display = left > 0 ? '' : 'none';
      more.textContent = left > 0 ? fmt('more', left) : moreLabel;
    }
    Array.prototype.forEach.call(root.querySelectorAll('[data-category]'), function (chip) {
      var active = chip.getAttribute('data-category') === state.category;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    var q = new URLSearchParams();
    if (state.category) q.set('category', state.category);
    if (state.q) q.set('q', state.q);
    var url = window.location.pathname + (q.toString() ? '?' + q.toString() : '');
    if (window.history && window.history.replaceState) window.history.replaceState(null, '', url);
  }

  root.addEventListener('click', function (event) {
    var chip = event.target.closest ? event.target.closest('.ww-rchip') : null;
    if (!chip) return;
    state.category = chip.getAttribute('data-category') || '';
    state.shown = pageSize;
    render();
  });
  if (search) {
    var timer = null;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        state.q = search.value.trim();
        state.shown = pageSize;
        render();
      }, 120);
    });
    search.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { search.value = ''; state.q = ''; state.shown = pageSize; render(); }
    });
  }
  if (more) {
    more.addEventListener('click', function () {
      state.shown += pageSize;
      render();
    });
  }
  render();
})();
