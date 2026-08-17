# Сборка dsd-fme в WebAssembly.
#
# Исходники dsd-fme и mbelib не патчатся — они лежат в third_party как есть,
# чтобы их можно было обновлять. Всё, что нужно изменить, вынесено сюда
# и в shims/.
#
# Сборка:
#   source native/emenv.sh
#   emcmake cmake -G Ninja -B native/build -S native
#   ninja -C native/build

cmake_minimum_required(VERSION 3.16)
project(dsdwasm C CXX)

set(TP  ${CMAKE_CURRENT_SOURCE_DIR}/third_party)
set(DSD ${TP}/dsd-fme)

# dsd-fme подставляет тег сборки в git_ver.c через configure_file
set(GIT_TAG "wasm-port")
configure_file(${DSD}/src/git_ver.c.in ${CMAKE_CURRENT_BINARY_DIR}/git_ver.c @ONLY)

file(GLOB DSD_SRCS ${DSD}/src/*.c ${DSD}/src/*.cpp)
list(REMOVE_ITEM DSD_SRCS
  # терминала в браузере нет — вывод пойдёт структурами в JS
  ${DSD}/src/dsd_ncurses_menu.c
  ${DSD}/src/dsd_ncurses_handler.c
  ${DSD}/src/dsd_ncurses_printer.c
  # перечисление устройств PulseAudio здесь бессмысленно
  ${DSD}/src/pa_devs.c
  ${DSD}/src/pulse_devices.c
  # RTL-SDR не нужен; заодно это единственный файл с pthread_create,
  # так что сборка получается строго однопоточной
  ${DSD}/src/rtl_sdr_fm.cpp
)

add_executable(dsd-fme
  ${DSD_SRCS}
  ${CMAKE_CURRENT_BINARY_DIR}/git_ver.c
  shims/shim.c
)

target_include_directories(dsd-fme PRIVATE
  ${DSD}/include
  ${CMAKE_CURRENT_SOURCE_DIR}/shims/include   # раньше настоящих заголовков
  ${TP}/mbelib
  ${TP}/libsndfile/include
  ${TP}/libsndfile/build-wasm/include
  ${TP}/libsndfile/build-wasm/src
)

target_link_libraries(dsd-fme
  ${TP}/mbelib/build-wasm/libmbe.a
  ${TP}/libsndfile/build-wasm/libsndfile.a
)

# dsd.h подключает <sys/soundcard.h> только под __linux__/__*BSD__/__CYGWIN__,
# которых Emscripten не определяет, — а константы SNDCTL_*/AFMT_* в коде всё
# равно встречаются. Проще всего подсунуть заглушку принудительно.
#
# -Wno-everything: на этапе разведки предупреждения чужого кода мешают читать ошибки
target_compile_options(dsd-fme PRIVATE
  -O2
  -Wno-everything
  -include ${CMAKE_CURRENT_SOURCE_DIR}/shims/include/sys/soundcard.h
)

target_link_options(dsd-fme PRIVATE
  -O2
  -sALLOW_MEMORY_GROWTH=1
  -sEXIT_RUNTIME=0
  -sASSERTIONS=1
  -sFORCE_FILESYSTEM=1
)

# Отдельная сборка под node: NODERAWFS даёт прямой доступ к файлам, чтобы
# гонять эталонные записи и сверять счётчики ошибок с нативной сборкой на Pi.
# Для браузера не годится — только для регрессионных прогонов.
add_executable(dsd-fme-node
  ${DSD_SRCS}
  ${CMAKE_CURRENT_BINARY_DIR}/git_ver.c
  shims/shim.c
)
target_include_directories(dsd-fme-node PRIVATE
  $<TARGET_PROPERTY:dsd-fme,INCLUDE_DIRECTORIES>)
target_compile_options(dsd-fme-node PRIVATE
  $<TARGET_PROPERTY:dsd-fme,COMPILE_OPTIONS>)
target_link_libraries(dsd-fme-node
  ${TP}/mbelib/build-wasm/libmbe.a
  ${TP}/libsndfile/build-wasm/libsndfile.a
)
target_link_options(dsd-fme-node PRIVATE
  -O2
  -sALLOW_MEMORY_GROWTH=1
  -sEXIT_RUNTIME=1
  -sNODERAWFS=1
)

# Рабочая сборка: ввод из кольцевого буфера, вывод обратным вызовом.
# DSDW_ASYNC_INPUT включает шов в shims/shim.c, ASYNCIFY позволяет
# pa_simple_read блокироваться, отдавая управление в JS на время ожидания.
add_executable(dsd-fme-rb
  ${DSD_SRCS}
  ${CMAKE_CURRENT_BINARY_DIR}/git_ver.c
  shims/shim.c
)
target_include_directories(dsd-fme-rb PRIVATE
  $<TARGET_PROPERTY:dsd-fme,INCLUDE_DIRECTORIES>)
target_compile_options(dsd-fme-rb PRIVATE
  $<TARGET_PROPERTY:dsd-fme,COMPILE_OPTIONS>)
target_compile_definitions(dsd-fme-rb PRIVATE DSDW_ASYNC_INPUT)
target_link_libraries(dsd-fme-rb
  ${TP}/mbelib/build-wasm/libmbe.a
  ${TP}/libsndfile/build-wasm/libsndfile.a
)
# .mjs + EXPORT_ES6: один и тот же модуль импортируется и из node (регрессия),
# и из module-воркера в браузере. Иначе пришлось бы держать две сборки.
set_target_properties(dsd-fme-rb PROPERTIES SUFFIX ".mjs")
target_link_options(dsd-fme-rb PRIVATE
  -O2
  -sALLOW_MEMORY_GROWTH=1
  -sASYNCIFY
  -sASYNCIFY_STACK_SIZE=65536
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createDsdModule
  -sINVOKE_RUN=0
  -sFORCE_FILESYSTEM=1
  -sEXPORTED_RUNTIME_METHODS=callMain,HEAP16,HEAPU8,UTF8ToString
  -sEXPORTED_FUNCTIONS=_main,_malloc,_free,_dsdw_rb_init,_dsdw_rb_write,_dsdw_rb_space,_dsdw_rb_count,_dsdw_rb_starve_ms
)
