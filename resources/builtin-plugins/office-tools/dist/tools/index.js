// tools — реестр тулов: подключает группы
const { registerWordTools } = require('./wordCreate')
const { registerWordReadTools } = require('./wordRead')
const { registerWordEditTools } = require('./wordEdit')
const { registerExcelTools } = require('./excelCreate')
const { registerExcelReadTools } = require('./excelRead')
const { registerExcelEditTools } = require('./excelEdit')
const { registerConvertTools } = require('./convert')
const { registerComTools } = require('./com')

function registerTools(syntee) {
  registerWordTools(syntee)
  registerWordReadTools(syntee)
  registerWordEditTools(syntee)
  registerExcelTools(syntee)
  registerExcelReadTools(syntee)
  registerExcelEditTools(syntee)
  registerConvertTools(syntee)
  registerComTools(syntee)
}

module.exports = { registerTools }
