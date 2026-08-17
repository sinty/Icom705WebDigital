/* Пустышки и шов ввода-вывода для сборки dsd-fme в WASM.
 *
 * Два источника недостающих символов:
 *   1) ncurses — терминала в браузере нет;
 *   2) PulseAudio — звук приходит из AudioWorklet и уходит обратным вызовом.
 *
 * Файлы dsd_ncurses_*.c, pa_devs.c и pulse_devices.c исключены из сборки
 * (см. native/CMakeLists.txt), поэтому определения объявленных в dsd.h
 * функций даны здесь.
 */
#include "dsd.h"
#include <stdlib.h>
#include <string.h>

/* ================= ncurses ================= */

WINDOW *stdscr = NULL;
int LINES = 24, COLS = 80;

WINDOW *initscr (void) { return NULL; }
int endwin (void) { return OK; }
int refresh (void) { return OK; }
int erase (void) { return OK; }
int getch (void) { return ERR; }
int start_color (void) { return OK; }
int use_default_colors (void) { return OK; }
int init_pair (short p, short f, short b) { (void)p; (void)f; (void)b; return OK; }
int has_colors (void) { return FALSE; }
int curs_set (int v) { (void)v; return OK; }
int noecho (void) { return OK; }
int echo (void) { return OK; }
int cbreak (void) { return OK; }
int nodelay (WINDOW *w, bool bf) { (void)w; (void)bf; return OK; }
int keypad (WINDOW *w, bool bf) { (void)w; (void)bf; return OK; }
int attron (chtype a) { (void)a; return OK; }
int attroff (chtype a) { (void)a; return OK; }
int wrefresh (WINDOW *w) { (void)w; return OK; }
int resizeterm (int l, int c) { (void)l; (void)c; return OK; }

int printw (const char *fmt, ...) { (void)fmt; return OK; }
int mvprintw (int y, int x, const char *fmt, ...) { (void)y; (void)x; (void)fmt; return OK; }

/* объявлены в dsd.h, определены в исключённых dsd_ncurses_*.c */
void ncursesOpen (dsd_opts *opts, dsd_state *state) { (void)opts; (void)state; }
void ncursesPrinter (dsd_opts *opts, dsd_state *state) { (void)opts; (void)state; }
void ncursesMenu (dsd_opts *opts, dsd_state *state) { (void)opts; (void)state; }
uint8_t ncurses_input_handler (dsd_opts *opts, dsd_state *state, int c)
{ (void)opts; (void)state; (void)c; return 0; }
void ncursesClose () { }

/* ================= PulseAudio: шов ввода-вывода ================= */

/* Весь ввод dsd-fme сходится в getSymbol() (src/dsd_symbol.c), а тот при
 * audio_in_type == 0 — значении по умолчанию — читает через pa_simple_read.
 * PulseAudio мы и так заглушаем, поэтому кольцевой буфер подставляется прямо
 * сюда: патчить dsd_symbol.c и заводить свой audio_in_type не требуется.
 * Декодированный звук перехватывается там же, в pa_simple_write.
 *
 * Без DSDW_ASYNC_INPUT остаются прежние пустышки — такая сборка используется
 * для регрессионных прогонов файлов через libsndfile.
 */

struct pa_simple {
  int id;
  int dir;
  int rate;
  int channels;
};

static struct pa_simple pulse_streams[8];
static int pulse_stream_count = 0;

#ifdef DSDW_ASYNC_INPUT

#include <emscripten.h>

EM_JS (void, dsdw_on_stream_open, (int id, int dir, int rate, int ch), {
  if (Module.onStreamOpen) Module.onStreamOpen(id, dir, rate, ch);
});

EM_JS (void, dsdw_on_audio, (int id, int ptr, int nsamples), {
  if (Module.onAudio)
    Module.onAudio(id, HEAP16.subarray(ptr >> 1, (ptr >> 1) + nsamples));
});

/* Кольцевой буфер отсчётов s16. Один писатель (JS), один читатель (декодер). */
static short *rb = NULL;
static int rb_cap = 0, rb_head = 0, rb_tail = 0;
static double rb_starve_ms = 0;   /* сколько всего простояли без данных */

#define RB_DEFAULT_SAMPLES 96000   /* 2 с при 48 кГц */

static int rb_count_i (void) { return (rb_head - rb_tail + rb_cap) % rb_cap; }

static int rb_alloc (int capacity_samples)
{
  free (rb);
  rb_cap = capacity_samples + 1;
  rb = (short *) malloc ((size_t) rb_cap * sizeof (short));
  rb_head = rb_tail = 0;
  rb_starve_ms = 0;
  return rb != NULL;
}

/* ВАЖНО: состояние, записанное из JS до callMain, теряется — рантайм
 * Emscripten инициализируется в момент запуска main и обнуляет статику.
 * Поэтому буфер создаётся лениво, уже внутри той же «эпохи», что и декодер,
 * и вызывать dsdw_rb_init заранее не нужно. */
