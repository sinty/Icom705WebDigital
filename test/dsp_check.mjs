/* Проверка DSP-тракта против эталона GNU Radio.
 *
 * ref/if_master.wav  — сырая ПЧ с IC-705 (снята на Pi)
 * ref/demod_stereo.wav — она же, прогнанная через if_demod_offline_iq.py
 *                        (GNU Radio: xlate 12060 / ФНЧ ±5к / quadrature_demod)
 *
 * Наш web/dsp/iq-demod.js должен дать то же самое. Заодно считается вариант
 * с одним каналом — им браузер и будет пользоваться, если Windows отдаёт моно.
 *
 *   node test/dsp_check.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav, writeWav, deinterleave, compare } from './wav.mjs';
import { IfDemodulator, firdesNtaps } from '../web/dsp/iq-demod.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = f => path.join(ROOT, f);

const src = readWav(p('ref/if_master.wav'));
const ref = readWav(p('ref/demod_stereo.wav'));
const { L, R } = deinterleave(src.samples, src.ch);

console.log(`вход   : ${src.rate} Гц, ${src.ch} кан, ${(L.length / src.rate).toFixed(1)} с`);
console.log(`эталон : ${ref.rate} Гц, ${ref.ch} кан, ${ref.samples.length} отсч.`);
console.log(`фильтр : ${firdesNtaps(src.rate, 2500)} отводов\n`);

/** Подобрать целочисленный сдвиг, на котором ряды совпадают лучше всего.
 *  GNU Radio отбрасывает первые ntaps-1 отсчётов истории, наш тракт — нет. */
function bestLag (a, b, maxLag) {
  let best = 0, bestCorr = -Infinity;
  for (let lag = 0; lag <= maxLag; lag++) {
    let cov = 0, sa = 0, sb = 0;
    const n = Math.min(a.length - lag, b.length, 400000);
    for (let i = 0; i < n; i += 3) {
      const x = a[i + lag], y = b[i];
      cov += x * y; sa += x * x; sb += y * y;
    }
    const c = cov / (Math.sqrt(sa * sb) || 1);
    if (c > bestCorr) { bestCorr = c; best = lag; }
  }
  return { lag: best, corr: bestCorr };
}

for (const [name, q, out] of [
  ['стерео (I и Q)', R, 'ref/demod_js_stereo.wav'],
  ['моно (только L)', null, 'ref/demod_js_mono.wav'],
]) {
  const y = new IfDemodulator({ sampleRate: src.rate }).process(L, q);
  writeWav(p(out), y, src.rate, 1);

  const { lag } = bestLag(y, ref.samples, 64);
  const c = compare(y.subarray(lag), ref.samples);
  console.log(`${name}`);
  console.log(`  сдвиг относительно эталона : ${lag} отсч.`);
  console.log(`  корреляция с эталоном      : ${c.corr.toFixed(6)}`);
  console.log(`  совпадает отсчётов         : ${c.samePct.toFixed(2)} %`);
  console.log(`  СКО расхождения            : ${c.rms.toFixed(1)} при СКО сигнала ${c.rmsA.toFixed(0)}`);
  console.log(`  файл                       : ${out}\n`);
}
