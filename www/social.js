/* www/social.js — имя, уникальность, память профиля, общий рейтинг */
(function () {
'use strict';

var API = (window.DESK_API_BASE || '') + '/api/leaderboard';
var LS_USER = 'sbeg.user', LS_LOCAL = 'sbeg.board.local', LS_QUEUE = 'sbeg.queue';
var NAME_MIN = 2, NAME_MAX = 18;
var NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{1,17}$/u;

/* ---------- утилиты ---------- */
function $(s, r) { return (r || document).querySelector(s); }
function mk(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
function fmt(n) { n = Math.round(Number(n) || 0); return n.toLocaleString('ru-RU'); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function ls(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function lss(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function cleanName(raw) { return String(raw || '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX); }
function nameKey(n) { return n.toLowerCase().replace(/ё/g, 'е').replace(/[._'-]/g, ' ').replace(/\s+/g, ' ').trim(); }
function validName(n) { return n.length >= NAME_MIN && n.length <= NAME_MAX && NAME_RE.test(n) && /[\p{L}\p{N}]{2}/u.test(n); }
function initials(n) { var p = n.split(' ').filter(Boolean); return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase(); }
function rid(n) { var a = 'abcdefghijkmnpqrstuvwxyz23456789', s = ''; for (var i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }

/* ---------- звук UI, подчинён общей кнопке 🔊 ---------- */
var SFX = {
  ctx: null,
  muted: function () { try { return JSON.parse(localStorage.getItem('sbeg.mute')) === true; } catch (e) { return false; } },
  unlock: function () {
    if (this.ctx) { if (this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) {} } return; }
    try { var AC = window.AudioContext || window.webkitAudioContext; if (AC) this.ctx = new AC(); } catch (e) {}
  },
  blip: function (f0, f1, dur, gain) {
    if (this.muted() || !this.ctx) return;
    try {
      var t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
      o.connect(g); g.connect(this.ctx.destination); o.start(t); o.stop(t + dur + .02);
    } catch (e) {}
  },
  tap: function () { this.blip(660, 480, .05, .05); },
  good: function () { this.blip(660, 990, .12, .07); setTimeout(this.blip.bind(this, 990, 1320, .14, .05), 90); },
  bad: function () { this.blip(300, 150, .18, .07); }
};

/* ---------- сеть ---------- */
function net(action, payload, query) {
  var url = API + '?action=' + encodeURIComponent(action) + (query || '');
  var opt = payload
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ action: action }, payload)) }
    : { method: 'GET' };
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (ctrl) opt.signal = ctrl.signal;
  var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 9000);
  return fetch(url, opt).then(function (r) {
    clearTimeout(timer);
    return r.json().catch(function () { return { ok: false, code: 'parse' }; });
  }).catch(function () { clearTimeout(timer); return { ok: false, code: 'offline' }; });
}

/* ---------- состояние ---------- */
var S = {
  user: ls(LS_USER, null),
  online: true,
  board: null,
  tab: 'top',
  busy: false,
  lastRun: 0,
  gateOpen: false,
  recover: false,
  checkTimer: null,
  checkName: '',
  available: false
};
if (S.user && (!S.user.name || !S.user.id)) S.user = null;

/* ---------- локальный рейтинг (офлайн-запас) ---------- */
function localBoard() { var b = ls(LS_LOCAL, null); return b && b.players ? b : { players: {}, runs: 0 }; }
function localSubmit(run) {
  var b = localBoard(), k = nameKey(S.user.name), p = b.players[k];
  if (!p) { p = b.players[k] = { n: S.user.name, s: 0, d: 0, f: run.diff, r: 0, e: 0, u: 0, local: true }; }
  p.r++; b.runs++;
  var improved = run.score > p.s;
  if (improved) { p.s = run.score; p.d = run.dist; p.f = run.diff; p.e = run.euros; p.u = Date.now(); }
  lss(LS_LOCAL, b);
  var list = Object.keys(b.players).map(function (x) { return b.players[x]; }).sort(function (a, c) { return c.s - a.s; });
  var rank = 0; for (var i = 0; i < list.length; i++) if (nameKey(list[i].n) === k) rank = i + 1;
  return { ok: true, improved: improved, best: p.s, rank: rank, total: list.length, local: true };
}
function queuePush(run) { var q = ls(LS_QUEUE, []); q.push(run); if (q.length > 30) q.shift(); lss(LS_QUEUE, q); }
function queueFlush() {
  if (!S.user || S.user.local || !S.online) return;
  var q = ls(LS_QUEUE, []); if (!q.length) return;
  lss(LS_QUEUE, []);
  q.forEach(function (run) {
    net('submit', Object.assign({ id: S.user.id, token: S.user.token }, run)).then(function (r) {
      if (!r.ok && r.code !== 'short' && r.code !== 'implausible') queuePush(run);
    });
  });
}

/* ---------- DOM ---------- */
var gate, board, toastBox, boardBtn, mePill;

function buildUI() {
  var css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = 'social.css';
  document.head.appendChild(css);

  /* ворота имени */
  gate = mk('div', '', '');
  gate.id = 'sxGate';
  gate.innerHTML =
    '<div class="sx-card" role="dialog" aria-modal="true" aria-label="Имя сотрудника">' +
      '<div class="sx-eyebrow">СБЕР · 185 ЛЕТ · ПРОПУСК В ОПЕНСПЕЙС</div>' +
      '<div class="sx-h" id="sxTitle">Представься,<br>сотрудник</div>' +
      '<div class="sx-p" id="sxLead">Руководитель ведёт <b>рейтинг побегов</b>. Займи имя — оно будет <b>только твоим</b>, а результат попадёт в общую таблицу. Имя запомнится на этом устройстве.</div>' +
      '<div id="sxForm">' +
        '<div class="sx-field">' +
          '<input class="sx-input" id="sxName" type="text" maxlength="18" autocomplete="off" spellcheck="false" placeholder="Например: Шура с 12 этажа" aria-label="Имя">' +
          '<span class="sx-mark" id="sxMark"></span>' +
        '</div>' +
        '<div class="sx-hint" id="sxHint">2–18 символов: буквы, цифры, пробел</div>' +
        '<div class="sx-chips" id="sxChips"></div>' +
        '<div class="sx-row" id="sxCodeRow" style="display:none;margin-bottom:10px">' +
          '<input class="sx-input" id="sxCode" type="text" maxlength="6" autocomplete="off" spellcheck="false" placeholder="Код доступа" aria-label="Код доступа">' +
        '</div>' +
        '<button class="sx-btn" id="sxGo" type="button" disabled>ЗАНИЯТЬ ИМЯ</button>' +
      '</div>' +
      '<div class="sx-links">' +
        '<button class="sx-link" id="sxRecover" type="button">🔑 У меня уже есть имя</button>' +
        '<button class="sx-link" id="sxBoard2" type="button">🏆 Посмотреть рейтинг</button>' +
      '</div>' +
      '<div class="sx-note" id="sxFoot">Имя закрепляется за тобой навсегда. Код доступа покажем один раз — сохрани его, чтобы войти с другого телефона.</div>' +
    '</div>';
  document.body.appendChild(gate);

  /* таблица */
  board = mk('div', '', '');
  board.id = 'sxBoard';
  board.innerHTML =
    '<div class="sx-board" role="dialog" aria-modal="true" aria-label="Рейтинг">' +
      '<div class="sx-bhead">' +
        '<div><div class="sx-eyebrow">ОПЕНСПЕЙС · ОБЩИЙ ЗАЧЁТ</div><div class="sx-h">Рейтинг побегов</div></div>' +
        '<button class="sx-close" id="sxClose" type="button" aria-label="Закрыть">✕</button>' +
      '</div>' +
      '<div class="sx-stats" id="sxStats"></div>' +
      '<div class="sx-tabs">' +
        '<button class="sx-tab on" data-tab="top" type="button">🏆 Топ сотрудников</button>' +
        '<button class="sx-tab" data-tab="me" type="button">👤 Мой результат</button>' +
      '</div>' +
      '<div class="sx-list" id="sxList"></div>' +
      '<div id="sxOff"></div>' +
      '<div class="sx-links"><button class="sx-link" id="sxRefresh" type="button">↻ Обновить таблицу</button></div>' +
    '</div>';
  document.body.appendChild(board);

  toastBox = mk('div', '', ''); toastBox.id = 'sxToast'; document.body.appendChild(toastBox);

  /* кнопка в HUD */
  var right = $('.hud-right');
  if (right) {
    boardBtn = mk('button', 'icon-btn', '🏆');
    boardBtn.id = 'boardBtn'; boardBtn.type = 'button';
    boardBtn.title = 'Рейтинг сотрудников'; boardBtn.setAttribute('aria-label', 'Рейтинг');
    right.insertBefore(boardBtn, right.firstChild);
    boardBtn.addEventListener('click', function () { SFX.unlock(); SFX.tap(); openBoard(); });
  }

  /* профиль в меню */
  var panel = $('#menuOv .panel'), best = $('#bestLine');
  if (panel) {
    mePill = mk('div', 'sx-me', '');
    mePill.id = 'sxMe';
    if (best && best.nextSibling) panel.insertBefore(mePill, best.nextSibling);
    else panel.appendChild(mePill);
  }

  /* обработчики ворот */
  var nameInput = $('#sxName'), go = $('#sxGo');
  nameInput.addEventListener('input', function () { S.available = false; renderGo(); scheduleCheck(); });
  nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (!go.disabled) go.click(); } });
  $('#sxCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (!go.disabled) go.click(); } });
  go.addEventListener('click', submitGate);
  $('#sxRecover').addEventListener('click', function () {
    SFX.unlock(); SFX.tap(); S.recover = !S.recover;
    $('#sxCodeRow').style.display = S.recover ? 'flex' : 'none';
    $('#sxRecover').textContent = S.recover ? '← Занять новое имя' : '🔑 У меня уже есть имя';
    $('#sxTitle').innerHTML = S.recover ? 'Вернуться<br>под своим именем' : 'Представься,<br>сотрудник';
    $('#sxLead').innerHTML = S.recover
      ? 'Введи <b>имя</b> и <b>код доступа</b>, который показали при регистрации. Результаты и место в рейтинге сохранятся.'
      : 'Руководитель ведёт <b>рейтинг побегов</b>. Займи имя — оно будет <b>только твоим</b>, а результат попадёт в общую таблицу. Имя запомнится на этом устройстве.';
    go.textContent = S.recover ? 'ВОЙТИ' : 'ЗАНИЯТЬ ИМЯ';
    $('#sxChips').innerHTML = '';
    setHint('', ''); renderGo();
    if (S.recover) $('#sxCode').focus(); else nameInput.focus();
  });
  $('#sxBoard2').addEventListener('click', function () { SFX.unlock(); SFX.tap(); openBoard(); });

  /* таблица */
  $('#sxClose').addEventListener('click', function () { SFX.tap(); closeBoard(); });
  $('#sxRefresh').addEventListener('click', function () { SFX.tap(); loadBoard(true); });
  board.addEventListener('click', function (e) { if (e.target === board) closeBoard(); });
  Array.prototype.forEach.call(board.querySelectorAll('.sx-tab'), function (t) {
    t.addEventListener('click', function () {
      SFX.tap(); S.tab = t.getAttribute('data-tab');
      Array.prototype.forEach.call(board.querySelectorAll('.sx-tab'), function (x) { x.classList.toggle('on', x === t); });
      renderBoard();
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && board.classList.contains('on')) closeBoard();
  });

  /* не пускаем в игру без имени */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.id === 'startBtn' && !S.user) { e.preventDefault(); e.stopPropagation(); openGate(); }
  }, true);
  document.addEventListener('keydown', function (e) {
    if (!S.user && document.body.dataset.state === 'menu' && (e.code === 'Enter' || e.code === 'Space')) {
      if (gate.classList.contains('on')) return;
      e.preventDefault(); e.stopPropagation(); openGate();
    }
  }, true);
}

/* ---------- тосты ---------- */
function toast(text, kind, ms) {
  var t = mk('div', 'sx-t ' + (kind || ''), text);
  toastBox.appendChild(t);
  while (toastBox.children.length > 3) toastBox.removeChild(toastBox.firstChild);
  setTimeout(function () { t.className += ' out'; setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320); }, ms || 2800);
}

/* ---------- ворота ---------- */
function setHint(text, kind) { var h = $('#sxHint'); h.textContent = text; h.className = 'sx-hint' + (kind ? ' ' + kind : ''); }
function setMark(html) { $('#sxMark').innerHTML = html || ''; }
function renderGo() {
  var n = cleanName($('#sxName').value), go = $('#sxGo');
  if (S.recover) { go.disabled = !(validName(n) && $('#sxCode').value.trim().length === 6) || S.busy; return; }
  go.disabled = !(validName(n) && S.available) || S.busy;
}
function scheduleCheck() {
  clearTimeout(S.checkTimer);
  var n = cleanName($('#sxName').value), inp = $('#sxName');
  $('#sxChips').innerHTML = '';
  inp.classList.remove('ok', 'bad');
  if (!n) { setMark(''); setHint('2–18 символов: буквы, цифры, пробел', ''); renderGo(); return; }
  if (!validName(n)) { setMark('⛔'); inp.classList.add('bad'); setHint('Только буквы и цифры, 2–18 символов', 'bad'); renderGo(); return; }
  setMark('<span class="sx-spin"></span>'); setHint('Проверяем, свободно ли…', '');
  S.checkTimer = setTimeout(function () { doCheck(n); }, 380);
}
function doCheck(n) {
  S.checkName = n;
  if (!S.online) {
    var b = localBoard(), taken = !!b.players[nameKey(n)];
    applyCheck(n, !taken, taken ? [n + ' 185', n + ' 2'] : [], true);
    return;
  }
  net('check', null, '&name=' + encodeURIComponent(n)).then(function (r) {
    if (S.checkName !== n) return;
    if (!r.ok) {
      S.online = false;
      var b = localBoard(), taken = !!b.players[nameKey(n)];
      applyCheck(n, !taken, taken ? [n + ' 185'] : [], true);
      return;
    }
    S.online = true;
    applyCheck(n, !!r.available, r.suggestions || [], false);
  });
}
function applyCheck(n, available, suggestions, local) {
  var inp = $('#sxName');
  S.available = available;
  inp.classList.remove('ok', 'bad');
  if (available) {
    inp.classList.add('ok'); setMark('✅');
    setHint(local ? 'Свободно locally — синхронизируем, когда сеть вернётся' : 'Имя свободно — забирай', local ? 'warn' : 'ok');
  } else {
    inp.classList.add('bad'); setMark('⛔');
    setHint('Имя уже занято. Попробуй одно из этих:', 'bad');
    var box = $('#sxChips'); box.innerHTML = '';
    (suggestions || []).slice(0, 3).forEach(function (s) {
      var c = mk('button', 'sx-chip', esc(s)); c.type = 'button';
      c.addEventListener('click', function () { SFX.tap(); $('#sxName').value = s; S.available = false; renderGo(); scheduleCheck(); });
      box.appendChild(c);
    });
  }
  renderGo();
}
function submitGate() {
  if (S.busy) return;
  var n = cleanName($('#sxName').value);
  if (!validName(n)) return;
  SFX.unlock();
  S.busy = true; renderGo();
  var go = $('#sxGo'), old = go.textContent; go.textContent = 'МИНУТУ…';

  var done = function (player, local) {
    S.user = { id: player.id, name: player.name, token: player.token, code: player.code, local: !!local };
    lss(LS_USER, S.user);
    S.busy = false; go.textContent = old;
    closeGate(); renderMe(); SFX.good();
    if (local) toast('Имя занято на этом устройстве. Синхронизируем при сети', 'warn', 3600);
    else if (S.recover) toast('С возвращением, ' + esc(player.name) + '!', 'ok');
    else toast('Имя <b>' + esc(player.name) + '</b> закреплено за тобой. Код: <span class="sx-code">' + esc(player.code) + '</span>', 'ok', 7000);
    queueFlush(); loadBoard(false);
  };

  if (S.recover) {
    var code = $('#sxCode').value.trim().toUpperCase();
    net('recover', { name: n, code: code }).then(function (r) {
      if (r.ok) { done(r.player, false); return; }
      S.busy = false; go.textContent = old; renderGo(); SFX.bad();
      if (r.code === 'offline') { setHint('Нет связи с рейтингом. Попробуй позже', 'warn'); return; }
      setHint(r.code === 'badcode' ? 'Код не подходит к этому имени' : 'Такого имени в рейтинге нет', 'bad');
    });
    return;
  }

  if (!S.online) { done({ id: 'local-' + rid(10), name: n, token: rid(16), code: rid(6).toUpperCase() }, true); return; }

  net('register', { name: n }).then(function (r) {
    if (r.ok) { done(r.player, false); return; }
    S.busy = false; go.textContent = old; SFX.bad();
    if (r.code === 'offline') { S.online = false; setHint('Сеть пропала — можно занять имя локально', 'warn'); S.available = true; renderGo(); return; }
    S.available = false; renderGo();
    applyCheck(n, false, r.suggestions || [n + ' 185'], false);
  });
}
function openGate() {
  if (S.user) return;
  S.gateOpen = true; gate.classList.add('on');
  setTimeout(function () { try { $('#sxName').focus(); } catch (e) {} }, 260);
}
function closeGate() { S.gateOpen = false; gate.classList.remove('on'); }

/* ---------- профиль ---------- */
function renderMe() {
  if (!mePill) return;
  if (!S.user) {
    mePill.innerHTML = '<div class="sx-mi"><div class="sx-mn">Имя не выбрано</div><div class="sx-ms">Займи имя, чтобы попасть в рейтинг</div></div>' +
      '<button class="sx-mb" id="sxJoin" type="button">Представиться</button>';
    var j = $('#sxJoin'); if (j) j.addEventListener('click', function () { SFX.unlock(); SFX.tap(); openGate(); });
    return;
  }
  var you = S.board && S.board.you;
  var sub = you && you.rank ? ('Место #' + you.rank + ' · ' + fmt(you.s) + ' ₽ · забегов ' + you.r)
    : (S.user.local ? 'Локальный профиль · код ' + S.user.code : 'Код доступа: ' + S.user.code);
  mePill.innerHTML =
    '<div class="sx-av">' + esc(initials(S.user.name)) + '</div>' +
    '<div class="sx-mi"><div class="sx-mn">' + esc(S.user.name) + '</div><div class="sx-ms">' + esc(sub) + '</div></div>' +
    '<button class="sx-mb" id="sxCopy" type="button">Код</button>' +
    '<button class="sx-mb" id="sxOut" type="button">Сменить</button>';
  $('#sxCopy').addEventListener('click', function () {
    SFX.tap();
    var txt = S.user.name + ' · код ' + S.user.code;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).catch(function () {});
    toast('Сохрани: <b>' + esc(S.user.name) + '</b> · код <span class="sx-code">' + esc(S.user.code) + '</span>', 'ok', 6000);
  });
  $('#sxOut').addEventListener('click', function () {
    SFX.tap();
    if (!confirm('Сменить имя? Рекорд останется в рейтинге под «' + S.user.name + '». Вернуться можно по коду ' + S.user.code + '.')) return;
    try { localStorage.removeItem(LS_USER); } catch (e) {}
    S.user = null; renderMe(); openGate();
  });
}

