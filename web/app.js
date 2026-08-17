/* Связка: захват ПЧ -> воркер декодера -> воспроизведение голоса.
 *
 * Главный поток тут только раздаёт сообщения и рисует. Вся арифметика в воркере,
 * весь звук — в двух worklet-ах.
 */
import { initRadio } from './radio.js';

const $ = id => document.getElementById(id);

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
let gainL = null, gainR = null, master = null;
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

$('grant').onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia(CONSTRAINTS(null));
    s.getTracks().forEach(t => t.stop());
    const devs = (await navigator.mediaDevices.enumerateDevices())
      .filter(d => d.kind === 'audioinput');
    $('dev').innerHTML = devs
      .map(d => `<option value="${d.deviceId}">${d.label || d.deviceId}</option>`).join('');
    const guess = devs.findIndex(d => /burr|codec|usb audio/i.test(d.label));
    if (guess >= 0) $('dev').selectedIndex = guess;
    $('dev').disabled = false;
    $('start').disabled = false;
    $('status').textContent = 'Устройство выбрано. Радио должно быть в режиме USB AF/IF Output = IF.';
  } catch (err) {
    $('status').textContent = 'Доступ не получен: ' + err.message;
  }
};

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
  const merge = ctx.createChannelMerger(2);
  gainL = ctx.createGain(); gainR = ctx.createGain(); master = ctx.createGain();
  playback.connect(split);
  split.connect(gainL, 0); split.connect(gainR, 1);
  gainL.connect(merge, 0, 0); gainR.connect(merge, 0, 1);
  merge.connect(master); master.connect(ctx.destination);
  applySlot(); applyVolume();

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
  });

  statsTimer = setInterval(() => worker?.postMessage({ type: 'stats' }), 1000);
  setRunning(true);
}

$('start').onclick = async () => {
  try {
    await bringUp();
    stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS($('dev').value));
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
    $('status').textContent = 'Запуск декодера…';
  } catch (err) {
    log('ОШИБКА запуска: ' + err.message, 'bad');
    $('status').textContent = 'Ошибка: ' + err.message;
    stopAll();
  }
};

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
    $('status').textContent = 'Самопроверка идёт, звук должен пойти через несколько секунд.';
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

function applySlot () {
  if (!gainL) return;
  const v = document.querySelector('input[name=slot]:checked').value;
  gainL.gain.value = v === 'ts2' ? 0 : 1;
  gainR.gain.value = v === 'ts1' ? 0 : 1;
}
function applyVolume () { if (master) master.gain.value = +$('vol').value / 100; }

document.querySelectorAll('input[name=slot]').forEach(r => r.onchange = applySlot);
$('vol').oninput = applyVolume;
$('center').onchange = () => worker?.postMessage({ type: 'center', hz: +$('center').value });
const sendSquelch = () => {
  $('squelchVal').textContent = $('squelch').value + ' дБ';
  worker?.postMessage({ type: 'squelch', db: $('squelchOn').checked ? +$('squelch').value : null });
};
$('squelch').oninput = sendSquelch;
$('squelchOn').onchange = sendSquelch;

// CI-V независим от аудиотракта: декодер работает без CAT, CAT полезен без декодера
initRadio({ log });
