import utils from './utils.js'
import axios from 'axios'
import _ from 'lodash'

import { logger } from 'debug-level'
const log = logger('netatmo')

// private constants
const HTTP_POST = 'POST'
const HTTP_GET = 'GET'
const PATH_AUTH = '/oauth2/token'
const baseURL = 'https://api.netatmo.com'

export default new class NetatmoClient {
  constructor () {
    this.connected = false
    this.mqttConnected = false
    this.accessToken = null
    this.refreshToken = undefined
    this.expiresInTS = 0
    // setInterval ID
    this.intervalId = null

    // Configure event listeners
    utils.event.on('mqtt_state', async (state) => {
      if (state === 'connected') {
        this.mqttConnected = true
        log.info('MQTT connection established, processing Netatmo...')
        //this.pollData()
        //await this.initRingData()
        //this.publishLocations()
      } else {
        this.mqttConnected = false
      }
    })

    
  }

  async init (state, generatedToken) {
    // Get token
    if (generatedToken) {
      this.accessToken = generatedToken.access_token
      this.refreshToken = generatedToken.refresh_token
      this.expiresInTS = Math.floor(Date.now() / 1000) + generatedToken.expires_in
      state.updateToken(generatedToken)
    } else {
      this.accessToken = state.data.access_token
      this.refreshToken = state.data.refresh_token
      this.expiresInTS = state.data.expires_ts
    }
    // Connect
    try {
      log.debug(`Attempting connection to Netatmo using ${generatedToken ? 'generated' : 'saved'} refresh token...`)
      this.connected = await this.connect()
      utils.event.emit('netatmo_api_state', 'connected')
    } catch (err) {
      this.connected = false
      log.error(err.message)
    }
    // Return
    return this.connected
  }

  async connect () {
    // 1. Access token present & TS valid
    if (this.checkAndSetAccesToken(this.accessToken, this.expiresInTS)) {
      return true
    }
    // 2. With refresh token
    if (this.refreshToken) {
      return await this.authenticateByRefreshToken(this.refreshToken)
    }
    return false
  }

  checkAndSetAccesToken (accessToken, expiresInTstamp) {
    if (accessToken && expiresInTstamp > (Date.now() / 1000)) {
      log.debug('accessToken valid')
      return true
    }
    log.info('accessToken expired')
    return false
  }

  async authenticateByRefreshToken (refreshToken) {
    log.debug('Request new Token')
    // Request new Token
    const newToken = await this.request(HTTP_POST, PATH_AUTH, null, {
      grant_type: 'refresh_token',
      client_id: utils.config().clientId,
      client_secret: utils.config().clientSecret,
      refresh_token: refreshToken
    })
    // Check Validity
    if (!newToken.access_token || !newToken.refresh_token || !newToken.expires_in) {
      throw new Error('Invalid Netatmo token')
    }
    this.accessToken = newToken.access_token
    this.refreshToken = newToken.refresh_token
    this.expiresInTS = Math.floor(Date.now() / 1000) + newToken.expires_in
    // Event store new token
    utils.event.emit('update_token', newToken)
    return true
  }


  /**
   * Request Netatmo API
   *
   * @param {string} method HTTP method (`'GET'`, `'POST'`)
   * @param {string} path API path (example: `'/api/gethomedata'`)
   * @param {object} params Parameters send as query string
   * @param {object} data Data to post
   * @param {boolean} isRetry This is the second try for this request (default false)
   * @return {object|Array} Data in response
   */
  async request (method, path, params = null, data = null, isRetry = false) {
    const config = {
      ...this.requestConfig,
      method,
      baseURL,
      url: path,
      headers: {}
    }
    if (data) {
      // as POST method accept only `application/x-www-form-urlencoded` content-type, transform data object into query string
      config.data = new URLSearchParams(data).toString()
    }
    if (params) {
      config.params = params
    }

    if (path !== PATH_AUTH) {
      if (!this.accessToken) {
        throw new Error('Access token must be provided')
      }
      config.headers.Authorization = `Bearer ${this.accessToken}`
    }

    try {
      const result = await axios(config)
      return result.data
    } catch (e) {
      if (e.response && e.response.data) {
        if (!isRetry && (e.response.status === 403 || e.response.status === 401) && e.response.data.error && e.response.data.error.code && e.response.data.error.code === 3) {
          // expired access token error, remove it and try to get a new one before a retry
          this.accessToken = null
          await this.connect()
          return await this.request(method, path, params, data, true)
        }
        if (e.response.data.error_description) {
          // bad request error
          throw new Error(`HTTP request ${path} failed: ${e.response.data.error_description} (${e.response.status})`)
        }
        if (e.response.data.error && e.response.data.error.message) {
          // standard error
          throw new Error(`HTTP request ${path} failed: ${e.response.data.error.message} (${e.response.status})`)
        }
        if (e.response.data.error) {
          // other error
          throw new Error(`HTTP request ${path} failed: ${JSON.stringify(e.response.data.error)} (${e.response.status})`)
        }
      }
      // Axios error
      throw new Error(`HTTP request ${path} failed: ${e.message}`)
    }
  }
}()