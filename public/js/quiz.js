/* Wellness quiz: submits to /api/quiz (our Worker) instead of Webflow forms + Make.com, then opens the result page.
   If the Worker is configured with a Cloudflare Turnstile site key, the widget is rendered before the submit button.
   Also: suggestion chips under the Diet and Goal inputs (they only edit the free-text value the Worker reads),
   and a progress bar with rotating status messages while the recommendation is being prepared. */
(function () {
  var POLL_ATTEMPTS = 80; // x 3 s = 4 min, matches the server's pending timeout
  var WAIT_MESSAGES = [
    'Reading your answers…',
    'Checking 100+ supplements against your profile…',
    'Ruling out interactions and safety flags…',
    'Picking the three to five that fit best…',
    'Writing your personal explanations…',
    'Finding matching products on iHerb…',
    'Almost there, double-checking the list…'
  ];
  var MESSAGE_EVERY = 4000; // ms between status messages; the last one is held until the result is ready
  var FILL_SECONDS = 40; // the bar eases to 90% over this long, then creeps towards 97%

  function randomId() {
    var bytes = new Uint8Array(12);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var out = '';
    for (var j = 0; j < bytes.length; j++) out += ('0' + bytes[j].toString(16)).slice(-2);
    return out;
  }

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function highlightRadios(groupName, labelSelector) {
    var radios = document.querySelectorAll('input[type="radio"][data-radio-group="' + groupName + '"]');
    Array.prototype.forEach.call(radios, function (radio) {
      radio.addEventListener('change', function (event) {
        var labels = document.querySelectorAll(labelSelector);
        Array.prototype.forEach.call(labels, function (label) { label.style.backgroundColor = ''; });
        var label = event.target.closest(labelSelector);
        if (label) label.style.backgroundColor = 'white';
      });
    });
  }

  /* ---------- suggestion chips ----------
     A .ww-chips row points at a text input (data-chips-for). Clicking a chip adds or removes its text in that
     input, comma separated, keeping whatever the user typed. The chips' pressed state always follows the text,
     so typing or deleting a chip's words by hand selects or unselects it too. */
  function splitCommas(value) {
    var out = [];
    var parts = String(value || '').split(',');
    for (var i = 0; i < parts.length; i++) {
      var token = parts[i].trim();
      if (token) out.push(token);
    }
    return out;
  }

  // Comma-separated tokens; a chip whose own text has a comma ("Skin, hair & nails") is put back together.
  function splitTokens(value, chipValues) {
    var out = splitCommas(value);
    for (var c = 0; c < chipValues.length; c++) {
      var parts = splitCommas(chipValues[c]);
      if (parts.length < 2) continue;
      for (var i = 0; i + parts.length <= out.length; i++) {
        var match = true;
        for (var k = 0; k < parts.length && match; k++) match = sameText(out[i + k], parts[k]);
        if (match) out.splice(i, parts.length, chipValues[c]);
      }
    }
    return out;
  }

  function chipValue(chip) {
    return (chip.getAttribute('data-value') || chip.textContent || '').trim();
  }

  function sameText(a, b) {
    return a.toLowerCase() === b.toLowerCase();
  }

  function setupChips(group) {
    var input = document.getElementById(group.getAttribute('data-chips-for'));
    if (!input) return null;
    var chips = group.querySelectorAll('.ww-chip');
    var values = Array.prototype.map.call(chips, chipValue);

    function sync() {
      var tokens = splitTokens(input.value, values);
      Array.prototype.forEach.call(chips, function (chip) {
        var value = chipValue(chip);
        var on = tokens.some(function (token) { return sameText(token, value); });
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    function without(tokens, value) {
      return tokens.filter(function (token) { return !sameText(token, value); });
    }

    function toggle(chip) {
      var value = chipValue(chip);
      var tokens = splitTokens(input.value, values);
      if (chip.getAttribute('aria-pressed') === 'true') {
        tokens = without(tokens, value);
      } else if (chip.getAttribute('data-exclusive') === 'true') {
        tokens = [value]; // "No restrictions" replaces everything else
      } else {
        Array.prototype.forEach.call(chips, function (other) { // a specific choice drops "No restrictions"
          if (other.getAttribute('data-exclusive') === 'true') tokens = without(tokens, chipValue(other));
        });
        tokens.push(value);
      }
      input.value = tokens.join(', ');
      sync();
    }

    group.addEventListener('click', function (event) {
      var chip = event.target.closest('.ww-chip');
      if (chip && group.contains(chip)) toggle(chip);
    });
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    sync();
    return sync;
  }

  document.addEventListener('DOMContentLoaded', function () {
    highlightRadios('myRadioGroup', 'label.radio-button-field.w-radio');
    highlightRadios('myRadioGroupAge', 'label.radio-button-field.age.w-radio');

    var form = document.getElementById('quiz-form');
    if (!form) return;
    if (window.wwTrack) window.wwTrack({ type: 'quiz_view', page: window.location.pathname });
    var block = form.closest('.quiz-form-block') || form.parentNode;
    var done = block.querySelector('.w-form-done');
    var fail = block.querySelector('.w-form-fail');
    var failText = fail ? fail.querySelector('div') : null;
    var submitBtn = form.querySelector('input[type="submit"]');
    var submitLabel = submitBtn ? submitBtn.value : '';
    var hidden = form.querySelector('input[name="sessionID"]');
    var turnstile = { enabled: false, token: '', widgetId: null };

    var chipSyncs = [];
    Array.prototype.forEach.call(form.querySelectorAll('.ww-chips'), function (group) {
      var sync = setupChips(group);
      if (sync) chipSyncs.push(sync);
    });
    function syncChips() {
      for (var i = 0; i < chipSyncs.length; i++) chipSyncs[i]();
    }

    /* ---------- waiting screen: rotating status + progress bar ---------- */
    var wait = document.getElementById('ww-wait');
    var waitMsg = document.getElementById('ww-wait-msg');
    var waitFill = document.getElementById('ww-wait-fill');
    var waitStatus = document.getElementById('ww-wait-status'); // screen-reader only, announced once
    var waiting = { tick: null, rotate: null, fade: null, startedAt: 0, index: 0 };

    function progressAt(seconds) {
      if (seconds <= FILL_SECONDS) {
        var k = 1 - seconds / FILL_SECONDS;
        return 90 * (1 - k * k * k); // ease-out cubic to 90%
      }
      return 90 + 7 * (1 - Math.exp(-(seconds - FILL_SECONDS) / 60)); // then slowly towards 97%
    }

    function clearWaitTimers() {
      clearInterval(waiting.tick);
      clearInterval(waiting.rotate);
      clearTimeout(waiting.fade);
      waiting.tick = waiting.rotate = waiting.fade = null;
    }

    function setMessage(text) {
      if (!waitMsg) return;
      if (prefersReducedMotion()) {
        waitMsg.textContent = text;
        return;
      }
      waitMsg.classList.add('is-fading');
      waiting.fade = setTimeout(function () {
        waitMsg.textContent = text;
        waitMsg.classList.remove('is-fading');
      }, 250);
    }

    function stopWaiting() {
      clearWaitTimers();
      waiting.index = 0;
      if (wait) wait.classList.remove('is-done');
      if (waitFill) waitFill.style.width = '0%';
      if (waitMsg) {
        waitMsg.textContent = WAIT_MESSAGES[0];
        waitMsg.classList.remove('is-fading');
      }
      if (waitStatus) waitStatus.textContent = '';
    }

    function startWaiting() {
      stopWaiting();
      waiting.startedAt = Date.now();
      if (waitStatus) waitStatus.textContent = 'Preparing your recommendation. This usually takes under a minute.';
      waiting.rotate = setInterval(function () {
        waiting.index += 1;
        setMessage(WAIT_MESSAGES[waiting.index]);
        if (waiting.index >= WAIT_MESSAGES.length - 1) clearInterval(waiting.rotate); // hold the last message
      }, MESSAGE_EVERY);
      if (!waitFill || prefersReducedMotion()) return; // the bar is hidden; the text alone tells the story
      waiting.tick = setInterval(function () {
        waitFill.style.width = progressAt((Date.now() - waiting.startedAt) / 1000).toFixed(1) + '%';
      }, 200);
    }

    // Fill the bar, say we are done, then open the result page.
    function finishWaiting(url) {
      clearWaitTimers();
      if (wait) wait.classList.add('is-done');
      if (waitMsg) {
        waitMsg.textContent = 'All set, opening your results…';
        waitMsg.classList.remove('is-fading');
      }
      if (waitFill) waitFill.style.width = '100%';
      if (waitStatus) waitStatus.textContent = 'Your results are ready.';
      setTimeout(function () { window.location.href = url; }, prefersReducedMotion() ? 0 : 450);
    }

    function resetForm() {
      if (hidden) hidden.value = randomId(); // every attempt is a new session
      stopWaiting();
      syncChips();
      if (done) done.style.display = 'none';
      form.style.display = '';
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.value = submitLabel;
      }
      if (turnstile.enabled && window.turnstile && turnstile.widgetId !== null) {
        turnstile.token = '';
        window.turnstile.reset(turnstile.widgetId);
      }
    }
    resetForm();

    // Coming back with the browser's Back button restores the page from cache, frozen on the waiting screen.
    // On an ordinary load the browser may have restored typed values after our setup, so re-sync the chips.
    window.addEventListener('pageshow', function (event) {
      if (event.persisted) resetForm();
      else syncChips();
    });

    // Optional bot protection: ask the Worker whether Turnstile is configured and render the widget if so.
    fetch('/api/config', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (config) {
        if (!config || !config.turnstileSiteKey) return;
        turnstile.enabled = true;
        var holder = document.createElement('div');
        holder.className = 'turnstile-holder';
        holder.style.margin = '12px auto';
        submitBtn.parentNode.insertBefore(holder, submitBtn);
        window.__wwTurnstileReady = function () {
          turnstile.widgetId = window.turnstile.render(holder, {
            sitekey: config.turnstileSiteKey,
            theme: 'dark',
            callback: function (token) { turnstile.token = token; },
            'expired-callback': function () { turnstile.token = ''; },
            'error-callback': function () { turnstile.token = ''; }
          });
        };
        var script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__wwTurnstileReady';
        script.async = true;
        document.head.appendChild(script);
      })
      .catch(function () { /* no config endpoint: continue without Turnstile */ });

    function showWaiting() {
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.value = submitBtn.getAttribute('data-wait') || 'Please wait...';
      }
      form.style.display = 'none';
      if (fail) fail.style.display = 'none';
      if (done) done.style.display = 'block';
      startWaiting();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function showError(message) {
      resetForm();
      if (fail) fail.style.display = 'block';
      if (failText) failText.textContent = message || 'Oops! Something went wrong while submitting the form.';
    }

    // Used only when the first request did not come back (network drop, proxy timeout).
    function pollStatus(id, attempt) {
      if (attempt > POLL_ATTEMPTS) return showError('This is taking longer than expected. Please try again.');
      setTimeout(function () {
        fetch('/api/session/' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (j && j.status === 'ready') finishWaiting(j.url);
            else if (j && j.status === 'failed') showError();
            else pollStatus(id, attempt + 1);
          })
          .catch(function () { pollStatus(id, attempt + 1); });
      }, 3000);
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (typeof form.checkValidity === 'function' && !form.checkValidity()) {
        if (typeof form.reportValidity === 'function') form.reportValidity();
        return;
      }
      if (turnstile.enabled && !turnstile.token) {
        if (fail) fail.style.display = 'block';
        if (failText) failText.textContent = 'Please complete the verification above, then submit again.';
        return;
      }
      var payload = {};
      new FormData(form).forEach(function (value, key) { payload[key] = value; });
      if (turnstile.enabled) payload['cf-turnstile-response'] = turnstile.token;
      var sessionId = payload.sessionID;
      showWaiting();

      fetch('/api/quiz', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (r) {
          return r.json().then(function (j) { return { ok: r.ok, body: j }; });
        })
        .then(function (res) {
          if (res.ok && res.body && res.body.url) finishWaiting(res.body.url);
          else showError(res.body && res.body.error);
        })
        .catch(function () { pollStatus(sessionId, 0); });
    });
  });
})();
