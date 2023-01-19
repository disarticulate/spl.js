import { SAB } from './pre.js'

class SabHelper {
  constructor(fn) {
    // fn should take calls:
    // const { size, buffer } = await fn({ askSize, askBuffer, len, pos })
    this._fn = fn
    // need to know buffer size
    this.sab = new ShareArrayBuffer(SAB.HEADER_REQUEST_BUF_U64 + bufferSize?)
    this.ready = (this.hasWaitAsync)
      ? this.awaitSize(fn)
      : this.waitSize(fn)
  }
  get hasWaitAsync () {
    return !!Atomics.waitAsync
  }
}
