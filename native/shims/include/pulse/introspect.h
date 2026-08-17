/* Заглушка pulse/introspect.h — см. pulse/pulseaudio.h.
 * Структуры описаны минимально: код, который читает их поля (pa_devs.c,
 * pulse_devices.c), из сборки исключён, остаются только прототипы в dsd.h.
 */
#ifndef DSDWASM_PULSE_INTROSPECT_STUB_H
#define DSDWASM_PULSE_INTROSPECT_STUB_H

#include <pulse/pulseaudio.h>

typedef struct pa_sink_info {
  const char *name;
  uint32_t index;
  const char *description;
} pa_sink_info;

typedef struct pa_source_info {
  const char *name;
  uint32_t index;
  const char *description;
} pa_source_info;

#endif /* DSDWASM_PULSE_INTROSPECT_STUB_H */