/* ---------- таблица ---------- */
function openBoard() { board.classList.add('on'); loadBoard(true); }
function closeBoard() { board.classList.remove('on'); }
function loadBoard(force) {
  if (S.busyBoard) return;
  S.busyBoard = true;
  $('#sxList').innerHTML = '<div class="sx-empty"><span class="sx-spin"></span><br><br>Собираем результаты по опенспейсу…</div>';
  var id = S.user && !S.user.local ? S.user.id : '';
  net('top', null, '&limit=60&id=' + encodeURIComponent(id)).then(function (r) {
    S.busyBoard = false;
    if (r.ok) { S.online = true; S.board = r; renderBoard(); renderMe(); return; }
    S.online = false;
    var b = localBoard();
    var list = Object.keys(b.players).map(function (k) { return b.players[k]; }).sort(function (a, c) { return c.s - a.s; });
    var mine = S.user ? b.players[nameKey(S.user.name)] : null;
    var rank = 0; if (mine) for (var i = 0; i < list.length; i++) if (list[i] === mine) rank = i + 1;
    S.board = {
      ok: true, local: true, total: list.length, runs: b.runs,
      players: list.slice(0, 60).map(function (p, i) { return { rank: i + 1, n: p.n, s: p.s, d: p.d, f: p.f, r: p.r, me: S.user && nameKey(p.n) === nameKey(S.user.name) }; }),
      you: mine ? { rank: rank, n: mine.n, s: mine.s, d: mine.d, f: mine.f, r: mine.r } : null
    };
    renderBoard(); renderMe();
  });
}
function renderBoard() {
  var b = S.board; if (!b) return;
  var you = b.you;
  $('#sxStats').innerHTML =
    '<div class="sx-stat"><span>СОТРУДНИКОВ</span><b>' + fmt(b.total || 0) + '</b></div>' +
    '<div class="sx-stat"><span>ЗАБЕГОВ</span><b>' + fmt(b.runs || 0) + '</b></div>' +
    '<div class="sx-stat me"><span>' + (you && you.rank ? 'ТВОЁ МЕСТО' : 'ТВОЙ РЕКОРД') + '</span><b>' +
      (you ? (you.rank ? '#' + you.rank : fmt(you.s) + ' ₽') : '—') + '</b></div>';

  var list = $('#sxList'), rows = [];
  if (S.tab === 'me') {
    if (!S.user) rows = [{ empty: 'Сначала займи имя — и результат появится здесь.' }];
    else if (!you || !you.r) rows = [{ empty: 'Забегов пока нет. Добеги до двери «ОТПУСК» — и попадёшь в таблицу.' }];
    else rows = [Object.assign({ rank: you.rank, me: true }, you)];
  } else {
    rows = (b.players || []).slice();
    if (!rows.length) rows = [{ empty: 'Рейтинг пуст. Будь первым, кто добежал до отпуска.' }];
  }
  list.innerHTML = '';
  rows.forEach(function (p) {
    if (p.empty) { list.appendChild(mk('div', 'sx-empty', esc(p.empty))); return; }
    var cls = 'sx-r' + (p.me ? ' me' : '') + (p.rank === 1 ? ' top1' : p.rank === 2 ? ' top2' : p.rank === 3 ? ' top3' : '');
    var medal = p.rank === 1 ? '🥇' : p.rank === 2 ? '🥈' : p.rank === 3 ? '🥉' : p.rank;
    var row = mk('div', cls,
      '<div class="sx-rk">' + medal + '</div>' +
      '<div><div class="sx-n">' + esc(p.n) + (p.me ? ' · ты' : '') + '</div>' +
      '<div class="sx-sub">' + fmt(p.d || 0) + ' м · ' + esc(p.f || '—') + ' · забегов ' + (p.r || 0) + '</div></div>' +
      '<div class="sx-sc">' + fmt(p.s || 0) + ' ₽</div>');
    list.appendChild(row);
  });
  $('#sxOff').innerHTML = b.local
    ? '<div class="sx-off">⚠️ Нет связи с общим рейтингом — показана таблица этого устройства. Результаты уйдут в общий зачёт автоматически, как только сеть вернётся.</div>'
    : '';
}

