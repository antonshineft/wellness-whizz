/* Wellness quiz, one question per screen (built for a visitor arriving on a phone from the Instagram bio link).
   A layer over the ordinary form: the form, its field names, the validation, the waiting screen and the request to
   /api/quiz in quiz.js all stay as they are. This script hides the long form, asks its five questions one at a time
   with answers the size of a thumb, writes the choices back into the real fields and then submits the form.
   Without JavaScript, or if anything here fails, the visitor gets the ordinary form.

   On a desktop screen the same steps take the left half of the panel and the right half is one full-frame drawing from
   the site's videos with a line from that video laid over it like a post. The pairs (public/js/quiz-facts.js) turn
   over on a timer, and one that suits the goal just picked, or the question on screen, comes up first. DESKTOP below
   says whether desktop visitors get this, or the long form as before.

   The answers shown come from the page itself (radio labels, the activity list, the diet and goal chips), so the
   Spanish page, which the Worker translates before sending, needs no second list here. Only the new wording does. */
(function () {
  var LANG = ((document.documentElement.getAttribute('lang') || 'en').slice(0, 2) === 'es') ? 'es' : 'en';
  var T = LANG === 'es' ? {
    goalAsk: '¿Con qué te gustaría que te ayudemos?',
    goalHint: 'Elige hasta tres.',
    goalOwn: '¿Otra cosa? Escríbela',
    sexAsk: '¿Cuál es tu sexo biológico?',
    sexHint: 'Algunas necesidades cambian, como el hierro.',
    ageAsk: '¿Qué edad tienes?',
    ages: { '<18': 'Menos de 18', '18-25': '18 a 25', '26-40': '26 a 40', '41-65': '41 a 65', '65+': 'Más de 65' },
    activityAsk: '¿Cuánto te mueves?',
    activityHints: {
      'Sedentary': 'Casi todo el día sentado',
      'Lightly Active': 'Paseos y ejercicio suave una o dos veces por semana',
      'Moderately Active': 'Ejercicio tres o cuatro veces por semana',
      'Very Active': 'Ejercicio intenso casi todos los días',
      'Extra Active': 'Trabajo físico o entrenamiento diario'
    },
    dietAsk: '¿Sigues alguna dieta?',
    dietHint: 'Elige todas las que correspondan.',
    dietOwn: '¿Otra dieta? Escríbela',
    next: 'Continuar',
    finish: 'Ver mis suplementos',
    back: 'Atrás',
    count: function (n, total) { return n + ' de ' + total; }
  } : {
    goalAsk: 'What would you like help with?',
    goalHint: 'Pick up to three.',
    goalOwn: 'Something else? Type it',
    sexAsk: 'Your biological sex?',
    sexHint: 'Some needs differ, such as iron.',
    ageAsk: 'How old are you?',
    ages: { '<18': 'Under 18', '18-25': '18 to 25', '26-40': '26 to 40', '41-65': '41 to 65', '65+': 'Over 65' },
    activityAsk: 'How active are you?',
    activityHints: {
      'Sedentary': 'Mostly sitting',
      'Lightly Active': 'Walks, light exercise once or twice a week',
      'Moderately Active': 'Exercise three or four times a week',
      'Very Active': 'Hard exercise most days',
      'Extra Active': 'Physical job or daily training'
    },
    dietAsk: 'Any diet you follow?',
    dietHint: 'Pick all that apply.',
    dietOwn: 'Another diet? Type it',
    next: 'Continue',
    finish: 'See my supplements',
    back: 'Back',
    count: function (n, total) { return n + ' of ' + total; }
  };
  var MAX_GOALS = 3;
  var STEPS_UP_TO = '(max-width: 991px)'; // phones and tablets; decided once, when the page loads
  var DESKTOP = 'on'; // 'off': the long form. 'preview': the two halves only when the address ends in ?split=1. 'on': for everyone (the owner's go, 12 Nov).
  var ROTATE_EVERY = 7000; // ms a drawing and its line stay up
  var HANDLE = '@aiwwio';
  var ADVANCE_AFTER = 260; // ms a single choice stays lit before the next question appears

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clean(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
  function sentence(text) { var t = clean(text); return t.charAt(0) + t.slice(1).toLowerCase(); } // "Lightly Active" reads as "Lightly active"
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  /* The answers, read from the form as the page was sent. Returns null when the form is not the one this was written for. */
  function readForm(form) {
    var goalInput = form.querySelector('input[name="Goal"]');
    var dietInput = form.querySelector('input[name="Diet"]');
    var activity = form.querySelector('select[name="Activity-Level"]');
    var sexRadios = form.querySelectorAll('input[type="radio"][name="Sex"]');
    var ageRadios = form.querySelectorAll('input[type="radio"][name="Age2"]');
    if (!goalInput || !dietInput || !activity || sexRadios.length < 2 || ageRadios.length < 2) return null;
    function chips(input) {
      var group = input.id ? form.querySelector('.ww-chips[data-chips-for="' + input.id + '"]') : null;
      return group ? Array.prototype.map.call(group.querySelectorAll('.ww-chip'), function (c) {
        return { value: clean(c.getAttribute('data-value') || c.textContent), label: clean(c.textContent), exclusive: c.getAttribute('data-exclusive') === 'true' };
      }) : [];
    }
    var goals = chips(goalInput), diets = chips(dietInput);
    if (goals.length < 2 || diets.length < 2) return null;
    return {
      goalInput: goalInput, dietInput: dietInput, activity: activity, sexRadios: sexRadios, ageRadios: ageRadios,
      steps: [
        { key: 'goal', ask: T.goalAsk, hint: T.goalHint, many: MAX_GOALS, own: T.goalOwn, list: goals },
        { key: 'sex', ask: T.sexAsk, hint: T.sexHint, list: Array.prototype.map.call(sexRadios, function (r) {
          var label = r.parentNode ? r.parentNode.querySelector('.radio-button-label') : null;
          return { value: r.value, label: clean(label ? label.textContent : r.value) };
        }) },
        { key: 'age', ask: T.ageAsk, list: Array.prototype.map.call(ageRadios, function (r) { return { value: r.value, label: T.ages[r.value] || r.value }; }) },
        { key: 'activity', ask: T.activityAsk, list: Array.prototype.map.call(activity.options, function (o) {
          return { value: o.value, label: LANG === 'en' ? sentence(o.textContent) : clean(o.textContent), note: T.activityHints[o.value] || '' };
        }) },
        { key: 'diet', ask: T.dietAsk, hint: T.dietHint, many: 99, own: T.dietOwn, list: diets }
      ]
    };
  }

  /* The right half on a desktop screen. Returns two calls the steps use: goals(positions picked) and step(key). */
  function sidePanel(panel) {
    var box = el('aside', 'ww-side'); box.setAttribute('aria-label', LANG === 'es' ? '¿Sabías que…?' : 'Did you know?');
    var pics = [el('img', 'ww-side-pic'), el('img', 'ww-side-pic')];
    pics.forEach(function (im) { im.alt = ''; im.decoding = 'async'; box.appendChild(im); });
    var card = el('div', 'ww-side-post'), text = el('p', 'ww-side-text');
    var who = el('div', 'ww-side-who'); who.appendChild(el('b', '', 'Wellness Whizz')); who.appendChild(el('span', '', HANDLE));
    var words = el('div', 'ww-side-words'); words.appendChild(who); words.appendChild(text);
    card.appendChild(el('span', 'ww-side-logo')); card.appendChild(words); box.appendChild(card);
    panel.appendChild(box);

    var facts = [], seen = {}, current = null, front = 0, tick = null, held = false, goals = [], stepKey = '';
    function suits(f) { return (f.step && f.step === stepKey) || f.goals.some(function (g) { return goals.indexOf(g) >= 0; }); }
    function upNext() {
      var fresh = facts.filter(function (f) { return !seen[f.id]; });
      if (!fresh.length) { seen = {}; if (current) seen[current.id] = true; fresh = facts.filter(function (f) { return !seen[f.id]; }); }
      return fresh.filter(suits)[0] || fresh[0] || null;
    }
    function show(f) {
      if (!f || f === current) return;
      current = f; seen[f.id] = true;
      var back = pics[1 - front];
      back.onload = function () { // the next drawing fades in over the last one, and the line changes with it
        pics[front].classList.remove('is-on'); back.classList.add('is-on'); front = 1 - front;
        card.classList.add('is-changing');
        setTimeout(function () { text.textContent = f[LANG] || f.en; card.classList.remove('is-changing'); }, reducedMotion() ? 0 : 220);
      };
      back.src = '/images/quiz/' + f.id + '.webp';
    }
    function wind() { // a visitor who asked for less motion keeps one drawing per question, changed only by what they pick
      clearTimeout(tick);
      if (reducedMotion()) return;
      tick = setTimeout(function () { if (!held) show(upNext()); wind(); }, ROTATE_EVERY);
    }
    function bring() { // something was picked: a pair that suits it comes up now, if one is waiting
      var forStep = facts.filter(function (f) { return !seen[f.id] && f.step && f.step === stepKey; })[0];
      var match = forStep || facts.filter(function (f) { return !seen[f.id] && suits(f); })[0];
      if (match && (forStep || !(current && suits(current)))) { show(match); wind(); } // a pair made for this question goes first
    }
    box.addEventListener('mouseenter', function () { held = true; });
    box.addEventListener('mouseleave', function () { held = false; });

    var script = document.createElement('script');
    script.src = '/js/quiz-facts.js';
    script.onload = function () { facts = window.wwQuizFacts || []; card.classList.add('is-ready'); show(upNext()); wind(); };
    document.head.appendChild(script);
    return {
      goals: function (list) { goals = list; bring(); },
      step: function (key) { stepKey = key; bring(); }
    };
  }

  function start(form, split) {
    var data = readForm(form);
    if (!data) return;
    var steps = data.steps;
    var panel = form.closest('.sliderblock') || form.parentNode;
    var answers = { goal: [], diet: [], sex: '', age: '', activity: '' };
    var typed = { goal: '', diet: '' };
    var at = 0, started = false, timer = null, side = null;

    var root = el('div', 'ww-st');
    var head = el('div', 'ww-st-head');
    var back = el('button', 'ww-st-back'); back.type = 'button'; back.setAttribute('aria-label', T.back); back.textContent = '←';
    var track = el('div', 'ww-st-track'), fill = el('b'); track.appendChild(fill);
    var count = el('span', 'ww-st-count');
    head.appendChild(back); head.appendChild(track); head.appendChild(count);
    var body = el('div', 'ww-st-body');
    var bar = el('div', 'ww-st-bar');
    var verify = el('div', 'ww-st-verify'); // the bot check, when the site has one switched on, sits above the last button
    var go = el('button', 'ww-st-go'); go.type = 'button';
    bar.appendChild(verify); bar.appendChild(go);
    root.appendChild(head); root.appendChild(body); root.appendChild(bar);

    function has(key) { return Array.isArray(answers[key]) ? (answers[key].length > 0 || !!clean(typed[key])) : !!answers[key]; }

    /* Bring the question to the top of the screen once the visitor is under way. */
    function settle() {
      if (!started) return;
      var top = root.getBoundingClientRect().top;
      if (top >= 0 && top < window.innerHeight * 0.3) return;
      window.scrollTo({ top: Math.max(0, top + window.pageYOffset - 14), behavior: reducedMotion() ? 'auto' : 'smooth' });
    }

    function draw(focus) {
      clearTimeout(timer);
      var step = steps[at];
      back.disabled = at === 0;
      fill.style.width = ((at + 1) / steps.length * 100) + '%';
      count.textContent = T.count(at + 1, steps.length);
      body.innerHTML = '';
      var ask = el('h2', 'ww-st-ask', step.ask); ask.tabIndex = -1;
      body.appendChild(ask);
      if (step.hint) body.appendChild(el('p', 'ww-st-hint', step.hint));
      var grid = el('div', 'ww-st-opts' + (step.many && step.list.length > 8 ? ' is-two' : ''));
      grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', step.ask);

      function chosen(value) { return step.many ? answers[step.key].indexOf(value) >= 0 : answers[step.key] === value; }
      function paint() {
        var full = !!step.many && answers[step.key].length >= step.many;
        Array.prototype.forEach.call(grid.children, function (b) {
          var on = chosen(b.getAttribute('data-value'));
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          b.classList.toggle('is-dim', !!(full && !on)); // the limit is reached: the rest step back
        });
        go.disabled = !has(step.key);
      }

      step.list.forEach(function (o) {
        var b = el('button', 'ww-st-opt'); b.type = 'button'; b.setAttribute('data-value', o.value);
        var text = el('span', 'ww-st-opt-text', o.label);
        if (o.note) text.appendChild(el('small', '', o.note));
        b.appendChild(text); b.appendChild(el('i', '', '✓'));
        b.addEventListener('click', function () {
          if (!started) { started = true; panel.classList.add('ww-quiz-started'); if (window.wwTrack) window.wwTrack({ type: 'quiz_start', page: window.location.pathname }); }
          if (!step.many) {
            answers[step.key] = o.value; paint();
            timer = setTimeout(next, reducedMotion() ? 0 : ADVANCE_AFTER);
            return;
          }
          var list = answers[step.key], i = list.indexOf(o.value);
          if (i >= 0) list.splice(i, 1);
          else if (o.exclusive) answers[step.key] = [o.value]; // "No restrictions" replaces everything else
          else {
            answers[step.key] = list = list.filter(function (v) { return !step.list.some(function (x) { return x.exclusive && x.value === v; }); });
            if (list.length < step.many) list.push(o.value);
          }
          paint();
          if (side && step.key === 'goal') side.goals(answers.goal.map(function (v) { return step.list.map(function (x) { return x.value; }).indexOf(v); }));
        });
        grid.appendChild(b);
      });
      body.appendChild(grid);

      if (step.own) {
        var own = el('input', 'ww-st-own'); own.type = 'text'; own.maxLength = 120; own.id = 'ww-st-own-' + step.key;
        own.placeholder = step.own; own.setAttribute('aria-label', step.own); own.autocomplete = 'off'; own.value = typed[step.key];
        own.addEventListener('input', function () { typed[step.key] = own.value; go.disabled = !has(step.key); });
        own.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (!go.disabled) next(); } }); // Enter must not send the half-filled form
        body.appendChild(own);
      }

      var last = at === steps.length - 1;
      go.textContent = last ? T.finish : T.next;
      bar.hidden = !step.many;
      if (last) { var holder = form.querySelector('.turnstile-holder'); if (holder && holder.parentNode !== verify) verify.appendChild(holder); }
      verify.hidden = !last;
      paint();
      settle();
      if (side) side.step(step.key);
      if (focus) try { ask.focus({ preventScroll: true }); } catch (e) { /* older browsers */ }
    }

    function next() {
      if (!has(steps[at].key)) return;
      if (at < steps.length - 1) { at += 1; draw(true); }
      else send();
    }

    /* Write the choices into the real fields and hand over to the form's own submit (quiz.js). */
    function send() {
      function pick(radios, value) { Array.prototype.forEach.call(radios, function (r) { r.checked = r.value === value; }); }
      function words(key) { var extra = clean(typed[key]); return answers[key].concat(extra ? [extra] : []).join(', '); }
      pick(data.sexRadios, answers.sex);
      pick(data.ageRadios, answers.age);
      data.activity.value = answers.activity;
      data.goalInput.value = words('goal');
      data.dietInput.value = words('diet');
      [data.goalInput, data.dietInput].forEach(function (input) { input.dispatchEvent(new Event('input', { bubbles: true })); });
      var submit = new Event('submit', { bubbles: true, cancelable: true });
      if (form.dispatchEvent(submit)) form.submit(); // nothing took the event: let the browser post the form
    }

    back.addEventListener('click', function () { if (at > 0) { at -= 1; draw(true); } });
    go.addEventListener('click', next);

    form.insertBefore(root, form.firstChild);
    draw(false);
    form.classList.add('ww-steps-on'); // only now is the long form hidden
    panel.classList.add('ww-quiz-steps');
    if (split) { panel.classList.add('ww-quiz-split'); side = sidePanel(panel); side.step(steps[at].key); }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('quiz-form');
    if (!form) return;
    if (!window.matchMedia) return;
    var small = window.matchMedia(STEPS_UP_TO).matches;
    var split = !small && (DESKTOP === 'on' || (DESKTOP === 'preview' && /[?&]split=1(&|$)/.test(window.location.search)));
    if (!small && !split) return; // desktop keeps the long form
    try { start(form, split); } catch (e) { // anything unexpected: the ordinary form stays
      form.classList.remove('ww-steps-on');
      Array.prototype.forEach.call(document.querySelectorAll('.ww-st, .ww-side'), function (half) { half.parentNode.removeChild(half); });
      Array.prototype.forEach.call(document.querySelectorAll('.ww-quiz-steps'), function (p) { p.classList.remove('ww-quiz-steps', 'ww-quiz-split'); });
      if (window.console) console.error('quiz steps:', e);
    }
  });
})();
