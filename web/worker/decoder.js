/* Воркер декодера: ПЧ на входе, голос и события на выходе.
 *
 *   отсчёты ПЧ -> IfDemodulator (наш DSP) -> кольцевой буфер WASM
 *                                         -> dsd-fme -> голос и лог
 *
 * Почему воркер, а не аудиопоток: декодер работает пачками и иногда засыпает
 * в ожидании данных (Asyncify), а срывать дедлайн AudioWorklet нельзя.
 * Запаса по скорости примерно пятикратный, так что задержки не копятся.
 *
 * Зависимости грузятся динамически, а не статическим import, по двум причинам:
 * ошибку загрузки статического импорта поймать нечем (воркер просто не
 * стартует с пустым сообщением), и к URL нужно уметь дописать версию, чтобы
 * обойти кеш браузера — см. NOTES.md про .mjs и text/plain.
 */
const V = new URL(self.location.href).searchParams.get('v');
const q = V ? `?v=${encodeURIComponent(V)}` : '';

let IfDemodulator = null, CarrierEstimator = null;
let IF_CENTER_HZ = 12060, SQUELCH_DB = -16, createDsdModule = null;

let mod = null;
let demod = null;
let carrier = null;               // оценщик фактической несущей
let lvlPeak = 0, lvlSum = 0, lvlCount = 0;
let scratch = 0, scratchSamples = 0;
let pending = null;          // хвост, не влезший в кольцевой буфер
let fedTotal = 0, droppedTotal = 0;

const post = (type, extra) => self.postMessage({ type, ...extra });

async function loadDeps () {
  try {
    const dsp = await import(`../dsp/iq-demod.js${q}`);
    ({ IfDemodulator, CarrierEstimator, IF_CENTER_HZ, SQUELCH_DB } = dsp);
  } catch (err) {
    post('fatal', { where: 'dsp/iq-demod.js', message: String(err?.message ?? err) });
    throw err;
  }
  try {
    createDsdModule = (await import(`../../native/build/dsd-fme-rb.mjs${q}`)).default;
  } catch (err) {
    post('fatal', { where: 'native/build/dsd-fme-rb.mjs', message: String(err?.message ?? err) });
    throw err;
  }
}

function ensureScratch (n) {
  if (n <= scratchSamples) return;
  if (scratch) mod._free(scratch);
  scratch = mod._malloc(n * 2);
  scratchSamples = n;
}

/** Отдать отсчёты в кольцевой буфер; вернуть непринятый остаток. */
function feed (pcm) {
  if (!mod || !pcm.length) return null;
  ensureScratch(pcm.length);
  // HEAP16 перечитываем каждый раз: при росте памяти прежнее представление отваливается
  mod.HEAP16.set(pcm, scratch >> 1);
  const wrote = mod._dsdw_rb_write(scratch, pcm.length);
  fedTotal += wrote;
  return wrote < pcm.length ? pcm.subarray(wrote) : null;
}

function noteOverrun (n) {
  droppedTotal += n;
  post('overrun', { dropped: droppedTotal });
}

self.onmessage = async e => {
  const d = e.data;

  if (d.type === 'start') {
    if (mod) return;
    try {
      await loadDeps();
      mod = await createDsdModule({
        noInitialRun: true,
        print:    t => post('log', { line: t }),
        printErr: t => post('log', { line: t }),
      });
    } catch (err) {
      post('fatal', { where: 'запуск модуля', message: String(err?.message ?? err) });
      return;
    }

    mod.onStreamOpen = (id, dir, rate, ch) => post('stream', { id, dir, rate, ch });
    mod.onAudio = (id, view) => {
      // копия обязательна: представление смотрит в кучу WASM и будет переиспользовано
      const pcm = Int16Array.from(view);
      self.postMessage({ type: 'pcm', id, pcm }, [pcm.buffer]);
    };

    demod = new IfDemodulator({
      sampleRate: d.sampleRate ?? 48000,
      center: d.center ?? IF_CENTER_HZ,
      squelchDb: d.squelchDb ?? SQUELCH_DB,
    });
    carrier = new CarrierEstimator({ sampleRate: d.sampleRate ?? 48000 });

    // Кольцевой буфер заранее не создаём — всё, записанное до callMain,
    // обнуляется при инициализации рантайма (NOTES.md).
    mod.callMain(['-fs', '-i', 'pulse', '-o', 'pulse']);
    post('ready');
    return;
  }

  if (d.type === 'center' && demod) { demod.setCenter(d.hz); return; }
  if (d.type === 'squelch' && demod) { demod.setSquelchDb(d.db); return; }

  if (d.type === 'iq') {
    if (!demod || !mod) return;

    /* Измерения по сырому входу — без них не отличить «слабый сигнал» от
       «не тот центр», а оба выглядят одинаково: синхронизация есть, пакеты
       не проходят FEC. */
    for (let k = 0; k < d.i.length; k++) {
      const a = d.i[k] < 0 ? -d.i[k] : d.i[k];
      if (a > lvlPeak) lvlPeak = a;
      lvlSum += d.i[k] * d.i[k];
    }
    lvlCount += d.i.length;
    carrier.push(d.i);
    if (carrier.ready) {
      const est = carrier.result();
      post('level', {
        peak: lvlPeak,
        rmsDb: 10 * Math.log10(lvlSum / Math.max(1, lvlCount) + 1e-30),
        carrierHz: est?.hz ?? null,
        snrDb: est?.snrDb ?? null,
      });
      lvlPeak = 0; lvlSum = 0; lvlCount = 0;
    }

    if (pending) {
      pending = feed(pending);
      if (pending) { noteOverrun(d.i.length); return; }
    }
    pending = feed(demod.process(d.i, d.stereo ? d.q : null));
    if (pending) noteOverrun(pending.length);
    return;
  }

  /* Уже демодулированный поток — для самопроверки на эталонной записи,
     минуя захват и DSP. Разделяет «сломан декодер» и «сломан захват». */
  if (d.type === 'feed-pcm') {
    if (!mod) return;
    if (pending) {
      pending = feed(pending);
      if (pending) { noteOverrun(d.pcm.length); return; }
    }
    pending = feed(d.pcm);
    if (pending) noteOverrun(pending.length);
    return;
  }

  if (d.type === 'stats') {
    post('stats', {
      fed: fedTotal,
      dropped: droppedTotal,
      buffered: mod ? mod._dsdw_rb_count() : 0,
      starveMs: mod ? mod._dsdw_rb_starve_ms() : 0,
    });
  }
};
