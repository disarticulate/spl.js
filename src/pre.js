Module.preRun = function () {
    if (typeof ENV !== 'undefined') {
        ENV.PROJ_LIB = '/proj';
        ENV.SPATIALITE_SECURITY = 'relaxed';
    }
    if (!ENVIRONMENT_IS_NODE) {
        WORKERFS.stream_ops.read = stream_ops_read;
        WORKERFS.createNode = createNode;
    }

    Module.FS = FS;
    Module.NODEFS = NODEFS;
    Module.MEMFS = MEMFS;
    Module.WORKERFS = WORKERFS;
    Module.ENVIRONMENT_IS_NODE = ENVIRONMENT_IS_NODE;
};


const stream_ops_read = (stream, buffer, offset, length, position) => {

    if (position >= stream.node.size || length == 0) return 0;
    if (stream.node.contents instanceof Blob || stream.node.contents instanceof File) {
        var chunk = stream.node.contents.slice(position, position + length);
        var ab = WORKERFS.reader.readAsArrayBuffer(chunk);
        buffer.set(new Uint8Array(ab), offset);
        return chunk.size;
    } else if (stream.node.contents instanceof ShareArrayBuffer) {
        const data = new Uint8Array(stream.node.sab.read(position, length));
        if (!data) {
            throw new Error(`Fetching range from ${stream.node.contents} failed.`);
        }
        buffer.set(data, offset);
        return data.length;
    }
    else {
        const data = new Uint8Array(stream.node.xhr.read(position, length));
        if (!data) {
            throw new Error(`Fetching range from ${stream.node.contents} failed.`);
        }
        buffer.set(data, offset);
        return data.length;
    }

};

const createNode = (parent, name, mode, dev, contents, mtime) => {

    const node = FS.createNode(parent, name, mode);
    node.mode = mode;
    node.node_ops = WORKERFS.node_ops;
    node.stream_ops = WORKERFS.stream_ops;
    node.timestamp = (mtime || new Date).getTime();
    assert(WORKERFS.FILE_MODE !== WORKERFS.DIR_MODE);

    if (mode === WORKERFS.FILE_MODE) {
        if (contents instanceof Blob || contents instanceof File) {
            node.size = contents.size;
            node.contents = contents;
        } else if (contents instanceof ShareArrayBuffer) {
            // implement SAB with same API as XHR
            node.sab = new SAB(contents);
            node.size = node.sab.size();
            node.contents = contents;
        } else { // must be a string/url
            assert(typeof(contents) === 'string');
            node.xhr = new XHR(contents);
            node.size = node.xhr.size();
            if (node.size < 0) {
                throw new Error(`Fetching size from ${stream.node.contents} failed.`);
            }
        }
    } else {
        node.size = 4096;
        node.contents = {};
    }
    if (parent) {
        parent.contents[name] = node;
    }
    return node;
};

// BigInt/BigUint64Array header positions (allows space and makes it easier to reason about)
// Int32Array required to communicate with SharedArrayBuffer
// Uint8Array reqiored to pass into buffer
const READY_STATE_U64 = 0
const HEADER_REQUEST_LEN_U64 = 1
const HEADER_REQUEST_POS_U64 = 2
const HEADER_REQUEST_BUF_U64 = 3

class SAB {
    // header:
    static READY_STATE_U64 = READY_STATE_U64 // for BigUint64Array
    static READY_STATE_I32 = READY_STATE_U64 * 2 // STILL zero, today.
    static READY_STATE_REQUEST_COMPLETED = 0 // multiples of 4 = Int32Array(1)
    static READY_STATE_REQUEST_SIZE = 4 // multiples of 4 = Int32Array = Int32Array(2)
    static READY_STATE_REQUEST_RANGE = 8 // multiples of 4 = Int32Array = Int32Array(3)

    //  -- length/size Uint8Array(8) = BigUint64Array(1) = Int32Array(2)    
    static HEADER_REQUEST_LEN_U64 = (HEADER_REQUEST_LEN_U64) // for BigUint64Array
    static HEADER_REQUEST_LEN_I32 = (HEADER_REQUEST_LEN_U64) * 2 // Int32Array
    static HEADER_REQUEST_LEN_U8 = (HEADER_REQUEST_LEN_U64) * 8 // Uint8Array

    //  -- position (offset) Uint8Array(8) = BigUint64Array(1) = Int32Array(2)    
    static HEADER_REQUEST_POS_U64 = HEADER_REQUEST_POS_U64 // for BigUint64Array
    static HEADER_REQUEST_POS_I32 = HEADER_REQUEST_POS_U64 * 2 // for Int32Array
    static HEADER_REQUEST_POS_U8 = HEADER_REQUEST_POS_U64 * 8 // for Uint8Array

