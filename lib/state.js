import utils from './utils.js'
import fs from 'fs'
import writeFileAtomic from 'write-file-atomic'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFile } from 'fs/promises'

import { logger } from 'debug-level'
const log = logger('state')

export default new class State {
  constructor () {
    this.valid = false
    this.data = {}
    // Event listener
    utils.event.on('update_token', async (newToken) => {
      this.updateToken(newToken)
    })
  }

  async init () {
    this.file = dirname(fileURLToPath(new URL('.', import.meta.url))) + '/state.json'
    await this.loadStateData()
  }

  async loadStateData () {
    if (fs.existsSync(this.file)) {
      log.debug('Reading latest data from state file: ' + this.file)
      try {
        this.data = JSON.parse(await readFile(this.file))
        this.valid = true
      } catch (err) {
        log.error(err.message)
        log.error('Saved state file exist but could not be parsed!')
      }
    } else {
      log.warn('State file ' + this.file + ' not found. No saved state data available.')
    }
  }

  updateToken (newgeneratedToken) {
    this.data.access_token = newgeneratedToken.access_token
    this.data.refresh_token = newgeneratedToken.refresh_token
    this.data.expires_ts = Math.floor(Date.now() / 1000) + newgeneratedToken.expires_in
    try {
      writeFileAtomic(this.file, JSON.stringify(this.data))
      log.debug('Successfully saved updated state file: ' + this.file)
    } catch (err) {
      log.error('Failed to save updated state file: ' + this.file)
      log.error(err.message)
    }
  }
}()