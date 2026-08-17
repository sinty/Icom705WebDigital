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
