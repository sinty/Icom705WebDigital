/* Воспроизведение декодированного голоса.
 *
 * dsd-fme отдаёт 8 кГц стерео, контекст живёт на 48 кГц — пересчитываем сами
 * линейной интерполяцией. Через AudioBufferSourceNode это тоже можно, но
 * очередь из коротких буферов даёт щелчки на стыках.
 *
 * У DMR два временных слота разведены по каналам: TS1 — левый, TS2 — правый.
 * Выбор слота делается заглушением канала (см. gains в приложении).
 */
const RING_FRAMES = 8 * 8000;      // 8 секунд запаса при 8 кГц

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor (options) {
    super();
    this.srcRate = options?.processorOptions?.srcRate ?? 8000;
    this.ring = new Float32Array(RING_FRAMES * 2);   // чередующееся стерео
    this.head = 0;                                   // куда пишем, во фреймах
    this.read = 0;                                   // дробная позиция чтения
    this.filled = 0;
    this.started = false;

    this.port.onmessage = e => {
      const d = e.data;
      if (d.type === 'pcm') this.push(d.pcm, d.channels ?? 2);
      else if (d.type === 'reset') { this.head = this.read = this.filled = 0; this.started = false; }
    };
  }

  push (pcm, ch) {
    const frames = Math.floor(pcm.length / ch);
    for (let f = 0; f < frames; f++) {
      const o = (this.head % RING_FRAMES) * 2;
      this.ring[o]     = pcm[f * ch] / 32768;
      this.ring[o + 1] = pcm[f * ch + (ch > 1 ? 1 : 0)] / 32768;
      this.head++;
      if (this.filled < RING_FRAMES) this.filled++;
    }
  }

  process (_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] ?? out[0];
    const step = this.srcRate / sampleRate;
    const avail = this.head - this.read;

    // Стартуем, накопив запас: иначе первые же кадры уйдут в подтяжку буфера.
    if (!this.started) {
      if (avail < this.srcRate * 0.25) { L.fill(0); R.fill(0); return true; }
      this.started = true;
    }
    if (avail < 2) { L.fill(0); R.fill(0); this.started = false; return true; }

    for (let k = 0; k < L.length; k++) {
      if (this.head - this.read < 2) { L[k] = 0; R[k] = 0; continue; }
      const base = Math.floor(this.read);
      const frac = this.read - base;
      const a = (base % RING_FRAMES) * 2;
      const b = ((base + 1) % RING_FRAMES) * 2;
      L[k] = this.ring[a]     * (1 - frac) + this.ring[b]     * frac;
      R[k] = this.ring[a + 1] * (1 - frac) + this.ring[b + 1] * frac;
      this.read += step;
    }
    return true;
  }
}

registerProcessor('playback', PlaybackProcessor);
