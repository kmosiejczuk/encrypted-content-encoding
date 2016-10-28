'use strict';

var crypto = require('crypto');
var base64 = require('urlsafe-base64');

var savedKeys = {};
var keyLabels = {};
var AES_GCM = 'aes-128-gcm';
var PAD_SIZE = { 'aes128gcm': 2, 'aesgcm': 2, 'aesgcm128': 1 };
var TAG_LENGTH = 16;
var KEY_LENGTH = 16;
var NONCE_LENGTH = 12;
var SHA_256_LENGTH = 32;
var MODE_ENCRYPT = 'encrypt';
var MODE_DECRYPT = 'decrypt';

var keylog;
if (process.env.ECE_KEYLOG === '1') {
  keylog = function(m, k) {
    console.warn(m + ' [' + k.length + ']: ' + base64.encode(k));
  };
} else {
  keylog = function() {};
}

function HMAC_hash(key, input) {
  var hmac = crypto.createHmac('sha256', key);
  hmac.update(input);
  return hmac.digest();
}

/* HKDF as defined in RFC5869, using SHA-256 */
function HKDF_extract(salt, ikm) {
  return HMAC_hash(salt, ikm);
}

function HKDF_expand(prk, info, l) {
  var output = new Buffer(0);
  var T = new Buffer(0);
  info = new Buffer(info, 'ascii');
  var counter = 0;
  var cbuf = new Buffer(1);
  while (output.length < l) {
    cbuf.writeUIntBE(++counter, 0, 1);
    T = HMAC_hash(prk, Buffer.concat([T, info, cbuf]));
    output = Buffer.concat([output, T]);
  }

  return output.slice(0, l);
}

function HKDF(salt, ikm, info, len) {
  return HKDF_expand(HKDF_extract(salt, ikm), info, len);
}

function info(base, context) {
  var result = Buffer.concat([
    new Buffer('Content-Encoding: ' + base + '\0', 'ascii'),
    context
  ]);
  keylog('info ' + base, result);
  return result;
}

function lengthPrefix(buffer) {
  var b = Buffer.concat([new Buffer(2), buffer]);
  b.writeUIntBE(buffer.length, 0, 2);
  return b;
}

function extractDH(keyid, share, mode) {
  if (!savedKeys[keyid]) {
    throw new Error('No known DH key for ' + keyid);
  }
  if (!keyLabels[keyid]) {
    throw new Error('No known DH key label for ' + keyid);
  }
  var key = savedKeys[keyid];
  var senderPubKey, receiverPubKey;
  if (mode === MODE_ENCRYPT) {
    senderPubKey = key.getPublicKey();
    receiverPubKey = share;
  } else if (mode === MODE_DECRYPT) {
    senderPubKey = share;
    receiverPubKey = key.getPublicKey();
  } else {
    throw new Error('Unknown mode only ' + MODE_ENCRYPT +
                    ' and ' + MODE_DECRYPT + ' supported');
  }
  return {
    secret: key.computeSecret(share),
    context: Buffer.concat([
      keyLabels[keyid],
      lengthPrefix(receiverPubKey),
      lengthPrefix(senderPubKey)
    ])
  };
}

function extractSecretAndContext(header, mode) {
  var result = { secret: null, context: new Buffer(0) };
  if (header.key) {
    result.secret = header.key;
    if (result.secret.length !== KEY_LENGTH) {
      throw new Error('An explicit key must be ' + KEY_LENGTH + ' bytes');
    }
  } else if (header.dh) { // receiver/decrypt
    result = extractDH(header.keyid, header.dh, mode);
  } else if (header.keyid) {
    result.secret = savedKeys[header.keyid];
  }
  if (!result.secret) {
    console.warn(header);
    throw new Error('Unable to determine key');
  }
  keylog('secret', result.secret);
  keylog('context', result.context);
  if (header.authSecret) {
    result.secret = HKDF(base64.decode(header.authSecret), result.secret,
                         info('auth', new Buffer(0)), SHA_256_LENGTH);
    keylog('authsecret', result.secret);
  }
  return result;
}

