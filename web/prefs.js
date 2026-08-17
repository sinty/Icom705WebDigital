/* Запоминание выбора между сессиями.
 *
 * Хранится только то, что нельзя восстановить иначе: какое звуковое устройство
 * и какой CAT-порт выбирал пользователь, плюс настройки отображения.
 * Сами разрешения браузера здесь не при чём — их держит сам браузер:
 *   - доступ к микрофону сохраняется для origin, поэтому при следующем заходе
 *     enumerateDevices() уже отдаёт метки и стабильные deviceId;
 *   - выданный однажды serial-порт возвращается navigator.serial.getPorts()
 *     без всякого жеста пользователя.
 */
const NS = 'ic705.';

export const prefs = {
  get (key, fallback = null) {
    try {
      const v = localStorage.getItem(NS + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set (key, value) {
    try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch { /* приватный режим */ }
  },
  del (key) {
    try { localStorage.removeItem(NS + key); } catch {}
  },
};

/** Разрешён ли доступ к микрофону — от этого зависит, видны ли метки устройств. */
export async function micGranted () {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state === 'granted';
  } catch {
    return false;   // Firefox и старые версии не знают этого имени
  }
}
