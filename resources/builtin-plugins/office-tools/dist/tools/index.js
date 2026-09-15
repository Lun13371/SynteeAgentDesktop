// tools — реестр тулов: подключает группы
const { registerWordTools } = require('./wordCreate')
const { registerWordReadTools } = require('./wordRead')
const { registerWordEditTools } = require('./wordEdit')
const { registerWordCompareTools } = require('./wordCompare')
const { registerExcelTools } = require('./excelCreate')
const { registerExcelReadTools } = require('./excelRead')
const { registerExcelEditTools } = require('./excelEdit')
const { registerConvertTools } = require('./convert')
const { registerComTools } = require('./com')

function registerTools(syntee) {
  registerWordTools(syntee)
  registerWordReadTools(syntee)
  registerWordEditTools(syntee)
  registerWordCompareTools(syntee)
  registerExcelTools(syntee)
  registerExcelReadTools(syntee)
  registerExcelEditTools(syntee)
  registerConvertTools(syntee)
  registerComTools(syntee)
}

module.exports = { registerTools }
