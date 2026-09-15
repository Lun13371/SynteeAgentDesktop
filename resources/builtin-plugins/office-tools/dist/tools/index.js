// tools — реестр тулов: подключает группы
const { registerWordTools } = require('./wordCreate')
const { registerWordReadTools } = require('./wordRead')
const { registerWordEditTools } = require('./wordEdit')
const { registerComTools } = require('./com')

function registerTools(syntee) {
  registerWordTools(syntee)
  registerWordReadTools(syntee)
  registerWordEditTools(syntee)
  registerComTools(syntee)
}

module.exports = { registerTools }
