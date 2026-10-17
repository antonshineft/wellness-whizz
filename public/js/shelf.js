/* Shelf scan: resize the chosen photos in the browser, send them as JSON, open the result. */
(function () {
  var form = document.getElementById('ww-shelf');
  if (!form) return;
  var LANG = ((document.documentElement.getAttribute('lang') || 'en').slice(0, 2) === 'es') ? 'es' : 'en';
  var T = LANG === 'es'
    ? { pick: 'Elige entre 1 y 3 fotos.', tooMany: 'Máximo 3 fotos; se usan las tres primeras.', reading: 'Preparando las fotos…', sending: 'Leyendo las etiquetas. Suele tardar menos de un minuto.', done: 'Listo, abriendo el resultado…', failed: 'Algo salió mal. Inténtalo de nuevo.', notImage: 'Ese archivo no es una imagen.' }
    : { pick: 'Choose 1 to 3 photos.', tooMany: 'At most 3 photos; the first three are used.', reading: 'Preparing the photos…', sending: 'Reading the labels. This usually takes under a minute.', done: 'All set, opening your result…', failed: 'Something went wrong. Please try again.', notImage: 'That file is not an image.' };
  var input = document.getElementById('ww-shelf-files');
  var previews = document.getElementById('ww-shelf-previews');
  var submit = document.getElementById('ww-shelf-submit');
  var status = document.getElementById('ww-shelf-status');
  var images = [];
  var MAX = 1400;

  function say(text) { if (status) status.textContent = text || ''; }

  function resize(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) return reject(new Error(T.notImage));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, MAX / Math.max(w, h));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        resolve({ media_type: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error(T.notImage)); };
      img.src = url;
    });
  }

  input.addEventListener('change', function () {
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return;
    if (files.length > 3) say(T.tooMany); else say(T.reading);
    files = files.slice(0, 3);
    images = [];
    previews.innerHTML = '';
    submit.disabled = true;
    Promise.all(files.map(resize)).then(function (out) {
      images = out;
      previews.innerHTML = out.map(function (o) { return '<img src="' + o.preview + '" alt="">'; }).join('');
      submit.disabled = false;
      say('');
    }).catch(function (err) { say(err && err.message ? err.message : T.failed); });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!images.length) { say(T.pick); return; }
    submit.disabled = true;
    say(T.sending);
    var goal = (form.querySelector('[name=goal]') || {}).value || '';
    fetch('/api/shelf', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ images: images.map(function (i) { return { media_type: i.media_type, data: i.data }; }), goal: goal, lang: LANG })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (res.ok && res.body && res.body.url) { say(T.done); window.location.href = res.body.url; }
        else { say((res.body && res.body.error) || T.failed); submit.disabled = false; }
      })
      .catch(function () { say(T.failed); submit.disabled = false; });
  });
})();
