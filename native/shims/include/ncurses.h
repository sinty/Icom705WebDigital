/* Заглушка ncurses для сборки dsd-fme в WASM.
 *
 * Терминала в браузере нет. Настоящие dsd_ncurses_menu.c / _handler.c / _printer.c
 * исключены из сборки (см. native/CMakeLists.txt), здесь объявлено только то,
 * на что ссылается остальной код. Все реализации — пустышки в shims/shim.c,
 * а use_ncurses_terminal принудительно держится в нуле.
 */
#ifndef DSDWASM_NCURSES_STUB_H
#define DSDWASM_NCURSES_STUB_H

#include <stdbool.h>
#include <stdio.h>

typedef struct _dsdwasm_win WINDOW;
typedef unsigned long chtype;
typedef unsigned long attr_t;

extern WINDOW *stdscr;
extern int LINES, COLS;

#ifndef TRUE
#define TRUE  1
#define FALSE 0
#endif
#define ERR (-1)
#define OK  (0)

#define A_NORMAL    0UL
#define A_BOLD      0UL
#define A_REVERSE   0UL
#define A_UNDERLINE 0UL
#define A_BLINK     0UL
#define A_DIM       0UL
#define COLOR_PAIR(n) ((chtype)(n))

#define COLOR_BLACK   0
#define COLOR_RED     1
#define COLOR_GREEN   2
#define COLOR_YELLOW  3
#define COLOR_BLUE    4
#define COLOR_MAGENTA 5
#define COLOR_CYAN    6
#define COLOR_WHITE   7

#define KEY_UP    259
#define KEY_DOWN  258
#define KEY_LEFT  260
#define KEY_RIGHT 261
#define KEY_RESIZE 410

WINDOW *initscr (void);
int endwin (void);
int refresh (void);
int erase (void);
int printw (const char *fmt, ...);
int mvprintw (int y, int x, const char *fmt, ...);
int getch (void);
int start_color (void);
int use_default_colors (void);
int init_pair (short pair, short f, short b);
int has_colors (void);
int curs_set (int visibility);
int noecho (void);
int echo (void);
int cbreak (void);
int nodelay (WINDOW *w, bool bf);
int keypad (WINDOW *w, bool bf);
int attron (chtype attrs);
int attroff (chtype attrs);
int wrefresh (WINDOW *w);
int resizeterm (int lines, int columns);

#endif /* DSDWASM_NCURSES_STUB_H */
