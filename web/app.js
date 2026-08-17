/* Связка: захват ПЧ -> воркер декодера -> воспроизведение голоса.
 *
 * Главный поток тут только раздаёт сообщения и рисует. Вся арифметика в воркере,
 * весь звук — в двух worklet-ах.
 */
import { initRadio } from './radio.js';
import { prefs, micGranted } from './prefs.js';

const $ = id => document.getElementById(id);

/** По этому в метке узнаётся USB-кодек IC-705: внутри стоит кодек Burr-Brown (TI). */
const AUDIO_HINT = /burr|codec|usb audio/i;

const CONSTRAINTS = dev => ({
  audio: {
    deviceId: dev ? { exact: dev } : undefined,
    channelCount: 2,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  video: false,
});

let ctx = null, stream = null, worker = null, playback = null, capture = null;
let gainL = null, gainR = null, master = null, merge = null;
let fxHp = null, fxShelf = null, fxLp = null;
let statsTimer = null, selfTestTimer = null;
let logCount = 0;

function log (line, cls) {
  const pane = $('log');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = line;
  pane.appendChild(div);
  if (++logCount > 400) { pane.removeChild(pane.firstChild); logCount--; }
  pane.scrollTop = pane.scrollHeight;
}

/* Ошибки обязаны быть видны. Первый заход на железе провалился ровно потому,
   что модуль воркера не загрузился, а сообщить об этом было некому. */
addEventListener('error', e => log('ОШИБКА: ' + (e.message || e), 'bad'));
addEventListener('unhandledrejection', e => log('ОШИБКА: ' + (e.reason?.message || e.reason), 'bad'));

function setRunning (on) {
  $('start').disabled = on;
  $('selftest').disabled = on;
  $('stop').disabled = !on;
  $('dev').disabled = on;
}

/* ---------- выбор звукового устройства ---------- */

/** Заполнить список входов и выбрать запомненный (или похожий по метке). */
async function fillDevices () {
  const devs = (await navigator.mediaDevices.enumerateDevices())
    .filter(d => d.kind === 'audioinput' && d.deviceId);
  if (!devs.length) return null;

  $('dev').innerHTML = devs
    .map(d => `<option value="${d.deviceId}">${d.label || d.deviceId}</option>`).join('');

  const wantId = prefs.get('audioDeviceId');
  const wantLabel = prefs.get('audioDeviceLabel');
  // deviceId стабилен, пока не сброшены данные сайта; если не совпал — ищем по метке
  let pick = devs.findIndex(d => d.deviceId === wantId);
  if (pick < 0 && wantLabel) pick = devs.findIndex(d => d.label === wantLabel);
  if (pick < 0) pick = devs.findIndex(d => AUDIO_HINT.test(d.label));
  if (pick < 0) pick = 0;

  $('dev').selectedIndex = pick;
  $('dev').disabled = false;
  $('start').disabled = false;
  return devs[pick];
}

function rememberDevice () {
  const sel = $('dev').selectedOptions[0];
  if (!sel) return;
  prefs.set('audioDeviceId', sel.value);
  prefs.set('audioDeviceLabel', sel.textContent);
}

$('dev').onchange = rememberDevice;

$('grant').onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia(CONSTRAINTS(null));
    s.getTracks().forEach(t => t.stop());
    const d = await fillDevices();
    rememberDevice();
    $('status').textContent = d
      ? `Устройство: ${d.label}. Радио должно быть в режиме USB AF/IF Output = IF.`
      : 'Входов не найдено.';
  } catch (err) {
    $('status').textContent = 'Доступ не получен: ' + err.message;
  }
};

/* ---------- запуск ---------- */

