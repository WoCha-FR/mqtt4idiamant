import utils from './utils.js'
import NetatmoClient from './netatmo.js'

import { logger } from 'debug-level'
const log = logger('exitHandler')

export default new class ExitHandler {
  constructor () {
    this.init()
  }

  init () {
    process.on('exit', this.processExit.bind(null, 0))
    process.on('SIGINT', this.processExit.bind(null, 0))
    process.on('SIGTERM', this.processExit.bind(null, 0))
    process.on('uncaughtException', (err) => {
      log.error(err.message)
      log.error(err.stack)
      this.processExit(2)
    })
    process.on('unhandledRejection', (err) => {
      log.error('WARNING - Unhandled Promise Rejection')
      log.error(err)
    })
  }

  async processExit (exitCode) {
    await utils.sleep(1)
    log.info('The mqtt4idiamant process is shutting down...')
    await NetatmoClient.pollStop()
    await utils.sleep(1)
    if (exitCode || exitCode === 0) log.debug(`Exit code: ${exitCode}`)
    process.exit()
  }
}()