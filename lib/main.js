/* eslint-disable no-unused-vars */
import exithandler from './exithandler.js'
import utils from './utils.js'
import state from './state.js'
import tokenApp from './tokenapp.js'
import isOnline from 'is-online'
import NetatmoClient from './netatmo.js'
import MqttClient from './mqtt.js'

import { logger } from 'debug-level'
const log = logger('main')

export default new class Main {
  constructor () {
    // Event Listener
    utils.event.on('generated_token', (generatedToken) => {
      this.init(generatedToken)
    })
    // First Init
    this.init()
  }

  async init (generatedToken) {
    if (!state.valid) {
      await state.init()
    }
    // Token utilisable ?
    if (state.data.refresh_token || generatedToken) {
      // Wait for the network to be online and then attempt to connect to
      while (!(await isOnline())) {
        log.warn('Network is offline, waiting 10 seconds to check again...')
        await utils.sleep(10)
      }
      // Connect to netatmo
      if (!await NetatmoClient.init(state, generatedToken)) {
        log.warn('Failed to connect to Netatmo API using saved token, generate a new token using the Web UI')
        log.warn('or wait 30 seconds to automatically retry authentication using the existing token')
        tokenApp.start()
        await utils.sleep(30)
        if (!NetatmoClient.connected) {
          log.warn('Retrying authentication with existing saved token...')
          this.init()
        }
      }
    } else {
      tokenApp.start()
      console.info('No refresh token found, use the Web UI at http://<host_ip_address>:55125/ to generate a token.')
    }
  }
}()