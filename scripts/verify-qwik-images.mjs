import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Keep validation on the patched runtime used by CI and the Docker recipe.
const [nodeMajor, nodeMinor, nodePatch] = process.versions.node
  .split(".")
  .map(Number)
assert.ok(
  (nodeMajor === 22 &&
    (nodeMinor > 23 || (nodeMinor === 23 && nodePatch >= 4))) ||
    (nodeMajor === 24 &&
      (nodeMinor > 22 || (nodeMinor === 22 && nodePatch >= 1))),
  `Unpatched or unreviewed Node.js runtime: ${process.versions.node}`
)

// Follow the build plugin's dependency chain, rather than a hoisted Sharp copy.
const scope = resolve(process.argv[2] ?? "apps/examples/qwik")
const appRequire = createRequire(resolve(scope, "package.json"))
const qwikRequire = createRequire(
  appRequire.resolve("@builder.io/qwik/optimizer")
)
const pluginRequire = createRequire(qwikRequire.resolve("vite-imagetools"))
const corePath = pluginRequire.resolve("imagetools-core")
const sharp = createRequire(corePath)("sharp")
assert.equal(
  sharp.versions.sharp,
  "0.35.5",
  "Unpatched Qwik build-image decoder"
)

const { applyTransforms, generateTransforms, builtins } = await import(
  pathToFileURL(corePath).href
)
const raster = await sharp({
  create: { width: 4, height: 4, channels: 3, background: "red" },
})
  .png()
  .toBuffer()
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="blue"/></svg>'
)
for (const input of [raster, svg]) {
  const { transforms } = generateTransforms(
    { w: "2", format: "webp" },
    builtins
  )
  const { image } = await applyTransforms(transforms, sharp(input))
  const { info } = await image.toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 2)
  assert.equal(info.height, 2)
  assert.equal(info.format, "webp")
}
console.log(
  `${scope}: Qwik image transforms passed with Sharp ${sharp.versions.sharp}, librsvg ${sharp.versions.rsvg}`
)