function deriveKeyAndNonce(header, mode) {
  if (!header.salt) {
    throw new Error('must include a salt parameter for ' + header.type);
  }
  var s = extractSecretAndContext(header, mode);
  var prk = HKDF_extract(header.salt, s.secret);
  var keyInfo;
  var nonceInfo;
  if (header.type === 'aesgcm128') {
    keyInfo = 'Content-Encoding: aesgcm128';
    nonceInfo = 'Content-Encoding: nonce';
  } else if (header.type === 'aesgcm') {
    keyInfo = info('aesgcm', s.context);
    nonceInfo = info('nonce', s.context);
  } else if (header.type === 'aes128gcm') {
    keyInfo = 'Content-Encoding: aesgcm128\0';
    nonceInfo = 'Content-Encoding: nonce\0';
  } else {
    throw new Error('Unable to set context for mode ' + params.type);
  }
  var result = {
    key: HKDF_expand(prk, keyInfo, KEY_LENGTH),
    nonce: HKDF_expand(prk, nonceInfo, NONCE_LENGTH)
  };
  keylog('key', result.key);
  keylog('nonce base', result.nonce);
  return result;
}

function determineRecordSize(rs, type) {
  rs = parseInt(rs, 10);
  if (isNaN(rs)) {
    return 4096;
  }
  var padSize = PAD_SIZE[type];
  if (rs <= padSize) {
    throw new Error('The rs parameter has to be greater than ' + padSize);
  }
  return rs;
}

function extractSalt(salt) {
  if (!salt) {
    throw new Error('A salt is required');
  }
  salt = base64.decode(salt);
  if (salt.length !== KEY_LENGTH) {
    throw new Error('The salt parameter must be ' + KEY_LENGTH + ' bytes');
  }
  return salt;
}

/* Used when decrypting aes128gcm to populate the header values. */
function readHeader(params, buffer) {
  var idsz = buffer.readUIntBE(20, 1);
  return {
    type: 'aes128gcm',
    salt: buffer.slice(0, KEY_LENGTH),
    rs: buffer.readUIntBE(KEY_LENGTH, 4),
    keyid: buffer.slice(21, 21 + idsz).toString('utf-8'),
    key: params.key ? base64.decode(params.key) : undefined,
    dh: params.dh ? base64.decode(params.dh) : undefined,
    authSecret: params.authSecret ? base64.decode(params.authSecret) : undefined
  };
}

/* Used when decrypting to populate the header values for aesgcm[128]. */
function parseParams(params) {
  console.warn(params);
  var type = (params.padSize === 1) ? 'aesgcm128' : 'aesgcm';
  return {
    type: type,
    salt: params.salt ? extractSalt(params.salt) : undefined,
    rs: determineRecordSize(params.rs, type),
    keyid: params.keyid,
    key: params.key ? base64.decode(params.key) : undefined,
    dh: params.dh ? base64.decode(params.dh) : undefined,
    authSecret: params.authSecret ? base64.decode(params.authSecret) : undefined
  };
}

function generateNonce(base, counter) {
  var nonce = new Buffer(base);
  var m = nonce.readUIntBE(nonce.length - 6, 6);
  var x = ((m ^ counter) & 0xffffff) +
      ((((m / 0x1000000) ^ (counter / 0x1000000)) & 0xffffff) * 0x1000000);
  nonce.writeUIntBE(x, nonce.length - 6, 6);
  keylog('nonce' + counter, nonce);
  return nonce;
}

function decryptRecord(key, counter, buffer, header) {
  keylog('decrypt', buffer);
  var nonce = generateNonce(key.nonce, counter);
  var gcm = crypto.createDecipheriv(AES_GCM, key.key, nonce);
  gcm.setAuthTag(buffer.slice(buffer.length - TAG_LENGTH));
  var data = gcm.update(buffer.slice(0, buffer.length - TAG_LENGTH));
  data = Buffer.concat([data, gcm.final()]);
  keylog('decrypted', data);
  var padSize = PAD_SIZE[header.type];
  var pad = data.readUIntBE(0, padSize);
  if (pad + padSize > data.length) {
    console.warn(header);
    console.warn(pad);
    console.warn(padSize);
    console.warn(data.length);
    throw new Error('padding exceeds block size');
  }
  var padCheck = new Buffer(pad);
  padCheck.fill(0);
  if (padCheck.compare(data.slice(padSize, padSize + pad)) !== 0) {
    throw new Error('invalid padding');
  }
  return data.slice(padSize + pad);
}

// TODO: this really should use the node streams stuff

/**
 * Decrypt some bytes.  This uses the parameters to determine the key and block
 * size, which are described in the draft.  Binary values are base64url encoded.
 * For an explicit key that key is used.  For a keyid on its own, the value of
 * the key is a buffer that is stored with saveKey().  For ECDH, the p256-dh
 * parameter identifies the public share of the recipient and the keyid is
 * anECDH key pair (created by crypto.createECDH()) that is stored using
 * saveKey().
 */