/** Общая часть обоих режимов: контекст, воспроизведение, воркер. */
async function bringUp () {
  logCount = 0; $('log').innerHTML = '';
  $('dropped').textContent = '0';

  ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
  await ctx.audioWorklet.addModule('./worklet/capture.js');
  await ctx.audioWorklet.addModule('./worklet/playback.js');

  // тракт воспроизведения: слоты DMR разведены по каналам (TS1 слева, TS2 справа)
  playback = new AudioWorkletNode(ctx, 'playback', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: { srcRate: 8000 },
  });
  const split = ctx.createChannelSplitter(2);
  merge = ctx.createChannelMerger(2);
  gainL = ctx.createGain(); gainR = ctx.createGain(); master = ctx.createGain();
  playback.connect(split);
  split.connect(gainL, 0); split.connect(gainR, 1);
  gainL.connect(merge, 0, 0); gainR.connect(merge, 0, 1);

  /* Фильтр-цепочка вывода — та же, что на Pi (deploy/speaker-fx.conf):
     срез инфранизких (гул и «плюхи» сквелча), мягкий завал верхов вместо
     деэмфазиса, срез шипения выше полосы голоса. Побочная польза: пересчёт
     8 → 48 кГц у нас линейный, и его зеркала лежат выше 4.4 кГц — ФНЧ 3.6 кГц
     их же и убирает. */
  fxHp = ctx.createBiquadFilter();
  fxHp.type = 'highpass'; fxHp.frequency.value = 270; fxHp.Q.value = 0.707;
  fxShelf = ctx.createBiquadFilter();
  fxShelf.type = 'highshelf'; fxShelf.frequency.value = 1800; fxShelf.gain.value = -5;
  fxLp = ctx.createBiquadFilter();
  fxLp.type = 'lowpass'; fxLp.frequency.value = 3600; fxLp.Q.value = 0.707;

  master.connect(ctx.destination);
  applyFx(); applySlot(); applyVolume();

  // Версия в URL пробивает кеш браузера: он мог запомнить модули с прежним,
  // неверным типом содержимого, и тогда они не исполняются молча.
  worker = new Worker(`./worker/decoder.js?v=${Date.now()}`, { type: 'module' });
  worker.onerror = e => {
    log(`ОШИБКА воркера: ${e.message || 'модуль не загрузился и не сообщил причину'}` +
        `${e.filename ? ` (${e.filename}:${e.lineno})` : ''}`, 'bad');
    log('Если причина не названа — откройте консоль DevTools (F12), там будет точная строка.', 'dim');
    $('status').textContent = 'Воркер декодера не запустился — смотрите лог.';
  };
  worker.onmessageerror = () => log('ОШИБКА: не удалось разобрать сообщение воркера', 'bad');

  worker.onmessage = e => {
    const d = e.data;
    switch (d.type) {
      case 'ready':   $('status').textContent = 'Декодер запущен.'; break;
      case 'fatal':
        log(`ОШИБКА в воркере (${d.where}): ${d.message}`, 'bad');
        $('status').textContent = 'Декодер не запустился — смотрите лог.';
        break;
      case 'log':     if (d.line.trim()) log(d.line); break;
      case 'stream':  if (d.dir !== 2) log(`выход декодера: ${d.rate} Гц, ${d.ch} кан`, 'dim'); break;
      case 'pcm':     playback.port.postMessage({ type: 'pcm', pcm: d.pcm, channels: 2 }, [d.pcm.buffer]); break;
      case 'level':   showLevel(d); break;
      case 'overrun': $('dropped').textContent = d.dropped; break;
      case 'stats':
        $('buffered').textContent = (d.buffered / 48000).toFixed(2) + ' с';
        $('starve').textContent = (d.starveMs / 1000).toFixed(1) + ' с';
        break;
    }
  };

  worker.postMessage({
    type: 'start',
    sampleRate: ctx.sampleRate,
    center: +$('center').value || 12060,
    squelchDb: $('squelchOn').checked ? +$('squelch').value : null,
    // -u задаётся только при запуске: dsd-fme читает его из аргументов
    uvquality: +$('uvq').value || 3,
  });

  statsTimer = setInterval(() => worker?.postMessage({ type: 'stats' }), 1000);
  setRunning(true);
  ensureAudible();
}

/* Политика автозапуска звука: без жеста пользователя AudioContext стартует
   в состоянии suspended, а тогда не работают и AudioWorklet-ы — то есть встанет
   не только воспроизведение, но и захват. Поэтому один щелчок всё равно нужен;
   всё остальное можно не спрашивать. */
function ensureAudible () {
  if (!ctx || ctx.state !== 'suspended') return;
  $('status').textContent = 'Браузер не разрешает звук без действия — щёлкните по странице.';
  log('Звук ждёт первого щелчка по странице: таково правило автозапуска в Chrome.', 'warn');
  const resume = async () => {
    await ctx?.resume();
    if (ctx?.state === 'running') $('status').textContent = 'Декодер запущен.';
  };
  addEventListener('pointerdown', resume, { once: true });
  addEventListener('keydown', resume, { once: true });
}

$('start').onclick = () => startCapture();

