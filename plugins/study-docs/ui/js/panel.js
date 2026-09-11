// Логика панели Study Docs. Мост — js/bridge.js (synteeBridge.call / .on).
const $ = (id) => document.getElementById(id)
const call = (m, a) => synteeBridge.call(m, a)

const KIND_ICON = { docx: '📄', xlsx: '📊', pdf: '📕' }
let currentKind = 'kursovaya'

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function baseName(p) {
  return String(p || '').split(/[\\/]/).pop()
}

// «сегодня, 14:32» / «вчера, 09:10» / «5 сент»
function relDate(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const now = new Date()
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const sameDay = (a, b) => a.toDateString() === b.toDateString()
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  if (sameDay(d, now)) return 'сегодня, ' + hm
  if (sameDay(d, yest)) return 'вчера, ' + hm
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + hm
}

// ---------- рендер списка файлов
function renderFiles(files) {
  window.__sdFiles = files || []
  $('files-count').textContent = String((files || []).length)
  const box = $('files')
  if (!files || !files.length) {
    box.innerHTML =
      '<div class="sd-empty">Пока ничего не создано<br><span class="sd-empty-sub">Файлы появятся здесь после генерации</span></div>'
    return
  }
  box.innerHTML = files
    .map((f, i) => {
      const icon = KIND_ICON[f.kind] || '📄'
      const pdfBtn =
        f.kind === 'docx'
          ? '<button class="sd-mini" data-act="pdf" data-i="' + i + '" title="Конвертировать в PDF">→PDF</button>'
          : ''
      return (
        '<div class="sd-file">' +
        '<div class="sd-file-main">' +
        '<div class="sd-file-name" title="' + esc(f.path) + '">' + icon + ' ' + esc(baseName(f.path)) + '</div>' +
        '<div class="sd-file-date">' + esc(relDate(f.at)) + '</div>' +
        '</div>' +
        '<div class="sd-file-actions">' +
        pdfBtn +
        '<button class="sd-mini" data-act="open" data-i="' + i + '" title="Показать в проводнике">📁</button>' +
        '</div></div>'
      )
    })
    .join('')
}

$('files').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  const f = (window.__sdFiles || [])[Number(btn.dataset.i)]
  if (!f) return
  if (btn.dataset.act === 'pdf') {
    const old = btn.textContent
    btn.disabled = true
    btn.innerHTML = '<span class="sd-spin"></span>'
    try {
      await call('toPdf', { path: f.path })
    } catch (err) {
      console.error(err)
    }
    btn.disabled = false
    btn.textContent = old
  } else if (btn.dataset.act === 'open') {
    try {
      await call('openFolder', { path: f.path })
    } catch (err) {
      console.error(err)
    }
  }
})

// push из плагина при создании нового файла
synteeBridge.on('files', renderFiles)

// ---------- баннер черновика (docx_start/add/finish сессия)
function renderDraft(d) {
  const el = $('draft-banner')
  if (!d) {
    el.classList.add('hidden')
    return
  }
  el.classList.remove('hidden')
  $('draft-info').textContent = baseName(d.path) + ' · секций: ' + d.sections
}
synteeBridge.on('draft', renderDraft)

// ---------- сегмент-контрол типа документа
$('kind').addEventListener('click', (e) => {
  const btn = e.target.closest('.sd-seg-btn')
  if (!btn) return
  document.querySelectorAll('.sd-seg-btn').forEach((b) => b.classList.remove('active'))
  btn.classList.add('active')
  currentKind = btn.dataset.kind
  const ph = {
    kursovaya: 'Тема курсовой…',
    referat: 'Тема реферата…',
    otchet: 'Тема или название отчёта…',
    excel: 'Что за таблица? Например: расчёт лабораторной №3',
  }[currentKind]
  $('topic').placeholder = ph + ' (Enter — отправить)'
})

// ---------- создание документа
$('go').onclick = async () => {
  const topic = $('topic').value.trim()
  if (!topic) {
    $('topic').focus()
    $('topic').classList.add('sd-shake')
    setTimeout(() => $('topic').classList.remove('sd-shake'), 400)
    return
  }
  $('go').disabled = true
  $('go').innerHTML = '<span class="sd-spin"></span>Отправляю…'
  try {
    await call('newDoc', { kind: currentKind, topic })
    $('topic').value = ''
  } catch (e) {
    console.error(e)
  }
  $('go').disabled = false
  $('go').textContent = 'Сгенерировать'
}

$('topic').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('go').click()
})

// ---------- пикеры файлов
$('pick-docx').onclick = async () => {
  try { await call('attachDocx') } catch (e) { console.error(e) }
}
$('pick-xlsx').onclick = async () => {
  try { await call('attachXlsx') } catch (e) { console.error(e) }
}

// ---------- формат
function customPreview() {
  const pages = $('c-pages').value === '1' ? '· номера страниц' : ''
  return (
    $('c-font').value + ' ' + $('c-size').value + 'pt · интервал ' + $('c-spacing').value +
    ' · поля ' + [$('c-left').value, $('c-right').value, $('c-top').value, $('c-bottom').value].join('/') + ' мм ' + pages
  )
}

function updateCustomPreview() {
  $('preview-custom').textContent = customPreview()
}
;['c-font', 'c-size', 'c-spacing', 'c-pages', 'c-left', 'c-right', 'c-top', 'c-bottom'].forEach((id) => {
  $(id).addEventListener('change', updateCustomPreview)
})

document.querySelectorAll('input[name="preset"]').forEach((r) => {
  r.addEventListener('change', () => {
    const isCustom = document.querySelector('input[name="preset"]:checked').value === 'custom'
    $('custom').classList.toggle('hidden', !isCustom)
    if (isCustom) updateCustomPreview()
  })
})

$('save-format').onclick = async () => {
  const preset = document.querySelector('input[name="preset"]:checked').value
  const format = { preset }
  if (preset === 'custom') {
    format.custom = {
      font: $('c-font').value,
      fontSize: Number($('c-size').value),
      lineSpacing: Number($('c-spacing').value),
      pageNumbers: $('c-pages').value === '1',
      margins: {
        left: Number($('c-left').value),
        right: Number($('c-right').value),
        top: Number($('c-top').value),
        bottom: Number($('c-bottom').value),
      },
    }
  }
  const btn = $('save-format')
  btn.disabled = true
  try {
    await call('saveFormat', format)
  } catch (e) {
    console.error(e)
  }
  btn.disabled = false
}

$('clear').onclick = async () => {
  try { await call('clearFiles') } catch (e) { console.error(e) }
}

// ---------- инициализация
;(async () => {
  try {
    const st = await call('getState')
    renderFiles(st.files)
    renderDraft(st.draft)
    if (st.format && st.format.preset === 'custom') {
      document.querySelector('input[name="preset"][value="custom"]').checked = true
      $('custom').classList.remove('hidden')
      const c = st.format.custom || {}
      if (c.font) $('c-font').value = c.font
      if (c.fontSize) $('c-size').value = String(c.fontSize)
      if (c.lineSpacing) $('c-spacing').value = String(c.lineSpacing)
      if (c.pageNumbers === false) $('c-pages').value = '0'
      const m = c.margins || {}
      if (m.left != null) $('c-left').value = m.left
      if (m.right != null) $('c-right').value = m.right
      if (m.top != null) $('c-top').value = m.top
      if (m.bottom != null) $('c-bottom').value = m.bottom
      updateCustomPreview()
    }
  } catch (e) {
    console.error('getState failed', e)
  }
})()