function decrypt(buffer, params) {
  var header;
  if (params.salt) {
    header = parseParams(params);
  } else {
    header = readHeader(buffer, params);
  }
  var key = deriveKeyAndNonce(header, MODE_DECRYPT);
  buffer = buffer.slice(header.len);
  var start = 0;
  var result = new Buffer(0);

  for (var i = 0; start < buffer.length; ++i) {
    var end = start + header.rs + TAG_LENGTH;
    if (end === buffer.length) {
      throw new Error('Truncated payload');
    }
    end = Math.min(end, buffer.length);
    if (end - start <= TAG_LENGTH) {
      throw new Error('Invalid block: too small at ' + i);
    }
    var block = decryptRecord(key, i, buffer.slice(start, end),
                              header);
    result = Buffer.concat([result, block]);
    start = end;
  }
  return result;
}

function encryptRecord(key, counter, buffer, pad, padSize) {
  keylog('encrypt', buffer);
  pad = pad || 0;
  var nonce = generateNonce(key.nonce, counter);
  var gcm = crypto.createCipheriv(AES_GCM, key.key, nonce);
  var padding = new Buffer(pad + padSize);
  padding.fill(0);
  padding.writeUIntBE(pad, 0, padSize);
  var epadding = gcm.update(padding);
  var ebuffer = gcm.update(buffer);
  gcm.final();
  var tag = gcm.getAuthTag();
  if (tag.length !== TAG_LENGTH) {
    throw new Error('invalid tag generated');
  }
  var encrypted = Buffer.concat([epadding, ebuffer, tag]);
  keylog('encrypted', encrypted);
  return encrypted;
}

function encodeHeader(header) {
  var ints = new Buffer(5);
  var keyid = Buffer.from(header.keyid || '');
  if (keyid.length > 255) {
    throw new Error('keyid is too large');
  }
  ints.writeUIntBE(header.rs, 0, 4);
  ints.writeUIntBE(keyid.length, 4, 1);
  return Buffer.concat([header.salt, ints, keyid]);
}

/**
 * Encrypt some bytes.  This uses the parameters to determine the key and block
 * size, which are described in the draft.  Note that for encryption, the
 * p256-dh parameter identifies the public share of the recipient and the keyid
 * identifies a local DH key pair (created by crypto.createECDH() or
 * crypto.createDiffieHellman()).
 */
function encrypt(buffer, params) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('buffer argument must be a Buffer');
  }
  var result;
  var header;
  header = parseParams(params);
  if (params.salt) { // old versions
    result = new Buffer(0);
  } else {
    header.type = 'aes128gcm';
    header.salt = crypto.randomBytes(KEY_LENGTH);
    result = encodeHeader(header);
  }
  header.rs = determineRecordSize(params.rs, header.type);

  var key = deriveKeyAndNonce(header, MODE_ENCRYPT);
  var start = 0;
  var padSize = PAD_SIZE[header.type];
  var pad = isNaN(parseInt(params.pad, 10)) ? 0 : parseInt(params.pad, 10);

  // Note the <= here ensures that we write out a padding-only block at the end
  // of a buffer.
  for (var i = 0; start <= buffer.length; ++i) {
    // Pad so that at least one data byte is in a block.
    var recordPad = Math.min((1 << (padSize * 8)) - 1, // maximum padding
                             Math.min(header.rs - padSize - 1, pad));
    pad -= recordPad;

    var end = Math.min(start + header.rs - padSize - recordPad, buffer.length);
    var block = encryptRecord(key, i, buffer.slice(start, end),
                              recordPad, padSize);
    result = Buffer.concat([result, block]);
    start += header.rs - padSize - recordPad;
  }
  if (pad) {
    throw new Error('Unable to pad by requested amount, ' + pad + ' remaining');
  }
  return result;
}

/**
 * This function saves a key under the provided identifier.  This is used to
 * save the keys that are used to decrypt and encrypt blobs that are identified
 * by a 'keyid'.  DH or ECDH keys that are used with the 'dh' parameter need to
 * include a label (included in 'dhLabel') that identifies them.
 */
function saveKey(id, key, dhLabel) {
  savedKeys[id] = key;
  if (dhLabel) {
    keyLabels[id] = new Buffer(dhLabel + '\0', 'ascii');
  }
}

module.exports = {
  decrypt: decrypt,
  encrypt: encrypt,
  saveKey: saveKey
};