/* ---------- результаты забега ---------- */
function num(txt) { var m = String(txt || '').replace(/[^\d]/g, ''); return m ? parseInt(m, 10) : 0; }
function readRun(state) {
  var box = state === 'win' ? $('#statsWin') : $('#statsOver');
  if (!box) return null;
  var out = { score: 0, dist: 0, euros: 0, f2: 0, near: 0, time: 0, diff: 'МЕНЕДЖЕР', won: state === 'win' };
  Array.prototype.forEach.call(box.querySelectorAll('.st'), function (st) {
    var label = (st.querySelector('span') || {}).textContent || '';
    var val = (st.querySelector('b') || {}).textContent || '';
    if (/ДИСТАНЦИЯ/.test(label)) out.dist = num(val);
    else if (/ПРЕМИЯ/.test(label)) out.score = num(val);
    else if (/ЕВРО/.test(label)) out.euros = parseInt(val, 10) || 0;
    else if (/ВТОРОЙ ЭТАЖ/.test(label)) out.f2 = num(val);
    else if (/ЧИСТО/.test(label)) out.near = num(val);
    else if (/ВРЕМЯ/.test(label)) { var p = val.split(':'); out.time = (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
  });
  var chip = ($('#diffChip') || {}).textContent || '';
  out.diff = chip.replace(/[^\p{L}]/gu, '').toUpperCase() || 'МЕНЕДЖЕР';
  if (['СТАЖЁР', 'МЕНЕДЖЕР', 'ТИМЛИД'].indexOf(out.diff) < 0) out.diff = 'МЕНЕДЖЕР';
  return out;
}
function showResult(res, run) {
  var panel = res.local ? null : null;
  var host = document.body.dataset.state === 'win' ? $('#statsWin') : $('#statsOver');
  if (!host || !host.parentNode) return;
  var old = host.parentNode.querySelector('.sx-res'); if (old) old.parentNode.removeChild(old);
  var txt;
  if (res.local) txt = 'Результат записан на устройстве. <b>' + fmt(run.score) + ' ₽</b> уйдёт в общий зачёт при сети.';
  else if (res.improved) txt = 'Новый рекорд! <b>' + fmt(res.best) + ' ₽</b> · место <b>#' + res.rank + '</b> из ' + fmt(res.total) + '.';
  else txt = 'Забег засчитан. Рекорд прежний — <b>' + fmt(res.best) + ' ₽</b>, место <b>#' + res.rank + '</b>.';
  var card = mk('div', 'sx-res' + (res.improved ? ' up' : ''),
    '<div class="sx-rr">' + (res.rank ? '#' + res.rank : '🏁') + '</div><div class="sx-rt">' + txt + '</div>' +
    '<button class="sx-mb" type="button">🏆 Таблица</button>');
  host.parentNode.insertBefore(card, host.nextSibling);
  card.querySelector('button').addEventListener('click', function () { SFX.tap(); openBoard(); });
}
function finishRun(state) {
  var now = Date.now();
  if (now - S.lastRun < 2500) return;
  S.lastRun = now;
  var run = readRun(state);
  if (!run || run.dist < 3) return;
  if (!S.user) { openGate(); return; }
  if (S.user.local || !S.online) {
    var r = localSubmit(run); queuePush(run); showResult(r, run);
    if (r.improved) SFX.good();
    return;
  }
  net('submit', Object.assign({ id: S.user.id, token: S.user.token }, run)).then(function (r) {
    if (r.ok) { showResult(r, run); if (r.improved) SFX.good(); loadBoard(false); return; }
    if (r.code === 'offline') { S.online = false; var lr = localSubmit(run); queuePush(run); showResult(lr, run); return; }
    if (r.code === 'unknown' || r.code === 'auth') {
      try { localStorage.removeItem(LS_USER); } catch (e) {}
      S.user = null; renderMe();
      toast('Профиль не найден на сервере — займи имя заново', 'warn', 4200);
      return;
    }
    toast('Результат не принят сервером', 'warn');
  });
}

/* ---------- наблюдение за состоянием игры ---------- */
function watch() {
  var prev = document.body.dataset.state;
  var mo = new MutationObserver(function () {
    var st = document.body.dataset.state;
    if (st === prev) return;
    prev = st;
    if (st === 'playing') {
      Array.prototype.forEach.call(document.querySelectorAll('.sx-res'), function (e) { if (e.parentNode) e.parentNode.removeChild(e); });
      closeBoard();
    }
    if (st === 'over' || st === 'win') setTimeout(function () { finishRun(st); }, 260);
    if (st === 'menu') { renderMe(); if (!S.user) setTimeout(openGate, 320); }
  });
  mo.observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
}

/* ---------- старт ---------- */
function init() {
  buildUI(); renderMe(); watch();
  net('top', null, '&limit=1').then(function (r) {
    S.online = !!r.ok;
    if (S.online) { queueFlush(); loadBoard(false); }
    else if (S.user && !S.user.local) {
      /* профиль есть, сети нет — играем локально, отправим позже */
      S.online = false;
    }
    if (!S.user) setTimeout(openGate, 420);
  });
  window.addEventListener('online', function () { S.online = true; queueFlush(); loadBoard(false); });
  document.addEventListener('pointerdown', function () { SFX.unlock(); }, { once: true });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();