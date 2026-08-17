/* Демодулятор ПЧ IC-705: комплексный перенос на ноль, ФНЧ, сквелч, ЧМ-детектор.
 *
 * Замена флоуграфа GNU Radio из if_demod.py соседнего проекта — те же пять
 * блоков, но без единой зависимости. Браузерных API здесь нет: модуль одинаково
 * работает в AudioWorklet и в node, поэтому его можно проверять оффлайн на
 * эталонных записях (см. test/dsp_check.mjs).
 *
 * Про вход: ПЧ IC-705 — это ОДИН вещественный сигнал на ~12 кГц, а не
 * квадратурная пара (подробности в NOTES.md). Второй канал, если он есть,
 * несёт тот же сигнал со сдвигом в один отсчёт и даёт около 16 % к качеству.
 * Поэтому Q необязателен: при Q === null тракт работает от одного канала.
 */

export const SAMPLE_RATE = 48000;
export const IF_CENTER_HZ = 12060;      // компромисс: у каждого передатчика свой уход
export const CHANNEL_HALF_BW_HZ = 5000; // под C4FM Yaesu (±2700 Гц + скаты)
export const TRANSITION_HZ = 2500;
export const MAX_DEVIATION_HZ = 1944;   // номинал DMR: внешний символ -> ±1.0
export const S16_SCALE = 10000;         // запас от клиппинга, dsd-fme сам AGC-ит
export const SQUELCH_DB = -16;          // сигнал в канале -10.5 дБ, шум -22 дБ

/** Число отводов по правилу GNU Radio firdes: A = 53 дБ для окна Хэмминга. */
export function firdesNtaps (fs, transition) {
  let n = Math.floor(53 * fs / (22 * transition));
  if ((n & 1) === 0) n++;
  return n;
}

/** ФНЧ, совместимый с gr_filter.firdes.low_pass(gain, fs, cutoff, transition). */
export function firdesLowPass (gain, fs, cutoff, transition) {
  const ntaps = firdesNtaps(fs, transition);
  const M = (ntaps - 1) / 2;
  const fwT0 = 2 * Math.PI * cutoff / fs;
  const taps = new Float64Array(ntaps);

  for (let i = 0; i < ntaps; i++) {
    const n = i - M;
    const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (ntaps - 1));
    taps[i] = (n === 0 ? fwT0 / Math.PI : Math.sin(n * fwT0) / (n * Math.PI)) * w;
  }

  // нормировка на единичное усиление по постоянному току — как в firdes
  let fmax = taps[M];
  for (let n = 1; n <= M; n++) fmax += 2 * taps[M + n];
  const k = gain / fmax;
  for (let i = 0; i < ntaps; i++) taps[i] *= k;

  return taps;
}

/** БПФ на месте, длина — степень двойки. */
export function fft (re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + half], bi = im[i + k + half];
        const vr = br * cr - bi * ci, vi = br * ci + bi * cr;
        re[i + k] = ar + vr; im[i + k] = ai + vi;
        re[i + k + half] = ar - vr; im[i + k + half] = ai - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/**
 * Оценка фактической частоты несущей ПЧ.
 *
 * Нужна потому, что уход у каждого передатчика свой: зашитые 12060 Гц — лишь
 * компромисс, а промах по центру выглядит как «синхронизация есть, но пакеты
 * не проходят FEC». Меряется по вещественному каналу: ПЧ IC-705 и так
 * вещественная (см. NOTES.md).
 *
 * Два решения, без которых оценка врёт на сотни герц:
 *  - спектр УСРЕДНЯЕТСЯ по многим блокам: у модулированной несущей мгновенный
 *    пик гуляет по всему «горбу»;
 *  - берётся ЦЕНТР ТЯЖЕСТИ горба, а не его пик: центр стоит на месте, пик нет.
 */
export class CarrierEstimator {
  constructor (o = {}) {
    const { sampleRate = SAMPLE_RATE, n = 2048, lo = 8000, hi = 16000, blocks = 24 } = o;
    this.fs = sampleRate;
    this.n = n;
    this.lo = lo;
    this.hi = hi;
    this.need = blocks;
    this.acc = new Float64Array(n >> 1);
    this.count = 0;
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.win = new Float64Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  }