    // -- buffer (offset)
    static HEADER_REQUEST_BUF_U64 = (HEADER_REQUEST_BUF_U64)
    static HEADER_REQUEST_BUF_I32 = (HEADER_REQUEST_BUF_U64) * 2
    
    constructor(sab) {
        this.timeout = 1000 * 60 // Not sure how quickly a response to expect; infinity if not set!
        this._size = 0;
        this.expected_pos = 0;
        this.prefetch_len = 0;
        this.buffer = new ArrayBuffer();
        this.header = new ArrayBuffer();
        this.pos = 0;
        this.sab = sab;
    }
    reset (int32) {
        int32.map((_, i) => (int32[i] = 0))
    }
    zeroLen (int32) {
        const zeros = new Int32Array(new BigUint64Array([BigInt(0)]).buffer)
        zeros.map((_, i) => (int32[SAB.HEADER_REQUEST_LEN_I32 + i] = 0))
    }
    zeroPos (int32) {
        const zeros = new Int32Array(new BigUint64Array([BigInt(0)]).buffer)
        zeros.map((_, i) => (int32[SAB.HEADER_REQUEST_POS_I32 + i] = 0))
    }
    size() {
        let retry = 0;
        let size = -1;
        const int32 = new Int32Array(this.sab);
        
        // should we wait for it to be ready? Is there a race condition?
        Atomics.wait(int32, SAB.READY_STATE_I32, SAB.READY_STATE_REQUEST_COMPLETED, this.timeout);
        // should we zero out the len prior to request? or Reset buffer?
        // this.zeroLen(int32)
        this.reset(int32);
        // userLand should be preaped:
        // -- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/waitAsync
        // -- const { async, value } = Atomics.waitAsync(int32, SAB.READY_STATE_I32, SAB.READY_STATE_REQUEST_SIZE)
        int32[SAB.READY_STATE_I32] = SAB.READY_STATE_REQUEST_SIZE;
        Atomics.notify(int32, SAB.READY_STATE_I32)
        // userLand should reply:
        // -- const int32 = new Int32Array(sab);
        // -- const size = new Int32Array(new BigUint64Array([BigInt(...fileSize...)]).buffer)
        // -- size.map((int, i) => (int32[SAB.HEADER_REQUEST_LEN_I32 + i] = int))
        // -- int32[SAB.READY_STATE_I32] = SAB.READY_STATE_REQUEST_COMPLETED
        // this is blocking the thread in the worker
         do {
            retry += 1;
            // now get the size from the SAB.
            // NOTE: We're reusing the length space of the header
            // as we have a clear signal request: SAB.READY_STATE_REQUEST_SIZE
            Atomics.wait(int32, SAB.READY_STATE_I32, SAB.READY_STATE_REQUEST_COMPLETED, this.timeout);
            // we can probably reuse the int32; not sure it matters?
            // this just reads clearer.
            const uint64 = new BigUint64Array(this.sab);
            size = uint64[SAB.HEADER_REQUEST_LEN_U64];
            // there no status to check so wed recheck the size > 0
            // try 3 times
        } while (retry <= 3 && size === BigInt(0));
        // if size is still 0n, set to -1
        // I think we can agree 0n is not a valid file size
        // one could probably figure out the minimum valid and use that as a constant
        this._size = parseInt(size) || -1;
        return size;
    }
    fetch(pos, len) {
        let buffer = null;
        let retry = 0;
        const int32 = new Int32Array(this.sab);
        do {
            retry += 1;
            // prep pos & len arrays
            const posIntI32 = new Int32Array(new BigUint64Array([BigInt(pos)]).buffer)
            const lenIntI32 = new Int32Array(new BigUint64Array([BigInt(len)]).buffer)
            // wait for completed/unused
            Atomics.wait(int32, 0, SAB.READY_STATE_REQUEST_COMPLETED, this.timeout);
            // reseting the buffer; do we need to signal this?
            this.reset(int32);
            // mapping the requested pos & len
            posIntI32.map((int, i) => (int32[SAB.HEADER_REQUEST_POS_I32 + i] = int));
            lenIntI32.map((int, i) => (int32[SAB.HEADER_REQUEST_LEN_I32 + i] = int));
            int32[SAB.READY_STATE_I32] = SAB.READY_STATE_REQUEST_RANGE;
            Atomics.notify(int32, SAB.READY_STATE_I32)
            // Userland:
            // -- const int32 = new Int32Array(sab);
            // -- const { async, value } = Atomics.waitAsync(int32, SAB.READY_STATE_I32, SAB.READY_STATE_REQUEST_RANGE)
            // -- const uint64 = new BigUint64Array(int32.buffer)
            // -- const pos = parseInt(uint64[HEADER_REQUEST_POS_U64]) // BigInt to Int
            // -- const len = parseInt(uint64[HEADER_REQUEST_LEN_U64]) // BigInt to Int
            // -- const range = new Int32Array(user_uint8.slice(pos,
            //      Math.min(
            //         user_uint8.byteLength - 1,
            //         pos + len - 1
            //      )
            //    ).buffer)
            // -- range.map((int, i) => (int32[SAB.HEADER_REQUEST_BUF_I32 + i] = int))
            // -- int32[SAB.READY_STATE_I32] = SAB.READY_STATE_REQUEST_COMPLETED;
            // -- Atomics.notify(int32, SAB.READY_STATE_I32)
            // slice after request position
            Atomics.wait(int32, SAB.READY_STATE_I32, SAB.READY_STATE_REQUEST_COMPLETED, this.timeout);
            buffer = new Uint8Array(int32.slice(SAB.HEADER_REQUEST_BUF_I32).buffer);
            // not sure if there's anything else here to do
            // the slice will return _something_; should Userland put some kind
            // of CRC or simple byte sum count, like the first
            // or you deadlock the buffer without the timeout
        } while (retry <= 3 && buffer !== null);
        return buffer;
    }
    fromHeader(pos, len) {
        if (this.header.byteLength) {
            return this.header.slice(pos, pos + len);
        }
        return null
    }

