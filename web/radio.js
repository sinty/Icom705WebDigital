/* Управление IC-705 из браузера: CI-V по Web Serial, панорама, диапазоны.
 *
 * Живёт в главном потоке: поток данных CI-V мал (опрос состояния плюс четыре
 * кадра водопада в секунду), а Web Serial там доступен без оговорок.
 *
 * Отдельный модуль, потому что с аудиотрактом это никак не связано: декодер
 * работает и без CAT-соединения, а CAT полезен и без декодера.
 */
import { CivPort, BANDS, sUnits } from './civ/civ.js';
import { SpectrumAssembler, ScopeView, POINTS } from './civ/spectrum.js';
import { prefs } from './prefs.js';

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
  let scope = null;
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
  /* Панорама создаётся сразу при загрузке, не по подключению: рамка, сетка и
     шкала должны быть видны и без радио, иначе непонятно, работает ли вообще. */
  function createScope () {
    scope = new ScopeView($('waterfall'), { history: 260 });
    applyContrast();
    window.addEventListener('resize', () => scope?.resize());
  }

  function wireScope () {
    const cv = $('waterfall');
    assembler = new SpectrumAssembler(row => {
      scope.push(row);
      if (row.centerHz !== lastCenter || row.spanHz !== lastSpan) {
        lastCenter = row.centerHz; lastSpan = row.spanHz;
        if (row.centerHz != null && row.spanHz != null) {
          const stepKhz = row.spanHz / 1000 / 10;
          $('scopeInfo').textContent =
            `CENTER ${fmtHz(row.centerHz)} · обзор ${(row.spanHz / 1000).toFixed(0)} кГц · ` +
            `сетка ${stepKhz % 1 ? stepKhz.toFixed(1) : stepKhz}k/10dB`;
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

  // порядок важен: панорама должна существовать до того, как приедет первый кадр
  $('wfFloor').value = prefs.get('wfFloor', 20);
  $('wfCeil').value = prefs.get('wfCeil', 140);
  createScope();

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
  /** @param {SerialPort} [port] уже выданный порт; без него будет показан выбор */
  async function connect (port) {
    try {
      say(port ? 'Открываю запомненный CAT-порт…' : 'Выберите CAT-порт радио…');
      await civ.open(port ?? await civ.requestPort({ all: $('civAllPorts').checked }));
      civ.onError = err => log?.('CI-V: порт отвалился — ' + err.message, 'bad');

      const hz = await civ.readFrequency();
      if (hz == null) {
        say('Порт открыт, но радио не отвечает. Проверьте CI-V Address = A4h и скорость (Auto).');
        log?.('CI-V: ответа на запрос частоты нет. Если открыт wfview или WSJT-X — порт занят им.', 'warn');
        await civ.close();
        return false;
      }

      // запоминаем, какой именно порт подошёл — в следующий раз найдём сами
      const info = civ.port?.getInfo?.() ?? {};
      if (info.usbVendorId != null)
        prefs.set('civPort', { vid: info.usbVendorId, pid: info.usbProductId ?? null });

      $('civConnect').disabled = true;
      $('civDisconnect').disabled = false;
      $('civAllPorts').disabled = true;
      document.querySelectorAll('.needs-civ').forEach(el => { el.disabled = false; });

      wireScope();
      await refreshUsbOut();
      await civ.setScopeOutput(true);
      polling = true; pollLoop();
      say(`Радио на связи: ${fmtHz(hz)}`);
      return true;
    } catch (err) {
      // отказ пользователя от выбора порта — не ошибка
      say(err.name === 'NotFoundError'
        ? 'Порт не выбран. Если радио нет в списке — поставьте «показать все порты».'
        : 'CI-V: ' + err.message);
      return false;
    }
  }

  $('civConnect').onclick = () => connect();

  /** Подобрать среди уже выданных портов тот, что запомнен. */
  async function findRemembered () {
    const ports = await navigator.serial.getPorts();
    if (!ports.length) return null;
    const want = prefs.get('civPort');
    if (want) {
      const m = ports.find(p => {
        const i = p.getInfo?.() ?? {};
        return i.usbVendorId === want.vid && (want.pid == null || i.usbProductId === want.pid);
      });
      if (m) return m;
    }
    return ports.length === 1 ? ports[0] : null;
  }

  /* Порт, выданный однажды, возвращается getPorts() без жеста пользователя —
     поэтому со второго раза выбирать его уже не нужно. */
  (async function restorePort () {
    const port = await findRemembered();
    if (port) await connect(port);
    else say('Радио не подключено. Декодер работает и без этого.');
  })();

  /* Радио включили или воткнули позже — подхватываем, если оно уже разрешено. */
  navigator.serial.addEventListener('connect', async () => {
    if (civ.port) return;
    const port = await findRemembered();
    if (port) { log?.('Радио появилось на шине — подключаюсь.', 'dim'); await connect(port); }
  });

  navigator.serial.addEventListener('disconnect', () => {
    if (!civ.port) return;
    polling = false;
    log?.('Радио отключилось от USB.', 'warn');
    $('civDisconnect').click();
  });

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

  /* Контраст: сырые значения кадров идут 0..0xA0, а куда попадает шумовая полка,
     зависит от усиления и REF на радио. Поэтому границы отображения — руками. */
  function applyContrast (save = true) {
    const lo = +$('wfFloor').value, hi = +$('wfCeil').value;
    $('wfFloorVal').textContent = lo;
    $('wfCeilVal').textContent = hi;
    scope?.setRange(lo, hi);
    if (save) { prefs.set('wfFloor', lo); prefs.set('wfCeil', hi); }
  }
  $('wfFloor').oninput = () => applyContrast();
  $('wfCeil').oninput = () => applyContrast();

  $('scopeOn').onchange = async e => {
    await civ.setScopeOutput(e.target.checked);
    say(e.target.checked ? 'Панорама включена' : 'Панорама выключена');
  };

  window.addEventListener('beforeunload', () => { polling = false; civ.close(); });
}
