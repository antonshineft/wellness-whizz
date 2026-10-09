/* Research page: category and study-type filters, and the list ten notes at a time.
   Every note is already in the HTML; this only hides and shows. The chosen filters live in the URL (?category=&type=)
   so a filtered view can be shared. Without JavaScript the full list simply shows. */
(function () {
  var root = document.querySelector('[data-research-filter]');
  var list = document.querySelector('[data-research-list]');
  if (!root || !list) return;
  var notes = Array.prototype.slice.call(list.querySelectorAll('.ww-note'));
  var more = document.querySelector('[data-research-more]');
  var count = root.querySelector('[data-research-count]');
  var pageSize = parseInt(root.getAttribute('data-page-size'), 10) || 10;
  var params = new URLSearchParams(window.location.search);
  var state = { category: params.get('category') || '', type: params.get('type') || '', shown: pageSize };

  function has(chipAttr, value) {
    return !!root.querySelector('[' + chipAttr + '="' + value + '"]');
  }
  if (state.category && !has('data-category', state.category)) state.category = '';
  if (state.type && !has('data-type', state.type)) state.type = '';

  function matches(note) {
    if (state.category && note.getAttribute('data-category') !== state.category) return false;
    if (state.type && (' ' + (note.getAttribute('data-types') || '') + ' ').indexOf(' ' + state.type + ' ') < 0) return false;
    return true;
  }

  function render() {
    var matched = 0;
    notes.forEach(function (note) {
      var ok = matches(note);
      var visible = ok && matched < state.shown;
      if (ok) matched++;
      note.hidden = !visible;
    });
    var visibleCount = Math.min(matched, state.shown);
    if (count) {
      count.textContent = matched === 0 ? 'No notes match these filters yet.' : matched === notes.length && visibleCount === matched ? 'Showing all ' + matched + ' notes' : 'Showing ' + visibleCount + ' of ' + matched + (matched === notes.length ? ' notes' : ' matching notes');
    }
    if (more) {
      var left = matched - visibleCount;
      more.hidden = left <= 0;
      more.textContent = left > 0 ? 'Show ' + Math.min(left, pageSize) + ' more' + (left > pageSize ? ' (' + left + ' left)' : '') : 'Show more';
    }
    Array.prototype.forEach.call(root.querySelectorAll('[data-category]'), function (chip) {
      var active = chip.getAttribute('data-category') === state.category;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-type]'), function (chip) {
      var active = chip.getAttribute('data-type') === state.type;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    var q = new URLSearchParams();
    if (state.category) q.set('category', state.category);
    if (state.type) q.set('type', state.type);
    var url = window.location.pathname + (q.toString() ? '?' + q.toString() : '');
    if (window.history && window.history.replaceState) window.history.replaceState(null, '', url);
  }

  root.addEventListener('click', function (event) {
    var chip = event.target.closest ? event.target.closest('.ww-rchip') : null;
    if (!chip) return;
    if (chip.hasAttribute('data-category')) state.category = chip.getAttribute('data-category');
    else if (chip.hasAttribute('data-type')) state.type = chip.getAttribute('data-type');
    state.shown = pageSize;
    render();
  });
  if (more) {
    more.addEventListener('click', function () {
      var firstHidden = null;
      for (var i = 0; i < notes.length; i++) {
        if (notes[i].hidden && matches(notes[i])) { firstHidden = notes[i]; break; }
      }
      state.shown += pageSize;
      render();
      if (firstHidden && firstHidden.focus) {
        firstHidden.setAttribute('tabindex', '-1');
        firstHidden.focus({ preventScroll: true });
      }
    });
  }
  render();
})();
