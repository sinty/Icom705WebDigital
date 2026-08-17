/* Чтение и запись WAV без зависимостей — общий помощник для проверок.
 * Разбор ручной: decodeAudioData и подобное молча ресемплит и нормирует,
 * а нам нужны ровно те отсчёты, что лежат в файле.
 */
import fs from 'node:fs';

/** @returns {{ch:number, rate:number, bits:number, samples:Int16Array}} */
export function readWav (file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`не WAV: ${file}`);

  let p = 12, fmt = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), sz = b.readUInt32LE(p + 4);
    if (id === 'fmt ')
      fmt = { code: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10),
              rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') {
      if (!fmt) throw new Error(`чанк data раньше fmt: ${file}`);
      if (fmt.bits !== 16) throw new Error(`нужен 16 бит, а не ${fmt.bits}: ${file}`);
      const n = Math.min(sz, b.length - p - 8);
      const s = new Int16Array(n >> 1);
      for (let i = 0; i < s.length; i++) s[i] = b.readInt16LE(p + 8 + i * 2);
      return { ...fmt, samples: s };
    }
    p += 8 + sz + (sz & 1);
  }
  throw new Error(`нет чанка data: ${file}`);
}

export function writeWav (file, samples, rate, ch) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii'); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * ch * 2, 28); b.writeUInt16LE(ch * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], 44 + i * 2);
  fs.writeFileSync(file, b);
}

/** Развести чередующееся стерео на два канала float в диапазоне ±1. */
export function deinterleave (samples, ch) {
  const n = Math.floor(samples.length / ch);
  const L = new Float64Array(n), R = ch > 1 ? new Float64Array(n) : null;
  for (let i = 0; i < n; i++) {
    L[i] = samples[i * ch] / 32768;
    if (R) R[i] = samples[i * ch + 1] / 32768;
  }
  return { L, R };
}

/** Сравнение двух рядов s16: доля совпадений, СКО, корреляция. */
export function compare (a, b) {
  const n = Math.min(a.length, b.length);
  let same = 0, err2 = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    if (!d) same++;
    err2 += d * d; sa += a[i] * a[i]; sb += b[i] * b[i];
  }
  let cov = 0;
  for (let i = 0; i < n; i++) cov += a[i] * b[i];
  return {
    n, lenA: a.length, lenB: b.length,
    samePct: same / n * 100,
    rms: Math.sqrt(err2 / n),
    rmsA: Math.sqrt(sa / n),
    corr: cov / (Math.sqrt(sa) * Math.sqrt(sb) || 1),
  };
}