static void rb_ensure (void) { if (!rb) rb_alloc (RB_DEFAULT_SAMPLES); }

EMSCRIPTEN_KEEPALIVE int dsdw_rb_init (int capacity_samples)
{ return rb_alloc (capacity_samples); }

EMSCRIPTEN_KEEPALIVE int dsdw_rb_count (void) { rb_ensure (); return rb ? rb_count_i () : 0; }
EMSCRIPTEN_KEEPALIVE int dsdw_rb_space (void) { rb_ensure (); return rb ? rb_cap - 1 - rb_count_i () : 0; }
EMSCRIPTEN_KEEPALIVE double dsdw_rb_starve_ms (void) { return rb_starve_ms; }

/* Возвращает, сколько отсчётов реально удалось положить. */
EMSCRIPTEN_KEEPALIVE int dsdw_rb_write (const short *src, int n)
{
  rb_ensure ();
  if (!rb) return 0;
  int i = 0;
  while (i < n && rb_count_i () < rb_cap - 1)
    {
      rb[rb_head] = src[i++];
      rb_head = (rb_head + 1) % rb_cap;
    }
  return i;
}

#endif /* DSDW_ASYNC_INPUT */

pa_simple *pa_simple_new (const char *server, const char *name,
                          pa_stream_direction_t dir, const char *dev,
                          const char *stream_name, const pa_sample_spec *ss,
                          const pa_channel_map *map, const pa_buffer_attr *attr,
                          int *error)
{
  (void)server; (void)name; (void)dev; (void)stream_name; (void)map; (void)attr;
  if (error) *error = 0;

  if (pulse_stream_count >= (int)(sizeof pulse_streams / sizeof pulse_streams[0]))
    return &pulse_streams[0];

  struct pa_simple *s = &pulse_streams[pulse_stream_count];
  s->id = pulse_stream_count++;
  s->dir = (int) dir;
  s->rate = ss ? (int) ss->rate : 0;
  s->channels = ss ? (int) ss->channels : 0;

#ifdef DSDW_ASYNC_INPUT
  dsdw_on_stream_open (s->id, s->dir, s->rate, s->channels);
#endif
  return s;
}

int pa_simple_read (pa_simple *s, void *data, size_t bytes, int *error)
{
  (void)s;
  if (error) *error = 0;

#ifdef DSDW_ASYNC_INPUT
  short *out = (short *) data;
  int need = (int) (bytes / sizeof (short));

  rb_ensure ();

  for (int i = 0; i < need; i++)
    {
      /* Ждём данных. Asyncify разматывает стек, управление уходит в JS,
         тот подкладывает отсчёты и возобновляет исполнение. */
      /* Пустой буфер усыпляет декодер, а не кормит его нулями: иначе он
         молотит тишину на полной скорости и жжёт процессор впустую. */
      while (rb && rb_count_i () == 0)
        {
          rb_starve_ms += 2;
          emscripten_sleep (2);
        }
      if (!rb) { out[i] = 0; continue; }
      out[i] = rb[rb_tail];
      rb_tail = (rb_tail + 1) % rb_cap;
    }
  return 0;
#else
  if (data && bytes) memset (data, 0, bytes);   /* тишина вместо звука */
  return 0;
#endif
}

int pa_simple_write (pa_simple *s, const void *data, size_t bytes, int *error)
{
  if (error) *error = 0;
#ifdef DSDW_ASYNC_INPUT
  if (s && data && bytes)
    dsdw_on_audio (s->id, (int)(intptr_t) data, (int)(bytes / sizeof (short)));
#else
  (void)s; (void)data; (void)bytes;
#endif
  return 0;
}

int pa_simple_drain (pa_simple *s, int *error)
{ (void)s; if (error) *error = 0; return 0; }

int pa_simple_flush (pa_simple *s, int *error)
{ (void)s; if (error) *error = 0; return 0; }

void pa_simple_free (pa_simple *s) { (void)s; }

const char *pa_strerror (int error) { (void)error; return "pulse disabled (wasm)"; }

/* объявлены в dsd.h, определены в исключённых pa_devs.c / pulse_devices.c */
void pa_state_cb (pa_context *c, void *userdata) { (void)c; (void)userdata; }
void pa_sinklist_cb (pa_context *c, const pa_sink_info *l, int eol, void *userdata)
{ (void)c; (void)l; (void)eol; (void)userdata; }
void pa_sourcelist_cb (pa_context *c, const pa_source_info *l, int eol, void *userdata)
{ (void)c; (void)l; (void)eol; (void)userdata; }
int pa_get_devicelist (pa_devicelist_t *input, pa_devicelist_t *output)
{ (void)input; (void)output; return 0; }
int pulse_list () { return 0; }
