/* Захват ПЧ с USB-кодека IC-705.
 *
 * Задача одна: собрать отсчёты блоками и отдать их наружу, ничего не обрабатывая.
 * Демодуляция живёт в воркере — в аудиопотоке ей делать нечего.
 *
 * Канал НЕ дублируем: если Windows отдаёт моно, Q остаётся нулевым и это видно
 * по флагу stereo. Подстановка копии левого канала маскирует проблему (NOTES.md).
 */
const BLOCK = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor () {
    super();
    this.i = new Float32Array(BLOCK);
    this.q = new Float32Array(BLOCK);
    this.n = 0;
    this.channels = 0;
  }

  process (inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length || !inp[0]) return true;

    const L = inp[0], R = inp.length > 1 ? inp[1] : null;
    if (inp.length !== this.channels) {
      this.channels = inp.length;
      this.port.postMessage({ type: 'channels', channels: inp.length });
    }

    for (let k = 0; k < L.length; k++) {
      this.i[this.n] = L[k];
      this.q[this.n] = R ? R[k] : 0;
      if (++this.n === BLOCK) {
        this.port.postMessage(
          { type: 'iq', i: this.i, q: this.q, stereo: !!R },
          [this.i.buffer, this.q.buffer]);
        this.i = new Float32Array(BLOCK);
        this.q = new Float32Array(BLOCK);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
