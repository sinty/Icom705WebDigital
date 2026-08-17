/* Сборка развёрток панорамы IC-705 и отрисовка в стиле родного экрана.
 *
 * Формат кадров выяснен экспериментально в соседнем проекте и сверен с wfview:
 *
 *   27 11 01 / 27 11 00  — включить/выключить поток
 *   27 00                — сами кадры, радио шлёт их само, ~4 раза в секунду
 *
 * Тело после «27 00»: [receiver, seq(BCD), seqMax(BCD)=11, ...]
 *   seq == 1      : [mode, center(5б BCD-частота), halfspan(5б BCD-частота), out_of_range]
 *   seq == 2..11  : сырые байты амплитуды 0x00..0xA0, по 50 на сегмент (25 на последнем)
 *
 * Всего 475 точек на развёртку (SpectrumLenMax из rigs/IC-705.rig в wfview).
 *
 * Внешний вид срисован с фотографии экрана IC-705: сверху заполненная
 * спектральная кривая по сетке, под ней полоса частотной шкалы в килогерцах
 * от центра, ниже водопад. Пол водопада синий, а не чёрный — это заметная
 * часть узнаваемости.
 */
import { bcdToFreq, fromBcd } from './civ.js';

export const POINTS = 475;
export const AMP_MAX = 0xa0;      // верх шкалы амплитуды в кадрах IC-705

export class SpectrumAssembler {
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

/* ---------- палитра ---------- */

/* Снято с фотографии экрана IC-705. Ключевое отличие от «обычных» водопадов:
   нижний конец не чёрный, а насыщенно-синий, поэтому шум выглядит синим полем,
   а не темнотой. Дальше синий -> голубой -> зелёный -> жёлтый -> красный -> белый. */
const STOPS = [
  [0.00, [4, 10, 48]],
  [0.10, [10, 26, 96]],
  [0.28, [20, 62, 178]],
  [0.44, [26, 122, 214]],
  [0.58, [40, 200, 214]],
  [0.70, [56, 200, 72]],
  [0.82, [212, 220, 20]],
  [0.92, [240, 120, 20]],
  [1.00, [255, 255, 255]],
];

/** Готовая таблица на 256 значений — считать градиент на каждый пиксель дорого. */
const LUT = (() => {
  const t = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && x > STOPS[k + 1][0]) k++;
    const [x0, c0] = STOPS[k], [x1, c1] = STOPS[k + 1];
    const f = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
    for (let c = 0; c < 3; c++) t[i * 3 + c] = Math.round(c0[c] + (c1[c] - c0[c]) * f);
  }
  return t;
})();

/* ---------- отрисовка ---------- */

