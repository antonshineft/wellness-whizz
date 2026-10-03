/* Wellness quiz: submits to /api/quiz (our Worker) instead of Webflow forms + Make.com, then opens the result page.
   If the Worker is configured with a Cloudflare Turnstile site key, the widget is rendered before the submit button. */
(function () {
  var POLL_ATTEMPTS = 80; // x 3 s = 4 min, matches the server's pending timeout

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

    function resetForm() {
      if (hidden) hidden.value = randomId(); // every attempt is a new session
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
    window.addEventListener('pageshow', function (event) {
      if (event.persisted) resetForm();
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
            if (j && j.status === 'ready') window.location.href = j.url;
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
          if (res.ok && res.body && res.body.url) window.location.href = res.body.url;
          else showError(res.body && res.body.error);
        })
        .catch(function () { pollStatus(sessionId, 0); });
    });
  });
})();