async function startCapture () {
  try {
    await bringUp();
    stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS($('dev').value));
    // запоминаем то, что реально открылось, а не то, что было выбрано в списке
    const st = stream.getAudioTracks()[0];
    if (st?.getSettings().deviceId) prefs.set('audioDeviceId', st.getSettings().deviceId);
    if (st?.label) prefs.set('audioDeviceLabel', st.label);

    const src = ctx.createMediaStreamSource(stream);
    capture = new AudioWorkletNode(ctx, 'capture', {
      numberOfInputs: 1, numberOfOutputs: 0,
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete',
    });
    src.connect(capture);

    capture.port.onmessage = e => {
      const d = e.data;
      if (d.type === 'channels') {
        $('channels').textContent = d.channels;
        $('channels').className = d.channels === 2 ? 'ok' : 'warn';
        if (d.channels < 2)
          log('Пришёл один канал. Декодированию не мешает, но два дают меньше ошибок — ' +
              'формат устройства в Windows: mmsys.cpl → Запись → Дополнительно → 2 канала.', 'warn');
      } else if (d.type === 'iq' && worker) {
        worker.postMessage({ type: 'iq', i: d.i, q: d.q, stereo: d.stereo },
                           [d.i.buffer, d.q.buffer]);
      }
    };
  } catch (err) {
    log('ОШИБКА запуска: ' + err.message, 'bad');
    $('status').textContent = 'Ошибка: ' + err.message;
    stopAll();
  }
}

/* Самопроверка: эталонная запись вместо радио, подаётся уже демодулированной
   в темпе реального времени. Если тут лог идёт и голос слышен, а с радио нет —
   виноват захват, а не декодер. */
$('selftest').onclick = async () => {
  try {
    await bringUp();
    $('status').textContent = 'Самопроверка: загружаю эталон…';
    const buf = await (await fetch('../ref/demod_stereo.wav')).arrayBuffer();
    const pcm = parseWav(buf);
    log(`самопроверка: ${pcm.length} отсч., ${(pcm.length / 48000).toFixed(1)} с`, 'dim');
    $('channels').textContent = 'эталон';
    $('channels').className = 'dim';

    let off = 0;
    const STEP = 4800;                       // 100 мс за тик
    selfTestTimer = setInterval(() => {
      if (off >= pcm.length) {
        clearInterval(selfTestTimer); selfTestTimer = null;
        $('status').textContent = 'Самопроверка: запись подана целиком.';
        return;
      }
      const chunk = pcm.slice(off, off + STEP);
      off += STEP;
      worker.postMessage({ type: 'feed-pcm', pcm: chunk }, [chunk.buffer]);
    }, 100);
  } catch (err) {
    log('ОШИБКА самопроверки: ' + err.message, 'bad');
    stopAll();
  }
};

