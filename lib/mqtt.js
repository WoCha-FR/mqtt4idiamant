import mqtt from 'mqtt'
import utils from './utils.js'

import { logger } from 'debug-level'
const log = logger('mqtt')

export default new class MqttClient {
  #client

  constructor () {
    this.#client = false
    this.connected = false
    // Configure event listeners
    utils.event.on('netatmo_api_state', async (state) => {
      if (!this.#client && state === 'connected') {
        await utils.sleep(2)
        this.init()
      }
    })

    utils.event.on('frame', (frame) => {
      this.publishFrame(frame)
    })

    utils.event.on('mqtt_subscribe', (topic) => {
      this.#client.subscribe(topic)
    })
  }

  async init () {
    try {
      /* MQTT Options */
      const mqttOptions = {
        clientId: utils.config().mqtt_topic + '_' + Math.random().toString(16).slice(3),
        connectTimeout: 5000,
        will: { topic: utils.config().mqtt_topic + '/connected', payload: '0', retain: true },
        rejectUnauthorized: utils.config().mqtt_verifcert
      }
      // Connect
      log.debug('Attempting connection to MQTT broker...')
      this.#client = mqtt.connect(utils.config().mqtt_url, mqttOptions)
      this.start()
    } catch (err) {
      if (!err.message) {
        throw new Error(`MQTT connection error [${err}]`)
      } else {
        throw new Error(`MQTT connection error [${err.message}]`)
      }
    }
  }

  start () {
    // MQTT Events
    this.#client.on('connect', () => {
      if (!this.connected) {
        this.connected = true
        this.#client.publish(`${utils.config().mqtt_topic}/connected`, '1', { retain: true })
        utils.event.emit('mqtt_state', 'connected')
      }
    })

    this.#client.on('reconnect', () => {
      if (this.connected) {
        log.info('Connection to MQTT broker lost. Attempting to reconnect...')
      } else {
        log.info('Attempting to reconnect to MQTT broker...')
      }
      this.connected = false
      utils.event.emit('mqtt_state', 'disconnected')
    })

    this.#client.on('error', (err) => {
      log.error('Unable to connect to MQTT broker', err.message)
      this.connected = false
      utils.event.emit('mqtt_state', 'disconnected')
    })
  }

  /**
   * Publish frame to MQTT broker.
   * @param frame
   */
  publishFrame (frame) {
    const id = frame.id ? frame.id : undefined
    if (!id) {
      log.warn('Cannot publish a frame without unique id property')
      log.debug(frame)
    } else {
      const frameTopic = utils.config().mqtt_topic + '/' + id
      log.debug(`Publish frame to topic [${frameTopic}]`)
      log.trace(frame)
      try {
        this.#client.publish(frameTopic, JSON.stringify(frame))
      } catch (e) {
        log.warn(`Unable to publish frame to ${frameTopic} (${e.message})`)
      }
    }
  }
}()