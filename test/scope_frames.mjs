/* Проверка сборки развёрток панорамы из кадров Scope Waveform Data.
 *
 * Главное, что проверяется: потеря одного кадра НЕ должна сдвигать остальные.
 * Прежняя версия складывала сегменты по бегущей позиции, и один пропавший кадр
 * уезжал всё, что шло после него — на экране это выглядело как «спектр всё
 * время съезжает влево-вправо», хотя водопад казался нормальным.
 *
 *   node test/scope_frames.mjs
 */
import { SpectrumAssembler, POINTS } from '../web/civ/spectrum.js';

const SEG = 50;
const SEQ_MAX = 11;
const CENTER = 433_175_000;
const HALFSPAN = 100_000;

const bcd2 = n => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
const freqBcd = hz => {
  const d = String(hz).padStart(10, '0');
  return Array.from({ length: 5 }, (_, i) => parseInt(d.slice(8 - i * 2, 10 - i * 2), 16));
};

/** Кадр-заголовок развёртки (seq 1). */
const header = () => Uint8Array.from([
  0x00, bcd2(1), bcd2(SEQ_MAX),
  0x00, ...freqBcd(CENTER), ...freqBcd(HALFSPAN), 0x00,
]);

/** Кадр данных: сегмент номер seq (2..11) из эталонной развёртки. */
function dataFrame (seq, pattern) {
  const off = (seq - 2) * SEG;
  const n = Math.min(SEG, POINTS - off);
  return Uint8Array.from([0x00, bcd2(seq), bcd2(SEQ_MAX), ...pattern.subarray(off, off + n)]);
}

/** Эталон: узнаваемый рисунок, по которому виден любой сдвиг. */
const pattern = new Uint8Array(POINTS);
for (let i = 0; i < POINTS; i++) pattern[i] = (i * 7) % 0xa0;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  (cond ? pass++ : fail++);
  console.log(`${cond ? '  ок  ' : ' ПРОВАЛ'} ${name}${extra ? ' — ' + extra : ''}`);
};

/* --- 1. Целая развёртка собирается верно --- */
{
  const rows = [];
  const a = new SpectrumAssembler(r => rows.push(Uint8Array.from(r.data)));
  a.feed(header());
  for (let s = 2; s <= SEQ_MAX; s++) a.feed(dataFrame(s, pattern));

  check('целая развёртка выдана', rows.length === 1, `выдано ${rows.length}`);
  const same = rows[0] && rows[0].every((v, i) => v === pattern[i]);
  check('точки совпадают с эталоном', !!same);
  check('центр и обзор разобраны',
    a.centerHz === CENTER && a.spanHz === HALFSPAN * 2,
    `${a.centerHz} / ${a.spanHz}`);
  check('потерь не отмечено', a.damaged === 0 && a.orphans === 0);
}

/* --- 2. Потерянный кадр: развёртка отбрасывается, сдвига нет --- */
{
  const rows = [];
  const a = new SpectrumAssembler(r => rows.push(Uint8Array.from(r.data)));

  // первая развёртка без сегмента 5
  a.feed(header());
  for (let s = 2; s <= SEQ_MAX; s++) if (s !== 5) a.feed(dataFrame(s, pattern));
  check('рваная развёртка не выдана', rows.length === 0, `выдано ${rows.length}`);
  check('рваная развёртка отмечена', a.damaged === 1, `damaged=${a.damaged}`);

  // следующая целая — обязана быть точной, без наследия от предыдущей
  a.feed(header());
  for (let s = 2; s <= SEQ_MAX; s++) a.feed(dataFrame(s, pattern));
  check('следующая целая выдана', rows.length === 1);
  check('сдвига после потери нет', rows[0] && rows[0].every((v, i) => v === pattern[i]));
}

/* --- 3. Сегменты не по порядку — раскладываются по своим местам --- */
{
  const rows = [];
  const a = new SpectrumAssembler(r => rows.push(Uint8Array.from(r.data)));
  a.feed(header());
  const order = [7, 3, 2, 9, 4, 6, 5, 8, 10, 11];
  for (const s of order) a.feed(dataFrame(s, pattern));
  check('перемешанные сегменты собраны', rows.length === 1 &&
    rows[0].every((v, i) => v === pattern[i]));
}

/* --- 4. Данные без заголовка не притворяются развёрткой --- */
{
  const rows = [];
  const a = new SpectrumAssembler(r => rows.push(Uint8Array.from(r.data)));
  for (let s = 5; s <= SEQ_MAX; s++) a.feed(dataFrame(s, pattern));
  check('данные без заголовка отброшены', rows.length === 0 && a.orphans === 7,
    `orphans=${a.orphans}`);

  a.feed(header());
  for (let s = 2; s <= SEQ_MAX; s++) a.feed(dataFrame(s, pattern));
  check('после заголовка сборка идёт нормально', rows.length === 1 &&
    rows[0].every((v, i) => v === pattern[i]));
}

/* --- 5. Последний сегмент короче: 9x50 + 25 = 475 --- */
{
  const a = new SpectrumAssembler(() => {});
  a.feed(header());
  const last = dataFrame(SEQ_MAX, pattern);
  check('последний сегмент из 25 точек', last.length - 3 === POINTS - (SEQ_MAX - 2) * SEG,
    `${last.length - 3} точек`);
}

console.log(`\nитого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