  /** Накопить один блок; блоки короче n игнорируются. */
  push (x) {
    const { n, win, re, im, acc } = this;
    if (x.length < n) return;
    for (let i = 0; i < n; i++) { re[i] = x[i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < (n >> 1); k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    this.count++;
  }

  get ready () { return this.count >= this.need; }

  /** @returns {?{hz: number, snrDb: number}} и сбрасывает накопление */
  result () {
    if (!this.count) return null;
    const { acc, n, fs, lo, hi } = this;
    const binHz = fs / n;
    const k0 = Math.max(1, Math.ceil(lo / binHz));
    const k1 = Math.min((n >> 1) - 2, Math.floor(hi / binHz));

    let out = null;
    if (k1 > k0) {
      let peak = k0, peakP = -1;
      const band = [];
      for (let k = k0; k <= k1; k++) {
        band.push(acc[k]);
        if (acc[k] > peakP) { peakP = acc[k]; peak = k; }
      }
      // Шумовая полка — НИЗКИЙ процентиль, не медиана: сигнал занимает бóльшую
      // часть полосы 8–16 кГц, и медиана попадает внутрь него, обнуляя оценку SNR.
      band.sort((a, b) => a - b);
      const floorP = band[Math.floor(band.length * 0.15)] || 1e-30;
      const snrDb = 10 * Math.log10((peakP || 1e-30) / floorP);

      if (snrDb >= 6) {
        const thr = peakP * 0.1;              // −10 дБ от пика: границы горба
        const span = Math.round(4000 / binHz);
        let num = 0, den = 0;
        for (let k = Math.max(k0, peak - span); k <= Math.min(k1, peak + span); k++) {
          if (acc[k] < thr) continue;
          num += acc[k] * k;
          den += acc[k];
        }
        if (den > 0) out = { hz: (num / den) * binHz, snrDb };
      }
    }

    this.acc.fill(0);
    this.count = 0;
    return out;
  }
}

/** Разовая оценка по готовому куску: усредняет по всем блокам, что в нём есть. */
export function estimateCarrier (x, fs, lo = 8000, hi = 16000) {
  const est = new CarrierEstimator({ sampleRate: fs, lo, hi });
  for (let off = 0; off + est.n <= x.length; off += est.n) {
    est.push(x.subarray(off, off + est.n));
  }
  return est.result();
}

export class IfDemodulator {
  /**
   * @param {object} [o]
   * @param {number} [o.sampleRate]
   * @param {number} [o.center]       центр ПЧ, Гц
   * @param {number} [o.halfBw]       половина полосы канального фильтра, Гц
   * @param {number} [o.transition]   ширина перехода фильтра, Гц
   * @param {number} [o.maxDeviation] девиация, соответствующая ±1.0 на выходе
   * @param {?number} [o.squelchDb]   порог сквелча по мощности; null — выключен
   */
  constructor (o = {}) {
    const {
      sampleRate = SAMPLE_RATE,
      center = IF_CENTER_HZ,
      halfBw = CHANNEL_HALF_BW_HZ,
      transition = TRANSITION_HZ,
      maxDeviation = MAX_DEVIATION_HZ,
      squelchDb = null,
    } = o;

    this.fs = sampleRate;
    this.taps = firdesLowPass(1, sampleRate, halfBw, transition);
    this.ntaps = this.taps.length;

    // кольцевые линии задержки комплексного входа
    this.zi = new Float64Array(this.ntaps);
    this.zq = new Float64Array(this.ntaps);
    this.pos = 0;

    // гетеродин
    this.phase = 0;
    this.dphase = -2 * Math.PI * center / sampleRate;

    // ЧМ-детектор
    this.prevI = 0;
    this.prevQ = 0;
    this.demodGain = sampleRate / (2 * Math.PI * maxDeviation);

    // сквелч по мощности: однополюсный БИХ, как analog.pwr_squelch_cc
    this.squelchLevel = squelchDb === null ? null : Math.pow(10, squelchDb / 10);
    this.squelchAlpha = 1e-3;
    this.power = 0;
  }

  /** Сменить центр ПЧ на лету, не теряя состояния фильтра. */
  setCenter (hz) { this.dphase = -2 * Math.PI * hz / this.fs; }

  setSquelchDb (db) {
    this.squelchLevel = db === null ? null : Math.pow(10, db / 10);
  }

  /**
   * @param {Float32Array|Float64Array} I  канал I (или единственный канал)
   * @param {?Float32Array|Float64Array} Q канал Q; null — вход вещественный
   * @param {Int16Array} [out]             буфер результата, иначе выделяется свой
   * @returns {Int16Array} демодулированное аудио s16, той же длины
   */
  process (I, Q, out) {
    const n = I.length;
    if (!out || out.length < n) out = new Int16Array(n);

    const { taps, ntaps, zi, zq } = this;
    let { pos, phase, prevI, prevQ, power } = this;
    const { dphase, demodGain, squelchLevel, squelchAlpha } = this;

    for (let k = 0; k < n; k++) {
      // перенос на ноль
      const c = Math.cos(phase), s = Math.sin(phase);
      const xi = I[k], xq = Q ? Q[k] : 0;
      zi[pos] = xi * c - xq * s;
      zq[pos] = xi * s + xq * c;

      phase += dphase;
      if (phase < -Math.PI) phase += 2 * Math.PI;   // держим фазу в разумных пределах
      else if (phase > Math.PI) phase -= 2 * Math.PI;

      // ФНЧ
      let fi = 0, fq = 0, j = pos;
      for (let t = 0; t < ntaps; t++) {
        const h = taps[t];
        fi += zi[j] * h;
        fq += zq[j] * h;
        if (--j < 0) j = ntaps - 1;
      }
      if (++pos >= ntaps) pos = 0;

      // сквелч: ниже порога отдаём комплексный ноль, тракт по темпу не рвём
      if (squelchLevel !== null) {
        power += squelchAlpha * (fi * fi + fq * fq - power);
        if (power < squelchLevel) { fi = 0; fq = 0; }
      }

      // ЧМ-детектор: arg(z[n] * conj(z[n-1]))
      const dr = fi * prevI + fq * prevQ;
      const di = fq * prevI - fi * prevQ;
      prevI = fi; prevQ = fq;

      const v = Math.atan2(di, dr) * demodGain * S16_SCALE;
      out[k] = v >= 32767 ? 32767 : v <= -32768 ? -32768 : Math.round(v);
    }

    this.pos = pos; this.phase = phase;
    this.prevI = prevI; this.prevQ = prevQ; this.power = power;
    return out;
  }
}
