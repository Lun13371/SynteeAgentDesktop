// settings — настройки плагина: папка сохранения, превью, открытие в Word
;(function () {
  'use strict'

  var defaultDir = ''

  function showErr(msg) {
    var el = document.getElementById('ot-settings-err')
    if (el) { el.style.display = 'block'; el.textContent = msg }
  }

  function save(patch) {
    return OT.bridge.call('setSettings', patch).catch(function (e) {
      showErr('Не удалось сохранить: ' + e.message)
    })
  }

  function render(s) {
    var root = document.getElementById('ot-settings')
    var dir = s.saveDir || defaultDir || 'Documents\\Office Tools'
    root.innerHTML =
      '<div class="ot-settings">'
      + '<div class="ot-set-row">'
      + '<div class="ot-set-label">Папка сохранения</div>'
      + '<div class="ot-dir-row">'
      + '<div class="ot-dir-path" id="ot-dir-path" title="' + OT.esc(dir) + '">' + OT.esc(dir) + '</div>'
      + '<button class="ot-btn" id="ot-pick-dir">Выбрать…</button>'
      + '</div>'
      + '<div class="ot-set-hint" style="margin-top:4px">По умолчанию: Documents\\Office Tools</div>'
      + '</div>'
      + '<div class="ot-set-row">'
      + '<label class="ot-check"><input type="checkbox" id="ot-open-after"'
      + (s.openAfterCreate ? ' checked' : '')
      + '><span>Открывать документ в Word после создания</span></label>'
      + '</div>'
      + '<div class="ot-set-row">'
      + '<label class="ot-check"><input type="checkbox" id="ot-show-preview"'
      + (s.showPreview ? ' checked' : '')
      + '><span>Показывать превью в чате</span></label>'
      + '</div>'
      + '<div class="ot-set-row">'
      + '<div class="ot-set-label">Строк в превью таблиц</div>'
      + '<input type="number" class="ot-num" id="ot-preview-rows" min="3" max="50" value="'
      + (Number(s.previewRows) || 10) + '">'
      + '</div>'
      + '<div class="ot-error" id="ot-settings-err" style="display:none"></div>'
      + '</div>'
    bind()
  }

  function bind() {
    var pick = document.getElementById('ot-pick-dir')
    pick.addEventListener('click', function () {
      pick.disabled = true
      OT.bridge.call('pickSaveDir').then(function (r) {
        pick.disabled = false
        if (r && r.dir) {
          document.getElementById('ot-dir-path').textContent = r.dir
          document.getElementById('ot-dir-path').title = r.dir
        }
      }).catch(function (e) {
        pick.disabled = false
        showErr(e.message)
      })
    })

    document.getElementById('ot-open-after').addEventListener('change', function () {
      save({ openAfterCreate: this.checked })
    })

    document.getElementById('ot-show-preview').addEventListener('change', function () {
      save({ showPreview: this.checked })
    })

    document.getElementById('ot-preview-rows').addEventListener('change', function () {
      var n = parseInt(this.value, 10)
      if (isNaN(n) || n < 3) n = 3
      if (n > 50) n = 50
      this.value = n
      save({ previewRows: n })
    })
  }

  function init() {
    var root = document.getElementById('ot-settings')
    OT.bridge.call('getSettings').then(function (s) {
      return OT.bridge.call('getDefaultSaveDir').then(function (d) {
        defaultDir = d || ''
        render(s || {})
      })
    }).catch(function (e) {
      root.innerHTML = '<div class="ot-error">Ошибка загрузки настроек: ' + OT.esc(e.message) + '</div>'
    })
  }

  window.OT.settings = { init: init }
})()