export class ScopeView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object}  [o]
   * @param {number}  [o.specRatio]  доля высоты под спектр (на радио примерно 0.45)
   * @param {number}  [o.history]    строк водопада
   * @param {number}  [o.divisions]  делений сетки по горизонтали (на радио 10)
   * @param {number}  [o.dbDivs]     делений по вертикали
   */
  constructor (canvas, o = {}) {
    const { specRatio = 0.45, history = 260, divisions = 10, dbDivs = 5 } = o;
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.specRatio = specRatio;
    this.divisions = divisions;
    this.dbDivs = dbDivs;
    this.history = history;

    // сырое поле водопада: точки × история, на экран растягивается ровно вдвое
    this.wf = document.createElement('canvas');
    this.wf.width = POINTS;
    this.wf.height = history;
    this.wfg = this.wf.getContext('2d');
    this.line = this.wfg.createImageData(POINTS, 1);

    this.row = null;
    this.centerHz = null;
    this.spanHz = null;

    // границы отображения в сырых единицах (0..160): ими подгоняется контраст
    this.floor = 20;
    this.ceiling = 140;

    this.SCALE_H = 16;             // полоса частотной шкалы между блоками
    this.resize();
    this.clear();
  }

  setRange (floor, ceiling) {
    this.floor = Math.min(floor, ceiling - 1);
    this.ceiling = Math.max(ceiling, this.floor + 1);
    this.redraw();
  }

  /** Подгоняем буфер под фактический размер на странице, иначе всё мылит. */
  resize () {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || POINTS * 2;
    const h = this.canvas.clientHeight || 300;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w; this.H = h;
    this.specH = Math.round((h - this.SCALE_H) * this.specRatio);
    this.wfH = h - this.SCALE_H - this.specH;
    this.redraw();
  }

  clear () {
    this.wfg.fillStyle = 'rgb(4,10,48)';
    this.wfg.fillRect(0, 0, POINTS, this.history);
    this.row = null;
    this.redraw();
  }

  /** Нормировка сырого значения в 0..1 по текущим границам. */
  _norm (v) {
    const t = (v - this.floor) / (this.ceiling - this.floor);
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }

  push (row) {
    this.row = row.data.slice();
    this.centerHz = row.centerHz;
    this.spanHz = row.spanHz;

    const px = this.line.data;
    for (let i = 0; i < POINTS; i++) {
      const c = (Math.round(this._norm(this.row[i]) * 255) | 0) * 3;
      px[i * 4] = LUT[c]; px[i * 4 + 1] = LUT[c + 1]; px[i * 4 + 2] = LUT[c + 2];
      px[i * 4 + 3] = 255;
    }
    // Направление как на IC-705: новая строка появляется СВЕРХУ, вплотную к
    // спектру, история уезжает вниз. Это отличается от привычных SDR-водопадов,
    // где новое дописывается снизу.
    this.wfg.drawImage(this.wf, 0, 1);
    this.wfg.putImageData(this.line, 0, 0);
    this.redraw();
  }

  redraw () {
    const g = this.g, W = this.W, H = this.H, specH = this.specH;
    g.fillStyle = '#05070d';
    g.fillRect(0, 0, W, H);

    this._drawSpectrum(g, W, specH);
    this._drawScale(g, W, specH);
    this._drawWaterfall(g, W, specH + this.SCALE_H, this.wfH);
  }

  _drawSpectrum (g, W, h) {
    // фон и сетка
    g.fillStyle = '#0b1020';
    g.fillRect(0, 0, W, h);

    g.strokeStyle = 'rgba(150,170,200,.28)';
    g.lineWidth = 1;
    g.beginPath();
    for (let d = 1; d < this.divisions; d++) {
      const x = Math.round(W * d / this.divisions) + 0.5;
      g.moveTo(x, 0); g.lineTo(x, h);
    }
    for (let d = 1; d < this.dbDivs; d++) {
      const y = Math.round(h * d / this.dbDivs) + 0.5;
      g.moveTo(0, y); g.lineTo(W, y);
    }
    g.stroke();

    // центральная метка — на радио она заметно ярче сетки
    g.strokeStyle = 'rgba(190,210,235,.55)';
    g.beginPath();
    g.moveTo(Math.round(W / 2) + 0.5, 0); g.lineTo(Math.round(W / 2) + 0.5, h);
    g.stroke();

    if (this.row) {
      // заполненная кривая: бледно-голубая заливка и более яркая верхняя кромка
      g.beginPath();
      g.moveTo(0, h);
      for (let i = 0; i < POINTS; i++) {
        const x = i / (POINTS - 1) * W;
        g.lineTo(x, h - this._norm(this.row[i]) * (h - 2) - 1);
      }
      g.lineTo(W, h);
      g.closePath();
      g.fillStyle = 'rgba(150,220,240,.55)';
      g.fill();

      g.beginPath();
      for (let i = 0; i < POINTS; i++) {
        const x = i / (POINTS - 1) * W;
        const y = h - this._norm(this.row[i]) * (h - 2) - 1;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = 'rgb(215,245,255)';
      g.lineWidth = 1;
      g.stroke();
    }

    // подписи краёв обзора, как «-100k / +100k» на радио
    if (this.spanHz) {
      const half = this.spanHz / 2000;
      g.font = '10px ui-monospace, Consolas, monospace';
      g.fillStyle = 'rgba(190,210,235,.75)';
      g.textBaseline = 'top';
      g.textAlign = 'left';  g.fillText(`-${this._khz(half)}k`, 4, 3);
      g.textAlign = 'right'; g.fillText(`+${this._khz(half)}k`, W - 4, 3);
    }

    g.strokeStyle = 'rgba(150,170,200,.45)';
    g.strokeRect(0.5, 0.5, W - 1, h - 1);
  }

  _khz (v) { return Number.isInteger(v) ? String(v) : v.toFixed(1); }

  /** Полоса частотной шкалы: смещения в килогерцах от центра, как на радио. */
  _drawScale (g, W, top) {
    const h = this.SCALE_H;
    g.fillStyle = '#1b2436';
    g.fillRect(0, top, W, h);

    if (!this.spanHz) return;
    const stepKhz = this.spanHz / 1000 / this.divisions;
    g.font = '10px ui-monospace, Consolas, monospace';
    g.fillStyle = 'rgba(205,225,245,.9)';
    g.strokeStyle = 'rgba(205,225,245,.5)';
    g.textBaseline = 'middle';
    g.textAlign = 'center';

    for (let d = 0; d <= this.divisions; d++) {
      const x = W * d / this.divisions;
      const off = (d - this.divisions / 2) * stepKhz;
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, top);
      g.lineTo(Math.round(x) + 0.5, top + 3);
      g.stroke();
      // крайние подписи упираются в рамку — их радио тоже не рисует
      if (d === 0 || d === this.divisions) continue;
      const label = off === 0 ? '0' : (off > 0 ? '+' : '') + this._khz(off);
      g.fillText(label, x, top + h / 2 + 2);
    }
  }

  _drawWaterfall (g, W, top, h) {
    g.imageSmoothingEnabled = false;
    g.drawImage(this.wf, 0, 0, POINTS, this.history, 0, top, W, h);
    g.strokeStyle = 'rgba(150,170,200,.45)';
    g.strokeRect(0.5, top + 0.5, W - 1, h - 1);
  }
}