    fromBuffer(pos, len) {
        const start = pos - this.pos;
        if (start >= 0 && pos + len <= this.pos + this.buffer.byteLength) {
            return this.buffer.slice(start, start + len);
        }
        return null
    }
    read(pos, len) {
        if (pos + len <= 100) {
            let buffer = this.fromHeader(pos, len);
            if (buffer) {
                return buffer;
            }
            this.header = this.fetch(0, 100);
            return this.fromHeader(pos, len);
        }
        let buffer = this.fromBuffer(pos, len);
        if (buffer) {
            return buffer;
        }
        // https://github.com/jvail/spl.js/issues/13
        // The idea is that the more consecutive pages are read by sqlite
        // the higher the likelihood it will continue to read consecutive pages:
        // Then increase no. pages pre-fetched.
        if (pos === this.expected_pos) {
            this.prefetch_len = Math.min(len * 256, 2 * (this.prefetch_len ? this.prefetch_len : len));
        } else {
            this.prefetch_len = len;
        }
        this.expected_pos = pos + this.prefetch_len;

        this.buffer = this.fetch(pos, this.prefetch_len);
        this.pos = pos;
        return this.fromBuffer(pos, len);
    }
}

class XHR {

    constructor(url) {
        this._size = 0;
        this.expected_pos = 0;
        this.prefetch_len = 0;
        this.buffer = new ArrayBuffer();
        this.header = new ArrayBuffer();
        this.pos = 0;
        this.url = url;
        this.xhr = new XMLHttpRequest();
        this.xhr.responseType = 'arraybuffer';
    }

    size() {
        let retry = 0;
        let size = -1;
        this.xhr.onload = () => {
            size = +this.xhr.getResponseHeader('Content-Length');
        };
        do {
            retry += 1;
            this.xhr.open('HEAD', this.url, false);
            this.xhr.send(null);
        } while (retry < 3 && this.xhr.status != 200)
        this._size = size;
        return size;
    }

    fromHeader(pos, len) {
        if (this.header.byteLength) {
            return this.header.slice(pos, pos + len);
        }
        return null
    }

    fromBuffer(pos, len) {
        const start = pos - this.pos;
        if (start >= 0 && pos + len <= this.pos + this.buffer.byteLength) {
            return this.buffer.slice(start, start + len);
        }
        return null
    }

    fetch(pos, len) {
        let buffer = null;
        let retry = 0;
        this.xhr.onload = () => {
            buffer = this.xhr.response;
        };
        do {
            retry += 1;
            this.xhr.open('GET', this.url, false);
            this.xhr.setRequestHeader('Range', `bytes=${pos}-${Math.min(this._size - 1, pos + len - 1)}`);
            this.xhr.send(null);
        } while (retry < 3 && this.xhr.status != 206);
        return buffer;
    }

    read(pos, len) {
        if (pos + len <= 100) {
            let buffer = this.fromHeader(pos, len);
            if (buffer) {
                return buffer;
            }
            this.header = this.fetch(0, 100);
            return this.fromHeader(pos, len);
        }
        let buffer = this.fromBuffer(pos, len);
        if (buffer) {
            return buffer;
        }
        // https://github.com/jvail/spl.js/issues/13
        // The idea is that the more consecutive pages are read by sqlite
        // the higher the likelihood it will continue to read consecutive pages:
        // Then increase no. pages pre-fetched.
        if (pos === this.expected_pos) {
            this.prefetch_len = Math.min(len * 256, 2 * (this.prefetch_len ? this.prefetch_len : len));
        } else {
            this.prefetch_len = len;
        }
        this.expected_pos = pos + this.prefetch_len;

        this.buffer = this.fetch(pos, this.prefetch_len);
        this.pos = pos;
        return this.fromBuffer(pos, len);
    }

}
