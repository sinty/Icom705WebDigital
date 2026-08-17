/* Сквозная проверка всей цепочки ровно тем путём, каким её проходит браузер.
 *
 *   ПЧ блоками по 2048 -> IfDemodulator (потоково) -> кольцевой буфер -> dsd-fme
 *
 * Отличие от dsp_check.mjs принципиальное: там весь файл обрабатывался одним
 * вызовом, здесь — блоками, как их отдаёт AudioWorklet. Это ловит ошибки
 * переноса состояния через границу блока: линия задержки ФНЧ, фаза гетеродина,
 * предыдущий отсчёт ЧМ-детектора. Расхождение хотя бы в одном отсчёте
 * относительно эталона означает, что состояние где-то теряется.
 *
 *   node test/chain_check.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav, writeWav, deinterleave, compare } from './wav.mjs';
import { IfDemodulator } from '../web/dsp/iq-demod.js';
import createDsdModule from '../native/build/dsd-fme-rb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = f => path.join(ROOT, f);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BLOCK = 2048;              // столько отдаёт web/worklet/capture.js
const STEREO = process.argv[2] !== 'mono';

const src = readWav(p('ref/if_master.wav'));
const { L, R } = deinterleave(src.samples, src.ch);
console.log(`вход  : if_master.wav, ${(L.length / src.rate).toFixed(1)} с, ` +
            `режим ${STEREO ? 'стерео' : 'моно'}, блок ${BLOCK} отсч.`);

const chunks = [];
const Module = await createDsdModule({ noInitialRun: true, print: () => {}, printErr: () => {} });
Module.onAudio = (id, view) => chunks.push(Int16Array.from(view));
Module.callMain(['-fs', '-i', 'pulse', '-o', 'pulse']);

const demod = new IfDemodulator({ sampleRate: src.rate });
const scratch = Module._malloc(BLOCK * 2);
const t0 = Date.now();

for (let off = 0; off < L.length; off += BLOCK) {
  const n = Math.min(BLOCK, L.length - off);
  const pcm = demod.process(L.subarray(off, off + n),
                            STEREO && R ? R.subarray(off, off + n) : null);

  let rest = pcm.subarray(0, n);
  while (rest.length) {
    if (Module._dsdw_rb_space() < rest.length) { await sleep(2); continue; }
    Module.HEAP16.set(rest, scratch >> 1);
    const wrote = Module._dsdw_rb_write(scratch, rest.length);
    rest = wrote < rest.length ? rest.subarray(wrote) : rest.subarray(rest.length);
  }
}
while (Module._dsdw_rb_count() > 0) await sleep(5);
Module._free(scratch);
await sleep(1500);

const total = chunks.reduce((a, c) => a + c.length, 0);
const voice = new Int16Array(total);
let o = 0; for (const c of chunks) { voice.set(c, o); o += c.length; }

const out = STEREO ? 'ref/voice_chain_stereo.wav' : 'ref/voice_chain_mono.wav';
writeWav(p(out), voice, 8000, 2);

const secs = (Date.now() - t0) / 1000;
console.log(`скорос: x${((L.length / src.rate) / secs).toFixed(1)} реального времени`);
console.log(`голос : ${total} отсч. -> ${out}`);

const c = compare(readWav(p('ref/voice_w1.wav')).samples, voice);
console.log(`сверка с эталоном воспроизводимого пути (voice_w1.wav):`);
console.log(`  длина     : ${c.lenA} против ${c.lenB}`);
console.log(`  совпадает : ${c.samePct.toFixed(2)} % отсчётов`);
console.log(`  корреляция: ${c.corr.toFixed(6)}`);
console.log(c.samePct > 99.99
  ? '  ИТОГ: блочная обработка эквивалентна сплошной, состояние не теряется.'
  : '  ИТОГ: расхождение — проверьте перенос состояния через границу блока.');

process.exit(0);
