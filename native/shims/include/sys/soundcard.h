/* Заглушка <sys/soundcard.h> (OSS) для сборки dsd-fme в WASM.
 *
 * dsd_audio.c умеет отдавать звук через OSS (/dev/dsp) — в браузере такого
 * устройства нет, и этот путь никогда не выбирается (audio_out_type != OSS).
 * Но код с ioctl-константами всё равно компилируется, поэтому константы нужны.
 * Значения взяты как в Linux; ими никто не пользуется, важен только тип.
 */
#ifndef DSDWASM_SOUNDCARD_STUB_H
#define DSDWASM_SOUNDCARD_STUB_H

#include <sys/ioctl.h>

#define SNDCTL_DSP_RESET       0x00005000
#define SNDCTL_DSP_SYNC        0x00005001
#define SNDCTL_DSP_SPEED       0xc0045002
#define SNDCTL_DSP_STEREO      0xc0045003
#define SNDCTL_DSP_GETBLKSIZE  0xc0045004
#define SNDCTL_DSP_SETFMT      0xc0045005
#define SNDCTL_DSP_CHANNELS    0xc0045006
#define SNDCTL_DSP_GETFMTS     0x8004500b
#define SNDCTL_DSP_SETFRAGMENT 0xc004500a

#define AFMT_QUERY   0x00000000
#define AFMT_U8      0x00000008
#define AFMT_S16_LE  0x00000010
#define AFMT_S16_BE  0x00000020
#define AFMT_S32_LE  0x00001000

#endif /* DSDWASM_SOUNDCARD_STUB_H */
