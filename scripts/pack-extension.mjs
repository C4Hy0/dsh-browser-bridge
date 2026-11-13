/**
 * Pack extension/ into one distributable .zip.
 *
 * Chrome refuses to install an off-Store .crx, so there is nothing to sign and
 * no update manifest to serve: the deliverable is a plain zip the user unzips
 * and loads with "Load unpacked". That also means dist/ is *output*: the host
 * (index.js) calls packExtension() when the user presses Download, and the
 * folder is gitignored, disposable, and safe to delete.
 *
 * The extension id must stay stable across downloads — pairing, storage.local
 * and permissions are keyed by it. Chrome derives the id from the public key in
 * the packed manifest, so the *public* half lives in the source tree
 * (`scripts/extension-public-key.txt`) and is injected here. There is
 * deliberately no private key and no signing step.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'extension')
const DIST = join(ROOT, 'dist')
const PUBLIC_KEY_FILE = join(ROOT, 'scripts', 'extension-public-key.txt')

/** Fixed name so the download and the on-disk artifact never drift apart. */
export const ZIP_NAME = 'browser-bridge-extension.zip'

/** Chrome's id: first 16 bytes of SHA-256(spki), hex nibbles mapped to a–p. */
export function extensionIdFromPublicKey(publicKeyBase64) {
  return [...createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest().subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .split('')
    .map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16)))
    .join('')
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out.sort()
}

// --- zip (store only) -------------------------------------------------------
//
// A hand-rolled stored zip keeps the plugin dependency-free. Compression would
// save bytes, but the extension is a few hundred KB and Chrome reads either.

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

function buildZip(files) {
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
  return Buffer.concat([...locals, ...centrals, end])
}

/**
 * Build dist/browser-bridge-extension.zip from extension/.
 *
 * Reuses an existing archive while it is newer than every source file, so the
 * dashboard's meta poll does not rewrite the disk every few seconds. A rebuild
 * is atomic: the zip is written to a temp name and renamed into place, so a
 * concurrent download can never serve a half-written archive.
 *
 * @returns {{ zipPath: string, bytes: number, files: number|null, id: string,
 *            version: string, publicKey: string, rebuilt: boolean }}
 */
export function packExtension({ src = SRC, dist = DIST, force = false } = {}) {
  const publicKey = readFileSync(PUBLIC_KEY_FILE, 'utf8').trim()
  if (!publicKey) throw new Error('scripts/extension-public-key.txt is empty')

  const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'))
  const zipPath = join(dist, ZIP_NAME)
  const id = extensionIdFromPublicKey(publicKey)
  const version = manifest.version

  if (!force && !extensionZipIsStale({ src, dist })) {
    return { zipPath, bytes: statSync(zipPath).size, files: null, id, version, publicKey, rebuilt: false }
  }

  manifest.key = publicKey
  const files = walk(src).map((path) => {
    const name = relative(src, path).split('\\').join('/')
    const data = name === 'manifest.json' ? Buffer.from(JSON.stringify(manifest, null, 2)) : readFileSync(path)
    return { name, data }
  })

  const zip = buildZip(files)
  mkdirSync(dist, { recursive: true })
  const temp = join(dist, `.${ZIP_NAME}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temp, zip)
  renameSync(temp, zipPath)

  return { zipPath, bytes: zip.length, files: files.length, id, version, publicKey, rebuilt: true }
}

/** True when dist/ has no zip, or the extension sources are newer than it. */
export function extensionZipIsStale({ src = SRC, dist = DIST } = {}) {
  const zipPath = join(dist, ZIP_NAME)
  try {
    const zipM = statSync(zipPath).mtimeMs
    const keyM = statSync(PUBLIC_KEY_FILE).mtimeMs
    return keyM > zipM || walk(src).some((path) => statSync(path).mtimeMs > zipM)
  } catch {
    return true
  }
}

// --- CLI --------------------------------------------------------------------

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  const info = packExtension()
  console.log(`packed ${info.files} files`)
  console.log(`  zip  ${relative(ROOT, info.zipPath)}  ${info.bytes} bytes`)
  console.log(`  id   ${info.id}  (v${info.version})`)
}
