// settings — настройки плагина (storage, редактируются из панели)
const state = require('../state')

const DEFAULTS = {
  saveDir: '',              // '' → Documents\Office Tools
  openAfterCreate: false,   // открывать в Word после word_create
  showPreview: true,        // показывать карточки-виджеты в чате
  previewRows: 10,          // строк в превью таблиц
}

async function get() {
  const s = (await state.api.storage.get('settings')) || {}
  return { ...DEFAULTS, ...s }
}

async function set(patch) {
  const cur = await get()
  const next = { ...cur, ...patch }
  await state.api.storage.set('settings', next)
  return next
}

module.exports = { get, set, DEFAULTS }
