import config from './config.js'
import { EventEmitter } from 'events'

export default new class Utils {
  constructor () {
    this.event = new EventEmitter()
  }

  config () {
    return config.data
  }

  msleep (msec) {
    return new Promise(resolve => setTimeout(resolve, msec))
  }

  sleep (sec) {
    return this.msleep(sec * 1000)
  }
}