// Страница для источника "Браузер" в OBS: прозрачный фон, подпись "кто говорит" и (в режиме OBS) звук.
// Те же цвета и шрифт Golos Text, что и в самой программе.
// Текст из чата вставляется только через textContent - никакой HTML-разметки от зрителей.

export function overlayPage(): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Озвучка чата</title>
<style>
@font-face { font-family: 'Golos Text'; font-weight: 500; src: url(/fonts/golos-500-cyr.woff2) format('woff2'); unicode-range: U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116; }
@font-face { font-family: 'Golos Text'; font-weight: 500; src: url(/fonts/golos-500-lat.woff2) format('woff2'); }
@font-face { font-family: 'Golos Text'; font-weight: 600; src: url(/fonts/golos-600-cyr.woff2) format('woff2'); unicode-range: U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116; }
@font-face { font-family: 'Golos Text'; font-weight: 600; src: url(/fonts/golos-600-lat.woff2) format('woff2'); }
:root {
  /* копия токенов из src/renderer/src/tokens.css */
  --color-paper-2: oklch(25.5% 0.008 275 / 0.92);
  --color-ink: oklch(94% 0.004 286);
  --color-ink-3: oklch(56% 0.012 286);
  --color-accent: oklch(76% 0.12 172);
  --color-live: oklch(70% 0.17 28);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
html, body { margin: 0; background: transparent; overflow: hidden; }
body { font-family: 'Golos Text', 'Segoe UI', sans-serif; }
.card {
  position: fixed; left: 32px; bottom: 32px; max-width: min(720px, calc(100vw - 64px));
  background: var(--color-paper-2); color: var(--color-ink);
  border-radius: 8px; padding: 14px 20px 16px;
  opacity: 0; transform: translateY(8px);
  transition: opacity 180ms var(--ease-out), transform 180ms var(--ease-out);
}
.card.on { opacity: 1; transform: none; }
.who { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 600; color: var(--color-accent); }
.who i { width: 8px; height: 8px; border-radius: 50%; background: var(--color-live); }
.text { font-size: 26px; font-weight: 500; line-height: 1.35; margin-top: 4px; overflow-wrap: anywhere; }
.hint { position: fixed; left: 32px; top: 32px; font-size: 16px; color: var(--color-ink); background: var(--color-paper-2); padding: 8px 12px; border-radius: 8px; display: none; }
@media (prefers-reduced-motion: reduce) { .card { transition: opacity 120ms linear; transform: none; } }
</style>
</head>
<body>
<div class="card" id="card"><div class="who"><i></i><span id="nick"></span></div><div class="text" id="text"></div></div>
<div class="hint" id="hint">Нажмите на страницу, чтобы включить звук (в OBS не нужно)</div>
<script>
(function () {
  var card = document.getElementById('card');
  var nickEl = document.getElementById('nick');
  var textEl = document.getElementById('text');
  var hint = document.getElementById('hint');
  var showText = true, hideTimer = null;
  var ctx = null, master = null, cur = null, volume = 1, ws = null;

  function audio() {
    if (!ctx) { ctx = new AudioContext(); master = ctx.createGain(); master.connect(ctx.destination); }
    return ctx;
  }
  function setVol(p) { volume = Math.max(0, Math.min(2, p / 100)); if (master) master.gain.value = volume; }
  function caption(nick, text) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (nick && showText) {
      nickEl.textContent = nick; textEl.textContent = text; card.classList.add('on');
    } else {
      hideTimer = setTimeout(function () { card.classList.remove('on'); }, nick ? 0 : 1200);
    }
  }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function b64(s) { var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a.buffer; }

  function play(m) {
    var c = audio();
    var go = function () {
      c.decodeAudioData(b64(m.audio)).then(function (buf) {
        setVol(m.volume);
        var src = c.createBufferSource(), fade = c.createGain();
        src.buffer = buf; src.connect(fade).connect(master);
        var me = { id: m.id, src: src, fade: fade, stopped: false };
        cur = me;
        src.onended = function () { if (cur === me) cur = null; send({ type: 'ended', id: m.id, result: me.stopped ? 'stopped' : 'ended' }); };
        var t = c.currentTime;
        if (m.trimSec !== null && m.trimSec < buf.duration) {
          fade.gain.setValueAtTime(1, Math.max(t, t + m.trimSec - 0.3));
          fade.gain.linearRampToValueAtTime(0, t + m.trimSec);
          src.start(t, 0, m.trimSec);
        } else src.start(t);
      }).catch(function (e) { send({ type: 'ended', id: m.id, result: 'stopped', error: String(e) }); });
    };
    if (c.state === 'suspended') {
      c.resume().then(go);
      if (c.state === 'suspended') hint.style.display = 'block';
    } else go();
  }
  function stop(m) {
    if (!cur || (m.id && cur.id !== m.id)) return;
    cur.stopped = true;
    var t = ctx.currentTime, g = cur.fade.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + m.fadeMs / 1000);
    cur.src.stop(t + m.fadeMs / 1000);
  }
  document.addEventListener('click', function () { audio().resume(); hint.style.display = 'none'; });

  function connect() {
    ws = new WebSocket('ws://' + location.host + '/ws');
    ws.onopen = function () { send({ type: 'hello' }); };
    ws.onmessage = function (e) {
      var m = JSON.parse(e.data);
      if (m.type === 'config') { showText = m.showText; if (!showText) card.classList.remove('on'); }
      else if (m.type === 'caption') caption(m.nick, m.text);
      else if (m.type === 'play') play(m);
      else if (m.type === 'stop') stop(m);
      else if (m.type === 'pause' && ctx) ctx.suspend();
      else if (m.type === 'resume' && ctx) ctx.resume();
      else if (m.type === 'volume') setVol(m.volume);
    };
    ws.onclose = function () { card.classList.remove('on'); setTimeout(connect, 2000); };
  }
  connect();
})();
</script>
</body>
</html>`
}
