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
    // BETA
    this.homes = new Map()
    this.flaps = new Map()
    // MAIN
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
        if (this.homes.size > 0) {
          log.info('MQTT connection re-established, republishing iDiamant...')
          this.getHomesStatus()
        } else {
          log.info('MQTT connection established, processing iDiamant...')
          await this.initHomes()
          await utils.sleep(1)
          this.getHomesStatus()
        }
      } else {
        this.mqttConnected = false
      }
    })

    utils.event.on('mqtt_message', async (topic, _message) => {
      // Parse JSON
      const message = JSON.parse(_message)
      // Construct payload
      let payload = undefined
      // Flap is in map
      if (this.flaps.has(topic)) {
        log.info(topic + ':' + JSON.stringify(message))
        const info = this.flaps.get(topic)
        payload = {
          home: {
            id: info.homeid,
            modules: [{
              id: topic,
              target_position: parseInt(message.target_position),
              bridge: info.bridgeid
            }]
          }
        }
        const status = (await this.request(HTTP_POST, '/api/setstate', null, payload))
        // Erreur ?
        if (_.isUndefined(status.body)) {
          log.info(JSON.stringify(status))
          // Refresh
          await this.getHomesStatus()
        } else {
          log.warn(JSON.stringify(status))
          // Send error status by mqtt
          const error = { id: 'error', data: status.body.errors[0] }
          utils.event.emit('frame', error)
        }
      } else {
        log.warn('Module ' + topic + ' not found')
      }
    })

    utils.event.on('refresh', async (topic, message) => {
      log.debug('Topic ' + topic + ' received')
      if (message === 'refresh') {
        // Stop poller and refresh all values
        this.pollStop()
        this.homes = new Map()
        this.flaps = new Map()
        await this.initHomes()
        this.getHomesStatus()
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
    log.info('Request new Token')
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
   * Get list of HOMES with iDiamant
   *
   * @return {object|Array} Store in this.homes
   */
  async initHomes () {
    // Get Locations
    const apihomes = (await this.request(HTTP_GET, '/api/homesdata', {}, null)).body
    // Loop through each location
    for (const home of apihomes.homes) {
      // Location with bubendorff ?
      if (!_.isArray(home.modules)) {
        log.info('Location ' + home.name +' have no Bubendorff products')
      } else {
        log.info('Location ' + home.name +': reading Bubendorff products')
        if (this.homes.has(home.id)) {
          log.debug('Existing location : ' + home.name)
        } else {
          log.debug('New location : ' + home.name)
          this.homes.set(home.id, home.name)
          // Get Names of modules
          const mods_name = new Map()
          // Loop modules from HomesData
          for (let m = 0, mlen = home.modules.length; m < mlen; m++) {
            const infos = home.modules[m]
            mods_name.set(infos.id, infos.name)
          }
          // Discovery Topic for this house
          log.debug('Get home discovery for ' + home.name)
          const status = (await this.request(HTTP_GET, '/api/homestatus', {home_id: home.id}, null)).body.home
          // Verif
          if (_.isUndefined(status) || _.isUndefined(status.modules) ) {
            log.warn('No modules returned by API')
            continue
          }
          // Parcours des modules
          for (const module of status.modules) {
            const datas = {}
            datas.home = home.name
            datas.name = mods_name.get(module.id)
            datas.type = module.type
            if (Object.prototype.hasOwnProperty.call(module, 'bridge')) {
              datas.gateway = module.bridge
            }
            if (module['target_position:step'] != null) {
              datas.position_step = module['target_position:step']
            }
            // Log Module Found
            log.debug('Module found : ' + JSON.stringify(datas))
            // Publish Discovery
            datas.id = module.id
            utils.event.emit('config', datas)
            // Subscribe to command topic if necessary
            if (module.type === 'NBR' || module.type === 'NBO' || module.type === 'NBS') {
              const topic = `${module.id}`
              log.debug('Request subscribe to topic: ' + topic)
              utils.event.emit('mqtt_subscribe', topic)
            }
            // Add to flaps map
            this.flaps.set(module.id, {homeid: home.id, bridgeid: module.bridge})
          }
        }
      }
    }
  }

  /**
   * Get status off ALL idiamant devices of ALL homes
   *
   */
  async getHomesStatus() {
    // Pas de site idiamant
    if (this.homes.size == 0) {
      log.warn('No location Bubendorff products. exiting')
      process.exit(1)
    }
    this.homes.forEach(async (value, key) => {
      const params = {
        home_id: key
      }
      log.debug('Get home status for ' + value)
      const status = (await this.request(HTTP_GET, '/api/homestatus', params, null)).body.home
      // Verif
      if (_.isUndefined(status) || _.isUndefined(status.modules) ) {
        log.warn('No modules returned by API')
        return
      }
      // Process values
      this.processHome(status.modules)
    })
    // Création boucle si besoin
    if (!this.intervalId) {
      this.intervalId = setInterval(this.getHomesStatus.bind(this), (utils.config().polling * 1000))
      log.info('iDiamant poller started')
    }
  }

  /**
   * Decode homestatus values for the given home
   *
   * @param {string} homeId Home ID
   * @param {object} modules List of modules & values
  */
  async processHome(modules) {
    // Parcours des modules
    for (const module of modules) {
      // Not Know Module
      if (!this.flaps.has(module.id)) {
        log.info(module.id + 'is unknow, please make refresh')
        const infos = { id: 'infos', data: module.id + 'is unknow, please make refresh' }
        utils.event.emit('frame', infos)
        return
      }
      // Base values
      const data = {}
      data.id = module.id
      data.reachable = (module.reachable) ? 1 : 0
      // NBR / NBO / NBS Modules
      if (Object.prototype.hasOwnProperty.call(module, 'current_position')) {
        data.position = module.current_position
      }
      if (Object.prototype.hasOwnProperty.call(module, 'battery_level')) {
        data.battery = module.battery_level
      }
      if (Object.prototype.hasOwnProperty.call(module, 'rf_strength')) {
        data.rfstatus = module.rf_strength
      }
      if (Object.prototype.hasOwnProperty.call(module, 'last_seen')) {
        data.timeutc = module.last_seen
      }
      // NBG Modules only
      if (Object.prototype.hasOwnProperty.call(module, 'wifi_strength')) {
        data.wifistatus = module.wifi_strength
      }
      // Send Frame
      utils.event.emit('frame', data)
    }
  }

  /**
   * Stop the poller
   */
  async pollStop () {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      log.debug('Poller stopped')
    }
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
      if (path === PATH_AUTH) {
        // as POST method accept only `application/x-www-form-urlencoded` content-type, transform data object into query string
        config.data = new URLSearchParams(data).toString()
      } else {
        config.data = data
      }
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