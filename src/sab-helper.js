import { SAB } from './pre.js'

class SabHelper {
  constructor(fn, opts = { prefetchCount: 3 }) {
    // fn should take calls:
    // const { size, buffer } = await fn({ askSize, askBuffer, len, pos })
    this._fn = fn
    this.opts = opts
    // need to know buffer size
    
    this.ready =
  }
  bootstrap () {
    return new Promise(async (resolve, reject) => {
      await this.setHeader()
      this.sab = new ShareArrayBuffer(SAB.HEADER_REQUEST_BUF_U64 + this.bufferSize)
       (this.hasWaitAsync)
      ? this.awaitSize(fn)
      : this.waitSize(fn)
      resolve(this.sab)
    })
  }
  async setHeader() {
   
    // pos: 28	len: 4	Size of the database file in pages. The "in-header database size".
    // Must be a power of two between 512 and 32768 inclusive, or the value 1 representing a page size of 65536.
    // https://www.sqlite.org/fileformat.html
    // 100 bytes
    const { buffer } = await fn({ askBuffer: true, pos: 0, len: 100 })
    this._header = new DataView(buffer?.buffer ? buffer : buffer.buffer)
    return buffer
  }
  get pageSize () {
    // https://www.sqlite.org/fileformat.html
    // pos: 16 len: 2	The database page size in bytes. (Uint8)
    // pos: 8 len: 1 (Uint16)
    const pageSize = this._header.getUint16(8) === 1 ? 65536 : slice.getUint16(8)
    console.assert(this.powerOfTwo(pageSize), 'Page Size Should be a Power of 2')
    return pageSize
  }
  powerOfTwo(x) {
    return Math.log2(x) % 1 === 0
  }
  get bufferSize() {
    return this.prefetchCount * this.pageSize 
  }
  get prefetchCount () {
    return this.opts.prefetchCount 
  }
  get hasWaitAsync () {
    return !!Atomics.waitAsync
  }
}
