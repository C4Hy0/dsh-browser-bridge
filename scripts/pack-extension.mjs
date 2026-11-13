/**
 * Pack extension/ into dist/: a .zip (load unpacked) and a signed .crx3.
 *
 * The RSA key is generated once and kept in dist/ so the extension ID is stable
 * — Chrome keys policy and update URLs by that ID. The public key is injected
 * into the packed manifest, which is what makes the ID reproducible.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'extension')
const DIST = join(ROOT, 'dist')
const KEY_FILE = join(DIST, 'extension-key.pem')
const ZIP = join(DIST, 'browser-bridge-extension.zip')
const CRX = join(DIST, 'browser-bridge-extension.crx')
const META = join(DIST, 'extension-meta.json')
const UPDATES = join(DIST, 'updates.xml')

mkdirSync(DIST, { recursive: true })

// --- key + id ---------------------------------------------------------------

if (!existsSync(KEY_FILE)) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
}
const privateKey = createPrivateKey(readFileSync(KEY_FILE))
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })

/** Chrome's id: first 16 bytes of SHA-256(pubkey), hex nibbles mapped to a–p. */
const extensionId = [...createHash('sha256').update(publicKey).digest().subarray(0, 16)]
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('')
  .split('')
  .map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16)))
  .join('')

// --- files (manifest gains the key) ----------------------------------------

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out.sort()
}

const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'))
manifest.key = publicKey.toString('base64')

const files = walk(SRC).map((path) => {
  const name = relative(SRC, path).split('\\').join('/')
  const data = name === 'manifest.json' ? Buffer.from(JSON.stringify(manifest, null, 2)) : readFileSync(path)
  return { name, data }
})

// --- zip (store only) -------------------------------------------------------

const table = new Uint32Array(256)
for (let i = 0; i < 256; i += 1) {
  let c = i
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  table[i] = c >>> 0
}
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const locals = []
const centrals = []
let offset = 0
for (const file of files) {
  const name = Buffer.from(file.name, 'utf8')
  const crc = crc32(file.data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(file.data.length, 18); local.writeUInt32LE(file.data.length, 22)
  local.writeUInt16LE(name.length, 26)
  locals.push(local, name, file.data)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(file.data.length, 20); central.writeUInt32LE(file.data.length, 24)
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42)
  centrals.push(central, name)
  offset += local.length + name.length + file.data.length
}
const centralSize = centrals.reduce((total, part) => total + part.length, 0)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16)
const zip = Buffer.concat([...locals, ...centrals, end])
writeFileSync(ZIP, zip)

// --- crx3 -------------------------------------------------------------------
// CRX3 = "Cr24" | u32 version=3 | u32 headerLen | CrxFileHeader | zip
// CrxFileHeader { sha256_with_rsa: [{ public_key, signature }] }
// signature = RSA-SHA256("CRX3 SignedData\0" | u32 pubkeyLen | pubkey | zip)

// Chrome signs \"CRX3 SignedData\0\" || u32 len(signed_header_data) || signed_header_data || zip,
// where signed_header_data is the CrxFileHeader with every signature field cleared.
const magic = Buffer.from('CRX3 SignedData\x00', 'binary')

const varint = (value) => {
  const bytes = []
  let n = value
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  bytes.push(n)
  return Buffer.from(bytes)
}
const field = (tag, payload) => Buffer.concat([Buffer.from([tag]), varint(payload.length), payload])
const publicKeyOnly = field(0x0a, publicKey)
const signedHeaderData = field(0x12, publicKeyOnly)
const lengthPrefix = Buffer.alloc(4)
lengthPrefix.writeUInt32LE(signedHeaderData.length, 0)
const signature = sign('sha256', Buffer.concat([magic, lengthPrefix, signedHeaderData, zip]), privateKey)
const proof = Buffer.concat([publicKeyOnly, field(0x12, signature)])
const header = field(0x12, proof)

const prefix = Buffer.alloc(12)
prefix.write('Cr24', 0)
prefix.writeUInt32LE(3, 4)
prefix.writeUInt32LE(header.length, 8)
const crx = Buffer.concat([prefix, header, zip])
writeFileSync(CRX, crx)

// --- metadata + update manifest --------------------------------------------

writeFileSync(META, `${JSON.stringify({
  id: extensionId,
  version: manifest.version,
  publicKey: publicKey.toString('base64'),
  zipBytes: zip.length,
  crxBytes: crx.length,
}, null, 2)}\n`)

const meta = JSON.parse(readFileSync(META, 'utf8'))
writeFileSync(UPDATES, `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${meta.id}'>
    <updatecheck codebase='__BASE__/browser-bridge/extension.crx' version='${meta.version}'/>
  </app>
</gupdate>
`)

console.log(`packed ${files.length} files`)
console.log(`  zip  ${relative(ROOT, ZIP)}  ${zip.length} bytes`)
console.log(`  crx  ${relative(ROOT, CRX)}  ${crx.length} bytes`)
console.log(`  id   ${meta.id}`)
