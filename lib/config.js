import fs from 'fs'
import { readFile } from 'fs/promises'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

import { logger } from 'debug-level'
const log = logger('config')

export default new class Config {
  constructor () {
    this.data = {}
    this.init()
  }

  async init () {
    const configPath = dirname(fileURLToPath(new URL('.', import.meta.url))) + '/'
    this.file = configPath + 'config.json'
    // Use dev file if exists
    if (fs.existsSync(configPath + 'config.json.dev')) {
      this.file = configPath + 'config.json.dev'
      log.info('Using config.json.dev')
    }
    await this.loadConfigFile()
  }

  async loadConfigFile () {
    try {
      this.data = JSON.parse(await readFile(this.file))
      log.debug('Config: ' + JSON.stringify(this.data))
    } catch (err) {
      log.warn(err.message)
      log.warn('Configuration file could not be read, check that it exist and is valid.')
      process.exit(1)
    }
  }
}()