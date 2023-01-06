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
        const sab = new Uint8Array(stream.node.contents)
        // header:
        //  -- readyState Uint8Array(1)
        //  -- length Uint8Array(8)
        //  -- offset Uint8Array(8)
        // NO OOP
        // Expect Uint8Array with 
        // ? Atomics.wait(stream.node.contents, 0, 255, 100)
        // read data when stream is ready
        // ? const data = new Uint8Array(stream.node.contents.slice(1))
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

// BigInt header positions (allows space and makes it easier to reason about)
// Int32Array required to communicate with SharedArrayBuffer
// Uint8Array reqiored to pass into buffer
const READY_STATE_U64 = 0
const HEADER_REQUEST_LEN_U64 = 1
const HEADER_REQUEST_POS_U64 = 2

class SAB {
    // header:
    //  -- readyState Uint8Array(8) = BigUint64Array(1) = Int32Array(2)
    static READY_STATE_U64 = READY_STATE_U64 // for BigUint64Array
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

    constructor(sab) {
        this.timeout = 1000 * 60 // Not sure how quickly a response to expect; infinity if not set!
        this._size = 0;
        this.expected_pos = 0;
        this.prefetch_len = 0;
        this.buffer = new ArrayBuffer();
        // this.header = new ArrayBuffer();
        this.pos = 0;
        this.sab = sab;
    }
    size() {
        let retry = 0;
        let size = -1;
        const int32 = new Int32Array(this.sab);
        // userLand should be:
        // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/waitAsync
        // -- const { async, value } = Atomics.waitAsync(int32, 0, SAB.READY_STATE_REQUEST_SIZE)
        int32[0] = SAB.READY_STATE_REQUEST_SIZE
        // userLand should reply:
        // -- const int32 = new Int32Array(sab);
        // -- const size = new Int32Array(new BigUint64Array([BigInt(...fileSize...)]).buffer)
        // size.map((i, pos) => (int32[SAB.HEADER_REQUEST_LEN_I32 + pos] = i))
        // -- int32[0] = SAB.READY_STATE_REQUEST_COMPLETED
        // this is blocking the thread in the worker
        Atomics.wait(int32, 0, SAB.READY_STATE_REQUEST_COMPLETED, this.timeout)
        //now get the size from the SAB.
        const uint64 = new BigUint64Array(this.sab)
        const size = uint64[SAB.HEADER_REQUEST_LEN_U64]
        
        
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
