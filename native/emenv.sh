# Тулчейн для сборки нативных декодеров в WASM.
# Источник: source native/emenv.sh
#
# cmake и ninja ставились через pip в пользовательский каталог Store-питона,
# который сам по себе не попадает в PATH — отсюда второй export.

source /d/emsdk/emsdk_env.sh >/dev/null 2>&1
export PATH="$PATH:/c/Users/Sinty/AppData/Local/Packages/PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0/LocalCache/local-packages/Python313/Scripts"
