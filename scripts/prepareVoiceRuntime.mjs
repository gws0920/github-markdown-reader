import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDirectory = join(projectRoot, 'public', 'voice-runtime')
const manifestName = 'voice-runtime-manifest.json'
const publicRuntimeBase =
  'https://huggingface.co/datasets/gws0920/github-markdown-reader-voice-runtime/resolve/main/'
const requiredFiles = [
  'LICENSE.kokoro.txt',
  'LICENSE.sherpa-onnx.txt',
  'sherpa-onnx-tts.js',
  'sherpa-onnx-tts.worker.js',
  'sherpa-onnx-wasm-main-tts.js',
  'sherpa-onnx-wasm-main-tts.wasm',
]

/** 计算文件内容的 SHA-256，用于避免使用不完整的本地运行时。 */
async function calculateSha256(filePath) {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

/** 判断本地文件是否与运行时清单中的大小和摘要完全一致。 */
async function isValidLocalFile(filePath, metadata) {
  try {
    const content = await readFile(filePath)
    if (content.byteLength !== metadata.size) return false
    return (await calculateSha256(filePath)) === metadata.sha256
  } catch {
    return false
  }
}

/** 从公开 CDN 下载单个运行时文件，并使用临时文件保证中断时不污染有效缓存。 */
async function downloadRuntimeFile(fileName, destination) {
  const response = await fetch(`${publicRuntimeBase}${fileName}`, {
    redirect: 'follow',
  })
  if (!response.ok) {
    throw new Error(`下载 ${fileName} 失败：HTTP ${response.status}`)
  }
  const temporaryPath = `${destination}.download`
  await writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()))
  await rename(temporaryPath, destination)
}

/** 下载并解析语音运行时清单，供本地文件完整性校验使用。 */
async function downloadManifest() {
  const response = await fetch(`${publicRuntimeBase}${manifestName}`, {
    redirect: 'follow',
  })
  if (!response.ok) {
    throw new Error(`下载语音运行时清单失败：HTTP ${response.status}`)
  }
  const manifest = await response.json()
  await writeFile(
    join(runtimeDirectory, manifestName),
    `${JSON.stringify(manifest)}\n`,
  )
  return manifest
}

/** 准备本地开发所需的小型脚本和 WASM；大模型仍由 Service Worker 分片下载并续传。 */
async function prepareVoiceRuntime() {
  await mkdir(runtimeDirectory, { recursive: true })
  const manifest = await downloadManifest()

  for (const fileName of requiredFiles) {
    const metadata = manifest.files?.[fileName]
    if (!metadata) throw new Error(`语音运行时清单缺少 ${fileName}。`)
    const destination = join(runtimeDirectory, fileName)
    if (await isValidLocalFile(destination, metadata)) continue
    console.log(`[voice-runtime] 正在下载 ${fileName}`)
    await rm(`${destination}.download`, { force: true })
    await downloadRuntimeFile(fileName, destination)
    if (!(await isValidLocalFile(destination, metadata))) {
      await rm(destination, { force: true })
      throw new Error(`${fileName} 完整性校验失败。`)
    }
  }

  console.log('[voice-runtime] 本地 Worker 与 WASM 已准备完成。')
}

await prepareVoiceRuntime().catch((error) => {
  console.error('[voice-runtime] 本地运行时准备失败', error)
  process.exitCode = 1
})
