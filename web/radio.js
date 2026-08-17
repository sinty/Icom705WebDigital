/* Управление IC-705 из браузера: CI-V по Web Serial, панорама, диапазоны.
 *
 * Живёт в главном потоке: поток данных CI-V мал (опрос состояния плюс четыре
 * кадра водопада в секунду), а Web Serial там доступен без оговорок.
 *
 * Отдельный модуль, потому что с аудиотрактом это никак не связано: декодер
 * работает и без CAT-соединения, а CAT полезен и без декодера.
 */
import { CivPort, BANDS, sUnits } from './civ/civ.js';
import { SpectrumAssembler, WaterfallView, POINTS } from './civ/spectrum.js';

const $ = id => document.getElementById(id);

/** Шаг округления при перестройке кликом по панораме — сетка DMR 12.5 кГц. */
const TUNE_STEP_HZ = 12500;

/** Уровень USB IF Output при переключении в IF: выше 70 % клиппинг АЦП кодека. */
const IF_LEVEL_PCT = 60;

const POLL_MS = 300;
const fmtHz = hz => (hz / 1e6).toFixed(6).replace(/(\d)(?=(\d{3})+\.)/g, '$1 ') + ' МГц';

export function initRadio ({ log }) {
  const civ = new CivPort();
  let polling = false;
  let waterfall = null;
  let assembler = null;
  let lastCenter = null, lastSpan = null;

  const say = (t, cls) => { $('civStatus').textContent = t; if (cls) log?.(t, cls); };

  if (!CivPort.supported) {
    say('Web Serial недоступен: нужен Chrome или Edge на настольной системе.');
    $('civConnect').disabled = true;
    return;
  }

  /* ---------- кнопки диапазонов ---------- */
  $('bands').innerHTML = BANDS
    .map(b => `<button class="sec band" data-band="${b.code}">${b.name}</button>`).join('');
  $('bands').onclick = async e => {
    const code = e.target?.dataset?.band;
    if (!code || !civ.port) return;
    const st = await civ.readBandStack(+code);
    if (!st) { say('Диапазон: радио не ответило'); return; }
    await civ.setFrequency(st.hz);
    if (st.mode) await civ.setMode(st.mode);
    say(`Диапазон ${e.target.textContent}: ${fmtHz(st.hz)} ${st.mode}`);
  };

  /* ---------- панорама ---------- */
  function setupWaterfall () {
    const cv = $('waterfall');
    waterfall = new WaterfallView(cv, { history: 240 });
    waterfall.clear();
    assembler = new SpectrumAssembler(row => {
      waterfall.push(row.data);
      if (row.centerHz !== lastCenter || row.spanHz !== lastSpan) {
        lastCenter = row.centerHz; lastSpan = row.spanHz;
        if (row.centerHz != null && row.spanHz != null) {
          $('spanLo').textContent = fmtHz(row.centerHz - row.spanHz / 2);
          $('spanHi').textContent = fmtHz(row.centerHz + row.spanHz / 2);
          $('spanMid').textContent = fmtHz(row.centerHz);
        }
      }
    });
    civ.onScope(body => assembler.feed(body));

    // перестройка кликом: округляем до сетки, иначе попасть в канал нереально
    cv.onclick = async ev => {
      if (!assembler || !civ.port) return;
      const r = cv.getBoundingClientRect();
      const idx = Math.round((ev.clientX - r.left) / r.width * (POINTS - 1));
      const hz = assembler.freqAt(idx);
      if (hz == null) { say('Панорама ещё не пришла — не знаю границ обзора'); return; }
      const snapped = Math.round(hz / TUNE_STEP_HZ) * TUNE_STEP_HZ;
      await civ.setFrequency(snapped);
      say(`Перестройка кликом: ${fmtHz(snapped)}`);
    };
  }

  /* ---------- опрос состояния ---------- */
  async function pollLoop () {
    while (polling) {
      try {
        const hz = await civ.readFrequency();
        if (hz != null) $('freq').textContent = fmtHz(hz);

        const mode = await civ.readMode();
        if (mode) $('mode').textContent = mode;

        const raw = await civ.readSMeterRaw();
        if (raw != null) {
          $('smeterText').textContent = sUnits(raw);
          $('smeterBar').style.width = Math.min(100, raw / 255 * 100).toFixed(1) + '%';
        }
      } catch (err) {
        log?.('CI-V: опрос прервался — ' + err.message, 'bad');
        polling = false;
        break;
      }
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  }

  /** Индикатор режима вывода USB: в AF декодер работать не может. */
  async function refreshUsbOut () {
    const v = await civ.readUsbOutputSelect();
    const el = $('usbOut');
    if (!v) { el.textContent = '?'; el.className = 'dim'; return; }
    el.textContent = v;
    el.className = v === 'IF' ? 'ok' : 'bad';
    if (v !== 'IF')
      log?.('Радио отдаёт по USB звук (AF), а декодеру нужен IF. Нажмите «IF (декодер)».', 'warn');
  }

  /* ---------- соединение ---------- */
  $('civConnect').onclick = async () => {
    try {
      say('Выберите CAT-порт радио…');
      await civ.open(await civ.requestPort({ all: $('civAllPorts').checked }));
      civ.onError = err => log?.('CI-V: порт отвалился — ' + err.message, 'bad');

      const hz = await civ.readFrequency();
      if (hz == null) {
        say('Порт открыт, но радио не отвечает. Проверьте CI-V Address = A4h и скорость (Auto).');
        log?.('CI-V: ответа на запрос частоты нет. Если открыт wfview или WSJT-X — порт занят им.', 'warn');
        await civ.close();
        return;
      }

      $('civConnect').disabled = true;
      $('civDisconnect').disabled = false;
      $('civAllPorts').disabled = true;
      document.querySelectorAll('.needs-civ').forEach(el => { el.disabled = false; });

      setupWaterfall();
      await refreshUsbOut();
      await civ.setScopeOutput(true);
      polling = true; pollLoop();
      say(`Радио на связи: ${fmtHz(hz)}`);
    } catch (err) {
      // отказ пользователя от выбора порта — не ошибка
      say(err.name === 'NotFoundError'
        ? 'Порт не выбран. Если радио нет в списке — поставьте «показать все порты».'
        : 'CI-V: ' + err.message);
    }
  };

  $('civDisconnect').onclick = async () => {
    polling = false;
    await civ.close();
    $('civConnect').disabled = false;
    $('civDisconnect').disabled = true;
    $('civAllPorts').disabled = false;
    document.querySelectorAll('.needs-civ').forEach(el => { el.disabled = true; });
    waterfall?.clear();
    say('CAT-соединение закрыто.');
  };

  /* ---------- переключение вывода USB ---------- */
  $('ifMode').onclick = async () => {
    // уровень ставим до переключения: так вход декодера не увидит перегруза
    await civ.setUsbIfLevel(IF_LEVEL_PCT);
    await civ.setUsbOutputSelect('IF');
    await refreshUsbOut();
    say(`USB-вывод: IF, уровень ${IF_LEVEL_PCT} %`);
  };

  $('afMode').onclick = async () => {
    await civ.setUsbOutputSelect('AF');
    await refreshUsbOut();
    say('USB-вывод: AF — декодер работать не будет, это режим для обычного звука.');
  };

  $('scopeOn').onchange = async e => {
    await civ.setScopeOutput(e.target.checked);
    say(e.target.checked ? 'Панорама включена' : 'Панорама выключена');
  };

  window.addEventListener('beforeunload', () => { polling = false; civ.close(); });
}
