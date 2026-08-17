/* CI-V для IC-705 поверх Web Serial.
 *
 * Порт один на всех, поэтому устроено так же, как в соседнем проекте (civ.py):
 * единственный цикл чтения разбирает поток байт на кадры FE FE ... FD и разводит
 * их по адресу — ответы на наши запросы в очередь ожидающих транзакций,
 * несолиситные кадры водопада (27 00, радио шлёт их само, ~4 раза в секунду)
 * в отдельный колбэк. Иначе водопад и опрос состояния сталкиваются на шине
 * и путают ответы.
 *
 * Ответ сверяется с эхом команды: протухший ответ на предыдущий запрос,
 * отвалившийся по таймауту, отбрасывается, а не выдаётся за свой.
 *
 * Числа команд и пунктов меню взяты из отлаженной реализации соседнего проекта
 * и справочника CI-V IC-705.
 */

/* VID, под которыми встречается CAT-порт IC-705. Icom — свой, Silicon Labs —
 * потому что внутри стоит мост CP210x и на части систем порт перечисляется им.
 * В civ.py соседнего проекта VID Icom был приоритетом, а не условием отбора,
 * и опрашивались все USB-порты — повторяем эту осторожность: фильтр можно снять. */
export const VENDOR_IDS = [0x0c26, 0x10c4];
export const ICOM_VID = 0x0c26;

export const MODES = {
  0: 'LSB', 1: 'USB', 2: 'AM', 3: 'CW', 4: 'RTTY',
  5: 'FM', 6: 'WFM', 7: 'CW-R', 8: 'RTTY-R', 23: 'DV',
};
const MODE_BY_NAME = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [v, +k]));

/* Коды диапазонов band-stacking IC-705 (сняты опросом на живом радио) */
export const BANDS = [
  { code: 1, name: '160м' }, { code: 2, name: '80м' }, { code: 3, name: '40м' },
  { code: 4, name: '30м' }, { code: 5, name: '20м' }, { code: 6, name: '17м' },
  { code: 7, name: '15м' }, { code: 8, name: '12м' }, { code: 9, name: '10м' },
  { code: 10, name: '6м' }, { code: 11, name: 'WFM' }, { code: 12, name: 'AIR' },
  { code: 13, name: '2м' }, { code: 14, name: '70см' },
];

const bcd2 = n => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
const fromBcd = b => (b >> 4) * 10 + (b & 0x0f);
const hex2 = b => b.toString(16).padStart(2, '0');

/** 5 байт BCD little-endian -> Гц */
export function bcdToFreq (bytes) {
  let s = '';
  for (let i = bytes.length - 1; i >= 0; i--) s += hex2(bytes[i]);
  return parseInt(s, 10);
}

/** Гц -> 5 байт BCD little-endian */
export function freqToBcd (hz) {
  const d = String(Math.round(hz)).padStart(10, '0');
  const out = new Uint8Array(5);
  for (let i = 0; i < 5; i++) out[i] = parseInt(d.slice(8 - i * 2, 10 - i * 2), 16);
  return out;
}

/** Сырое значение S-метра -> строка. Калибровка Icom: raw 120 = S9. */
export function sUnits (raw, { s9 = 120, perUnit = 13.3 } = {}) {
  if (raw == null || raw < 0) return '?';
  if (raw <= s9) return 'S' + Math.max(0, Math.round(raw / perUnit));
  return 'S9+' + Math.round((raw - s9) / 2) + 'dB';
}

export class CivPort {
  constructor ({ radioAddr = 0xa4, ctrlAddr = 0xe0, baudRate = 115200 } = {}) {
    this.radio = radioAddr;
    this.ctrl = ctrlAddr;
    this.baudRate = baudRate;

    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buf = new Uint8Array(0);

    this.pending = null;          // ожидающая транзакция {cmd, resolve, timer}
    this.queue = Promise.resolve(); // сериализация запросов: по одному за раз
    this.scopeCb = null;
    this.onError = null;
  }