/** Минимальный разбор WAV: нужен ровно s16, ничего лишнего. */
function parseWav (buf) {
  const dv = new DataView(buf);
  const tag = o => String.fromCharCode(dv.getUint8(o), dv.getUint8(o+1), dv.getUint8(o+2), dv.getUint8(o+3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('не WAV');
  let p = 12;
  while (p + 8 <= dv.byteLength) {
    const id = tag(p), sz = dv.getUint32(p + 4, true);
    if (id === 'data') {
      const n = Math.min(sz, dv.byteLength - p - 8) >> 1;
      const s = new Int16Array(n);
      for (let i = 0; i < n; i++) s[i] = dv.getInt16(p + 8 + i * 2, true);
      return s;
    }
    p += 8 + sz + (sz & 1);
  }
  throw new Error('нет чанка data');
}

function stopAll () {
  clearInterval(statsTimer); statsTimer = null;
  clearInterval(selfTestTimer); selfTestTimer = null;
  worker?.terminate(); worker = null;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  ctx?.close(); ctx = null;
  capture = playback = null;
  setRunning(false);
}

$('stop').onclick = () => { stopAll(); $('status').textContent = 'Остановлено.'; };

/* Показ измерений по сырому входу. Ориентиры взяты с эталонной записи, на
   которой декодирование заведомо работает: пик 0.377, несущая около 12.1 кГц. */
let measuredCarrier = null;

function showLevel (d) {
  const pk = d.peak ?? 0;
  $('lvlPeak').textContent = pk.toFixed(3) + '  (' + d.rmsDb.toFixed(0) + ' дБ)';
  $('lvlBar').style.width = Math.min(100, pk * 100).toFixed(0) + '%';
  // ниже 0.05 сигнала почти нет, выше 0.95 клиппинг АЦП кодека
  $('lvlPeak').className = pk < 0.05 ? 'bad' : (pk < 0.12 || pk > 0.95) ? 'warn' : 'ok';

  measuredCarrier = d.carrierHz;
  if (d.carrierHz == null) {
    $('carrier').textContent = 'нет несущей';
    $('carrier').className = 'dim';
    $('carrierHint').textContent = pk < 0.05
      ? 'Уровень почти нулевой: проверьте режим IF и IF Output Level на радио.'
      : 'В полосе 8–16 кГц нет выраженного пика — вероятно, нет передачи.';
    return;
  }

  /* Только показываем. Применять эту оценку как центр — плохая идея: у 4FSK
     центр тяжести спектра не совпадает с точкой, по которой демодулятору
     выгоднее работать, и подстановка делала звук хуже, а не лучше.
     Проверенные 12060 Гц остаются компромиссом по умолчанию. */
  const off = d.carrierHz - (+$('center').value || 12060);
  $('carrier').textContent = `${d.carrierHz.toFixed(0)} Гц (${d.snrDb.toFixed(0)} дБ)`;
  $('carrier').className = Math.abs(off) < 600 ? 'ok' : 'warn';
  $('carrierHint').textContent =
    `Отклонение от центра ${off > 0 ? '+' : ''}${off.toFixed(0)} Гц. ` +
    'Показано для справки — центр менять вручную и только если станет лучше на слух.';
}

function applySlot () {
  if (!gainL) return;
  const v = document.querySelector('input[name=slot]:checked').value;
  gainL.gain.value = v === 'ts2' ? 0 : 1;
  gainR.gain.value = v === 'ts1' ? 0 : 1;
}
function applyVolume () { if (master) master.gain.value = +$('vol').value / 100; }

/** Включение и обход фильтр-цепочки: слушать разницу проще, чем рассуждать о ней. */
function applyFx () {
  if (!merge || !master) return;
  for (const n of [merge, fxHp, fxShelf, fxLp]) { try { n.disconnect(); } catch {} }
  if ($('fxOn').checked) {
    merge.connect(fxHp); fxHp.connect(fxShelf); fxShelf.connect(fxLp); fxLp.connect(master);
  } else {
    merge.connect(master);
  }
  prefs.set('fxOn', $('fxOn').checked);
}
$('fxOn').onchange = applyFx;
$('uvq').onchange = () => {
  prefs.set('uvq', +$('uvq').value);
  if (worker) log('Качество невокализованных участков применится при следующем запуске.', 'warn');
};

document.querySelectorAll('input[name=slot]').forEach(r => r.onchange = applySlot);
$('vol').oninput = () => { applyVolume(); prefs.set('volume', +$('vol').value); };
// центр и сквелч не сохраняются: см. пояснение в restore()
$('center').onchange = () => worker?.postMessage({ type: 'center', hz: +$('center').value });
const sendSquelch = () => {
  $('squelchVal').textContent = $('squelch').value + ' дБ';
  worker?.postMessage({ type: 'squelch', db: $('squelchOn').checked ? +$('squelch').value : null });
};
$('squelch').oninput = sendSquelch;
$('squelchOn').onchange = sendSquelch;

$('autoStart').onchange = () => prefs.set('autoStart', $('autoStart').checked);

/* ---------- восстановление при загрузке ---------- */

(async function restore () {
  $('vol').value = prefs.get('volume', 80);
  $('autoStart').checked = prefs.get('autoStart', false);
  $('fxOn').checked = prefs.get('fxOn', true);
  $('uvq').value = String(prefs.get('uvq', 3));

  /* Параметры тракта НЕ запоминаются намеренно.
     Раньше они сохранялись, и это оказалось ловушкой: стоило один раз
     подвинуть сквелч или принять измеренную несущую как центр — и значение
     молча применялось при каждой следующей загрузке. На слух это ошибки
     вокодера («подквакивание»), а причину не видно.
     Теперь каждый запуск начинается с проверенных 12060 Гц и −16 дБ. */
  prefs.del('centerHz');
  prefs.del('squelchDb');
  prefs.del('squelchOn');
  $('center').value = 12060;
  $('squelch').value = -16;
  $('squelchOn').checked = true;
  $('squelchVal').textContent = '-16 дБ';

  if (!await micGranted()) {
    $('status').textContent = 'Начните с разрешения доступа к звуку — дальше выбор запомнится.';
    return;
  }
  // разрешение сохранилось с прошлого раза: метки и deviceId доступны без запроса
  const d = await fillDevices();
  if (!d) { $('status').textContent = 'Звуковых входов не найдено.'; return; }
  $('status').textContent = `Устройство запомнено: ${d.label}.`;

  if ($('autoStart').checked) {
    log(`автозапуск: ${d.label}`, 'dim');
    startCapture();
  }
})();

// CI-V независим от аудиотракта: декодер работает без CAT, CAT полезен без декодера
initRadio({ log });
