/* Заглушка pulse/simple.h — см. pulse/pulseaudio.h. */
#ifndef DSDWASM_PULSE_SIMPLE_STUB_H
#define DSDWASM_PULSE_SIMPLE_STUB_H

#include <pulse/pulseaudio.h>

pa_simple *pa_simple_new (const char *server, const char *name,
                          pa_stream_direction_t dir, const char *dev,
                          const char *stream_name, const pa_sample_spec *ss,
                          const pa_channel_map *map, const pa_buffer_attr *attr,
                          int *error);

int pa_simple_read  (pa_simple *s, void *data, size_t bytes, int *error);
int pa_simple_write (pa_simple *s, const void *data, size_t bytes, int *error);
int pa_simple_drain (pa_simple *s, int *error);
int pa_simple_flush (pa_simple *s, int *error);
void pa_simple_free (pa_simple *s);

#endif /* DSDWASM_PULSE_SIMPLE_STUB_H */