  static get supported () { return 'serial' in navigator; }

  /** Выбор порта пользователем — обязателен жест, поэтому только из обработчика.
   *  all=true снимает фильтр по VID: если радио перечислилось не как ожидается,
   *  без этого его просто не будет видно в списке. */
  async requestPort ({ all = false } = {}) {
    if (!CivPort.supported) throw new Error('Web Serial не поддерживается (нужен Chrome или Edge)');
    const filters = VENDOR_IDS.map(usbVendorId => ({ usbVendorId }));
    return navigator.serial.requestPort(all ? {} : { filters });
  }

  async open (port) {
    this.port = port ?? await this.requestPort();
    await this.port.open({ baudRate: this.baudRate });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this._readLoop();                            // намеренно без await
  }

  async close () {
    try { await this.setScopeOutput(false); } catch { /* порт мог уже уйти */ }
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
    this.port = this.reader = this.writer = null;
  }

  onScope (cb) { this.scopeCb = cb; }

  /* ---------- цикл чтения и разбор кадров ---------- */

  async _readLoop () {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value?.length) continue;
        const merged = new Uint8Array(this.buf.length + value.length);
        merged.set(this.buf); merged.set(value, this.buf.length);
        this.buf = merged;
        this._drain();
      }
    } catch (err) {
      this.onError?.(err);
    }
  }

  _drain () {
    for (;;) {
      // ищем начало кадра
      let i = -1;
      for (let k = 0; k + 1 < this.buf.length; k++)
        if (this.buf[k] === 0xfe && this.buf[k + 1] === 0xfe) { i = k; break; }
      if (i < 0) {
        // Начала нет. Последний байт сохраняем: если это FE, а следующий чанк
        // начнётся с FE, иначе потеряем кадр на стыке. Заодно страхуемся от
        // разрастания буфера, если в порт течёт мусор.
        const tail = this.buf.length && this.buf[this.buf.length - 1] === 0xfe ? 1 : 0;
        this.buf = this.buf.length > 8192 || !tail
          ? new Uint8Array(tail ? [0xfe] : 0)
          : this.buf.subarray(this.buf.length - 1);
        return;
      }
      if (i > 0) this.buf = this.buf.subarray(i);

      const j = this.buf.indexOf(0xfd, 2);
      if (j < 0) return;                          // кадр ещё не пришёл целиком

      const frame = this.buf.subarray(2, j);
      this.buf = this.buf.subarray(j + 1);

      // нас интересуют только кадры «от радио к нам»
      if (frame.length >= 2 && frame[0] === this.ctrl && frame[1] === this.radio) {
        const body = frame.subarray(2);
        if (body.length >= 2 && body[0] === 0x27 && body[1] === 0x00) {
          this.scopeCb?.(body.subarray(2));       // водопад — мимо очереди ответов
        } else {
          this._deliver(body);
        }
      }
    }
  }

  _deliver (body) {
    const p = this.pending;
    if (!p) return;
    // одиночный ACK/NAK на set-команду, либо ответ с эхом нашей команды
    const isAck = body.length === 1 && (body[0] === 0xfb || body[0] === 0xfa);
    const echoes = body.length >= p.cmd.length &&
      p.cmd.every((b, k) => body[k] === b);
    if (!isAck && !echoes) return;                // протухший ответ — ждём дальше
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve(body);
  }

  /* ---------- транзакции ---------- */

  /** Отправить команду и дождаться ответа; null при таймауте. */
  txn (cmd, timeoutMs = 150) {
    const run = async () => {
      if (!this.writer) throw new Error('порт не открыт');
      const bytes = Uint8Array.from(cmd);
      const frame = new Uint8Array(bytes.length + 5);
      frame.set([0xfe, 0xfe, this.radio, this.ctrl]);
      frame.set(bytes, 4);
      frame[frame.length - 1] = 0xfd;

      const reply = new Promise(resolve => {
        this.pending = {
          cmd: bytes,
          resolve,
          timer: setTimeout(() => { this.pending = null; resolve(null); }, timeoutMs),
        };
      });
      await this.writer.write(frame);
      return reply;
    };
    // по одному запросу за раз: шина общая, ответы не помечены идентификатором
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  /* ---------- чтение состояния ---------- */

  async readFrequency () {
    const b = await this.txn([0x03]);
    return (b && b[0] === 0x03 && b.length >= 6) ? bcdToFreq(b.subarray(1, 6)) : null;
  }

  async readMode () {
    const b = await this.txn([0x04]);
    return (b && b[0] === 0x04 && b.length >= 2) ? (MODES[b[1]] ?? '?') : null;
  }

  async readSMeterRaw () {
    const b = await this.txn([0x15, 0x02]);
    return (b && b[0] === 0x15 && b[1] === 0x02 && b.length >= 4)
      ? parseInt(hex2(b[2]) + hex2(b[3]), 10) : null;
  }

  async readSquelchOpen () {
    const b = await this.txn([0x15, 0x01]);
    return (b && b[0] === 0x15 && b[1] === 0x01 && b.length >= 3) ? b[2] === 1 : null;
  }

  /* ---------- запись состояния ---------- */

  async setFrequency (hz) {
    const b = await this.txn([0x05, ...freqToBcd(hz)], 200);
    return b != null;
  }

  async setMode (name) {
    const code = MODE_BY_NAME[String(name).toUpperCase()];
    if (code === undefined) return false;
    return (await this.txn([0x06, code], 200)) != null;
  }

  /* ---------- пункты меню Set (1A 05) ---------- */

  /** Номер пункта задаётся десятичным числом: 109 -> байты BCD 01 09. */
  async readSetting (item) {
    const hi = bcd2(Math.floor(item / 100)), lo = bcd2(item % 100);
    const b = await this.txn([0x1a, 0x05, hi, lo], 400);
    if (!b || b[0] !== 0x1a || b[1] !== 0x05 || b[2] !== hi || b[3] !== lo) return null;
    return b.subarray(4);
  }

  async setSetting (item, data) {
    const hi = bcd2(Math.floor(item / 100)), lo = bcd2(item % 100);
    const b = await this.txn([0x1a, 0x05, hi, lo, ...data], 400);
    return b != null && b[0] === 0xfb;
  }

  /** USB AF/IF Output -> 'AF' | 'IF' | null (пункт 0109). */
  async readUsbOutputSelect () {
    const v = await this.readSetting(109);
    return v?.length ? (v[0] === 1 ? 'IF' : 'AF') : null;
  }

  async setUsbOutputSelect (mode) {
    return this.setSetting(109, [mode === 'IF' ? 1 : 0]);
  }

  /** USB IF Output Level, % (пункт 0113: 0..100 % -> 0..255 четырёхзначным BCD).
   *  Выше 70 % клиппинг АЦП кодека, поэтому вызывающий должен ограничивать. */
  async setUsbIfLevel (pct) {
    const raw = Math.max(0, Math.min(255, Math.round(pct * 255 / 100)));
    return this.setSetting(113, [bcd2(Math.floor(raw / 100)), bcd2(raw % 100)]);
  }

  /** Band-stacking (1A 01): последняя частота и режим диапазона. */
  async readBandStack (band, reg = 1) {
    const b = await this.txn([0x1a, 0x01, bcd2(band), bcd2(reg)], 500);
    if (!b || b.length < 10 || b[0] !== 0x1a || b[1] !== 0x01) return null;
    return { hz: bcdToFreq(b.subarray(4, 9)), mode: MODES[b[9]] ?? 'FM' };
  }

  /* ---------- водопад ---------- */

  /** Включить поток кадров Scope Waveform Data (27 11). */
  async setScopeOutput (on) {
    return (await this.txn([0x27, 0x11, on ? 0x01 : 0x00], 400)) != null;
  }
}

export { fromBcd };
