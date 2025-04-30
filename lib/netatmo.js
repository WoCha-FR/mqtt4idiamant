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
    this.houses = new Array()
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
        if (this.houses.lenght > 0) {
          log.info('MQTT connection re-established, republishing iDiamant...')
          this.getHomesStatus()
        } else {
          log.info('MQTT connection established, processing iDiamant...')
          await this.initHomes()
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
      // Get data
      this.houses.forEach(async house => {
        const find = (element) => element.id == topic
        const info = house.modules[house.modules.findIndex(find)]
        // Si on trouve le module
        if (!_.isUndefined(info)) {
          log.info(topic + ':' + JSON.stringify(message))
          payload = {
            home: {
              id: house.homeid,
              modules: [{
                id: topic,
                target_position: parseInt(message.target_position),
                bridge: info.bridge
              }]
            }
          }
          const status = (await this.request(HTTP_POST, '/api/setstate', null, payload))
          // Erreur ?
          if (_.isUndefined(status.body)) {
            log.info(JSON.stringify(status))
          } else {
            log.warn(JSON.stringify(status))
          }
        } else {
          log.warn('Module ' + topic + ' not found')
        }
      })
    })

    utils.event.on('refresh', async (topic, message) => {
      log.debug('Topic ' + topic + ' received')
      if (message === 'refresh') {
        // Stop poller and refresh all values
        this.pollStop()
        this.houses = new Array()
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
   * @return {object|Array} Store in this.houses and this.devices
   */
  async initHomes () {
    // Get Locations
    let params = {}
    const homes = (await this.request(HTTP_GET, '/api/homesdata', params, null)).body
    // Loop through each location
    for (const home of homes.homes) {
      // Location with bubendorff
      if (!_.isArray(home.modules)) {
        log.info('Location ' + home.name +' have no Bubendorff products')
      } else {
        log.info('Location ' + home.name +': reading Bubendorff products')
        if (this.houses.find(l => l.homeid == home.id)) {
          log.debug('Existing location : ' + home.name)
        } else {
          log.debug('New location : ' + home.name)
          // List of modules
          const modinfos = new Array()
          for (let m = 0, mlen = home.modules.length; m < mlen; m++) {
            const infos = home.modules[m]
            // Add ID and NAME in modinfos
            const datas = {id: infos.id, name: infos.name}
            if (Object.prototype.hasOwnProperty.call(infos, 'bridge')) {
              datas.bridge = infos.bridge
              datas.homeid = home.id
            }
            modinfos.push(datas)
            // Subscribe topic if necessary
            if (infos.type === 'NBR' || infos.type === 'NBO' || infos.type === 'NBS') {
              const topic = `${infos.id}`
              log.debug('Request subscribe to topic: ' + topic)
              utils.event.emit('mqtt_subscribe', topic)
            }
          }
          // Save in houses constant
          this.houses.push({
            homeid: home.id,
            modules: modinfos
          })
        }
      }
    }
    log.debug('Houses : ' + JSON.stringify(this.houses))
  }

  /**
   * Get status off ALL idiamant devices of ALL homes
   *
   */
  async getHomesStatus() {
    // Pas de site idiamant
    if (this.houses.length == 0) {
      log.warn('No location Bubendorff products. exiting')
      process.exit(1)
    }
    // For each houses get existing devices
    this.houses.forEach(async house => {
      const params = {
        home_id: house.homeid
      }
      log.debug('Get home status for ' + house.homeid)
      const status = (await this.request(HTTP_GET, '/api/homestatus', params, null)).body.home
      // Verif
      if (_.isUndefined(status) || _.isUndefined(status.modules) ) {
        log.warn('No modules returned by API')
        return
      }
      this.processHome(house.homeid, status.modules)
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
  async processHome(homeId, modules) {
    // Get data of HOME
    const find = (element) => element.homeid == homeId
    const home = this.houses[this.houses.findIndex(find)]
    // Parcours des modules
    for (const module of modules) {
      // Raw module value
      // log.debug('Module found : ' + JSON.stringify(module))
      // Variable
      const data = {}
      // Home Values
      const find = (element) => element.id == module.id
      const info = home.modules[home.modules.findIndex(find)]
      // Not Know Module
      if (_.isUndefined(info)) {
        log.info('Module inconnu, merci de relancer une découverte.')
        return
      }
      // Base values
      data.id = module.id
      data.type = module.type
      data.name = info.name
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
      if (Object.prototype.hasOwnProperty.call(module, 'bridge')) {
        data.gateway = module.bridge
      }
      if (module['target_position:step'] != null) {
        data.position_step = module['target_position:step']
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