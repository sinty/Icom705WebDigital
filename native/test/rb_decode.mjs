/* Прогон демодулированного сигнала через WASM-сборку dsd-fme, подавая его
 * в кольцевой буфер — ровно тем путём, каким это будет делать браузер.
 *
 *   node native/test/rb_decode.mjs [вход.wav] [эталон-голоса.wav]
 *
 * По умолчанию вход — ref/demod_stereo.wav (выход демодулятора GNU Radio с Pi),
 * эталон — ref/voice_w1.wav (тот же вход, но поданный файлом через libsndfile).
 * При исправном шве совпадение должно быть побайтовым: обе сборки WASM с одним
 * и тем же rand() из musl, так что любое расхождение означает потерю или
 * дублирование отсчётов.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readWav, writeWav, compare } from '../../test/wav.mjs';
import createDsdModule from '../build/dsd-fme-rb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERBOSE = !!process.env.DSD_VERBOSE;

const IN_WAV = path.resolve(process.argv[2] ?? path.join(ROOT, 'ref/demod_stereo.wav'));
const REF_WAV = process.argv[3] ? path.resolve(process.argv[3])
                                : path.join(ROOT, 'ref/voice_w1.wav');
const OUT_WAV = path.join(ROOT, 'ref',
  'voice_' + path.basename(IN_WAV).replace(/^demod_/, '').replace(/\.wav$/, '') + '.wav');

const CHUNK = 4800;                       // 100 мс за раз
const sleep = ms => new Promise(r => setTimeout(r, ms));
const base = f => f.split(/[\\/]/).pop();

const input = readWav(IN_WAV);
console.log(`вход   : ${base(IN_WAV)} — ${input.rate} Гц, ${input.ch} кан, ` +
            `${(input.samples.length / input.rate / input.ch).toFixed(1)} с`);

const streams = new Map();                // id -> {dir, rate, ch, chunks}
const logLines = [];

const Module = await createDsdModule({
  noInitialRun: true,
  print:    t => { logLines.push(t); if (VERBOSE) console.log('  dsd|', t); },
  printErr: t => { logLines.push(t); if (VERBOSE) console.log('  dsd!', t); },
});

Module.onStreamOpen = (id, dir, rate, ch) => {
  streams.set(id, { dir, rate, ch, chunks: [] });
  if (VERBOSE)
    console.log(`поток  : id=${id} ${dir === 2 ? 'вход' : 'выход'} ${rate} Гц ${ch} кан`);
};
Module.onAudio = (id, view) => {
  const s = streams.get(id);
  if (s) s.chunks.push(Int16Array.from(view));   // копия: буфер переиспользуется
};

// Кольцевой буфер заранее НЕ создаём: всё, записанное до callMain, обнуляется
// при инициализации рантайма (см. NOTES.md). Шов выделяет его сам.
Module.callMain(['-fs', '-i', 'pulse', '-o', 'pulse']);

const scratch = Module._malloc(CHUNK * 2);
const t0 = Date.now();
let fed = 0, tick = Date.now(), stalls = 0;

while (fed < input.samples.length) {
  if (Date.now() - tick > 1000) {
    tick = Date.now();
    if (VERBOSE) console.log(`  подано=${fed} ожидание=${Module._dsdw_rb_starve_ms().toFixed(0)}мс`);
    if (++stalls > 20) { console.log('  ! декодер не потребляет, прерываю'); break; }
  }
  if (Module._dsdw_rb_space() < CHUNK) { await sleep(2); continue; }
  const n = Math.min(CHUNK, input.samples.length - fed);
  Module.HEAP16.set(input.samples.subarray(fed, fed + n), scratch >> 1);
  fed += Module._dsdw_rb_write(scratch, n);
}
while (Module._dsdw_rb_count() > 0) await sleep(5);
Module._free(scratch);

await sleep(1500);        // буфер пуст, декодер спит в pa_simple_read — даём дожевать

const secs = (Date.now() - t0) / 1000;
const audioSecs = input.samples.length / input.rate / input.ch;
console.log(`скорос.: x${(audioSecs / secs).toFixed(1)} реального времени, ` +
            `простой ${Module._dsdw_rb_starve_ms().toFixed(0)} мс`);

for (const [, s] of streams) {
  const n = s.chunks.reduce((a, c) => a + c.length, 0);
  if (!n || s.dir === 2) continue;
  const all = new Int16Array(n);
  let o = 0; for (const c of s.chunks) { all.set(c, o); o += c.length; }
  writeWav(OUT_WAV, all, s.rate || 8000, s.ch || 2);
  console.log(`голос  : ${n} отсч. (${(n / (s.rate * s.ch)).toFixed(1)} с) -> ${base(OUT_WAV)}`);
}

const grep = re => logLines.filter(l => re.test(l)).length;
console.log(`декодер: sync=${grep(/sync/i)} crc-err=${grep(/crc err/i)} voice=${grep(/VOICE/)}`);

if (fs.existsSync(REF_WAV) && fs.existsSync(OUT_WAV)) {
  const c = compare(readWav(REF_WAV).samples, readWav(OUT_WAV).samples);
  console.log(`сверка с ${base(REF_WAV)}: длина ${c.lenA} против ${c.lenB}, ` +
              `совпадает ${c.samePct.toFixed(2)} %, корреляция ${c.corr.toFixed(4)}`);
}

process.exit(0);
