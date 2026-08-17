/* Заглушка PulseAudio для сборки dsd-fme в WASM.
 *
 * Ввод берётся из кольцевого буфера, заполняемого AudioWorklet, вывод уходит
 * обратным вызовом в JS — сервер звука здесь не при чём. Типы объявлены ровно
 * настолько, чтобы dsd.h компилировался; реализации — в shims/shim.c.
 */
#ifndef DSDWASM_PULSE_STUB_H
#define DSDWASM_PULSE_STUB_H

#include <stddef.h>
#include <stdint.h>

typedef struct pa_simple pa_simple;
typedef struct pa_context pa_context;
typedef struct pa_mainloop pa_mainloop;
typedef struct pa_mainloop_api pa_mainloop_api;
typedef struct pa_operation pa_operation;
typedef struct pa_channel_map pa_channel_map;

typedef enum {
  PA_SAMPLE_U8,
  PA_SAMPLE_ALAW,
  PA_SAMPLE_ULAW,
  PA_SAMPLE_S16LE,
  PA_SAMPLE_S16BE,
  PA_SAMPLE_FLOAT32LE,
  PA_SAMPLE_S32LE
} pa_sample_format_t;

/* В настоящем PulseAudio *NE — это макросы «под порядок байтов машины».
   WebAssembly всегда little-endian, поэтому просто алиасы на LE. */
#define PA_SAMPLE_S16NE     PA_SAMPLE_S16LE
#define PA_SAMPLE_FLOAT32NE PA_SAMPLE_FLOAT32LE
#define PA_SAMPLE_S32NE     PA_SAMPLE_S32LE

typedef enum {
  PA_STREAM_NODIRECTION,
  PA_STREAM_PLAYBACK,
  PA_STREAM_RECORD,
  PA_STREAM_UPLOAD
} pa_stream_direction_t;

typedef struct pa_sample_spec {
  pa_sample_format_t format;
  uint32_t rate;
  uint8_t channels;
} pa_sample_spec;

typedef struct pa_buffer_attr {
  uint32_t maxlength;
  uint32_t tlength;
  uint32_t prebuf;
  uint32_t minreq;
  uint32_t fragsize;
} pa_buffer_attr;

#endif /* DSDWASM_PULSE_STUB_H */
