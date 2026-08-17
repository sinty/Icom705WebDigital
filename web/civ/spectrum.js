/* Сборка развёрток панорамы из кадров Scope Waveform Data IC-705.
 *
 * Формат выяснен экспериментально в соседнем проекте и сверен с wfview:
 *
 *   27 11 01 / 27 11 00  — включить/выключить поток
 *   27 00                — сами кадры, радио шлёт их само, ~4 раза в секунду
 *
 * Тело после «27 00»: [receiver, seq(BCD), seqMax(BCD)=11, ...]
 *   seq == 1      : [mode, center(5б BCD-частота), halfspan(5б BCD-частота), out_of_range]
 *   seq == 2..11  : сырые байты амплитуды 0x00..0xA0, по 50 на сегмент (25 на последнем)
 *
 * Всего 475 точек на развёртку (SpectrumLenMax из rigs/IC-705.rig в wfview).
 */
import { bcdToFreq, fromBcd } from './civ.js';

export const POINTS = 475;
export const AMP_MAX = 0xa0;      // верх шкалы амплитуды в кадрах IC-705

export class SpectrumAssembler {
  /** @param {(row: {data: Uint8Array, centerHz: ?number, spanHz: ?number, seq: number}) => void} [onRow] */
  constructor (onRow) {
    this.onRow = onRow ?? null;
    this.row = new Uint8Array(POINTS);
    this.pos = 0;
    this.centerHz = null;
    this.spanHz = null;
    this.seq = 0;                 // монотонный счётчик готовых развёрток
  }

  /** Вызывать на каждый кадр: body — тело БЕЗ ведущих байт 27 00. */
  feed (body) {
    if (body.length < 3) return;
    const seq = fromBcd(body[1]);
    const seqMax = fromBcd(body[2]);
    const payload = body.subarray(3);

    if (seq === 1) {
      if (payload.length < 12) return;
      // mode 0 — режим центра: дальше идут центр и половина обзора
      if (payload[0] === 0) {
        this.centerHz = bcdToFreq(payload.subarray(1, 6));
        this.spanHz = bcdToFreq(payload.subarray(6, 11)) * 2;
      }
      this.row = new Uint8Array(POINTS);
      this.pos = 0;
      return;
    }

    const end = Math.min(POINTS, this.pos + payload.length);
    this.row.set(payload.subarray(0, end - this.pos), this.pos);
    this.pos = end;

    if (seq === seqMax) {
      this.seq++;
      this.onRow?.({
        data: this.row, centerHz: this.centerHz, spanHz: this.spanHz, seq: this.seq,
      });
    }
  }

  /** Частота точки развёртки по её индексу — для перестройки кликом. */
  freqAt (index) {
    if (this.centerHz == null || this.spanHz == null) return null;
    return Math.round(this.centerHz + (index / (POINTS - 1) - 0.5) * this.spanHz);
  }
}

/* ---------- отрисовка ---------- */

/** Водопад: каждая новая развёртка — строка, старые уезжают вверх. */
export class WaterfallView {
  constructor (canvas, { history = 220 } = {}) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d', { willReadFrequently: false });
    this.history = history;
    // рисуем в буфер размером «точки на историю», на экран растягиваем
    this.buf = document.createElement('canvas');
    this.buf.width = POINTS;
    this.buf.height = history;
    this.bg = this.buf.getContext('2d');
    this.line = this.bg.createImageData(POINTS, 1);
  }

  /** Палитра: чёрный -> синий -> зелёный -> жёлтый -> белый. */
  static color (v) {
    const t = Math.max(0, Math.min(1, v / AMP_MAX));
    if (t < 0.25) return [0, 0, Math.round(t * 4 * 180)];
    if (t < 0.5)  return [0, Math.round((t - 0.25) * 4 * 200), Math.round(180 - (t - 0.25) * 4 * 180)];
    if (t < 0.75) return [Math.round((t - 0.5) * 4 * 255), 200, 0];
    const w = (t - 0.75) * 4;
    return [255, Math.round(200 + w * 55), Math.round(w * 255)];
  }

  push (data) {
    const px = this.line.data;
    for (let i = 0; i < POINTS; i++) {
      const [r, g, b] = WaterfallView.color(data[i]);
      px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
    }
    // сдвигаем историю вверх на строку и дописываем новую снизу
    this.bg.drawImage(this.buf, 0, -1);
    this.bg.putImageData(this.line, 0, this.history - 1);

    const { width, height } = this.canvas;
    this.g.imageSmoothingEnabled = false;
    this.g.drawImage(this.buf, 0, 0, POINTS, this.history, 0, 0, width, height);
  }

  clear () {
    this.bg.fillStyle = '#000';
    this.bg.fillRect(0, 0, POINTS, this.history);
    this.g.fillStyle = '#000';
    this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
