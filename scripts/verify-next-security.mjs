import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { resolve, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

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

// Exercise the installed framework boundary in an isolated, credential-free app.
// This checks dependency behavior, not OAuth providers or deployed ingress policy.
const scopes = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "apps/dev/nextjs",
      "docs",
      "packages/next-auth",
      "apps/examples/nextjs-pages",
      "apps/examples/nextjs",
    ]
const originalImages = {}
const requireSharp = true

function supported(version) {
  const [major, minor, patch] = version.split(".").map(Number)
  return (
    !version.includes("-") &&
    ((major === 13 && minor === 5 && patch >= 11) ||
      (major === 14 && minor === 2 && patch >= 35) ||
      (major === 15 && minor === 5 && patch >= 28) ||
      (major === 16 && (minor > 4 || (minor === 4 && patch >= 1))))
  )
}

function start(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-100000)
    })
  child.on("error", (error) => {
    output += String(error)
  })
  return { child, output: () => output }
}

async function freePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

// Each Next.js optimizer configures native loader state; isolate build scopes.
if (scopes.length > 1) {
  for (const scope of scopes) {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), scope],
      { stdio: "inherit" }
    )
    const [code] = await once(child, "close")
    assert.equal(code, 0, `Security boundary failed in ${scope}`)
  }
  process.exit(0)
}

for (const scope of scopes) {
  const cwd = resolve(scope)
  const appRequire = createRequire(join(cwd, "package.json"))
  const nextVersion = appRequire("next/package.json").version
  assert.ok(
    supported(nextVersion),
    `Unpatched Next.js in ${scope}: ${nextVersion}`
  )
  if (requireSharp) {
    const optimizerPath = appRequire.resolve("next/dist/server/image-optimizer")
    const optimizer = appRequire(optimizerPath)
    const optimizerRequire = createRequire(optimizerPath)
    const sharp =
      typeof optimizer.getSharp === "function"
        ? optimizer.getSharp()
        : optimizerRequire(process.env.NEXT_SHARP_PATH || "sharp")
    assert.equal(
      sharp.versions.sharp,
      "0.35.5",
      `Unexpected optimizer-selected Sharp in ${scope}`
    )
    // Both a normal raster operation and a benign SVG exercise the native backend.
    const raster = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .png()
      .toBuffer()
    assert.equal(
      (await sharp(raster).webp().toBuffer({ resolveWithObject: true })).info
        .format,
      "webp"
    )
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="blue"/></svg>'
    )
    assert.equal(
      (await sharp(svg).png().toBuffer({ resolveWithObject: true })).info.width,
      2
    )
    console.log(
      `${scope}: Next ${nextVersion}, Sharp ${sharp.versions.sharp}, librsvg ${sharp.versions.rsvg}`
    )
  } else {
    console.log(`${scope}: Next ${nextVersion}, image optimization disabled`)
  }
  const fixture = await mkdtemp(join(tmpdir(), "next-security-"))
  let server
  try {
    await symlink(
      join(cwd, "node_modules"),
      join(fixture, "node_modules"),
      "dir"
    )
    await mkdir(join(fixture, "pages"))
    await mkdir(join(fixture, "public"))
    await writeFile(join(fixture, "package.json"), '{"private":true}')
    await writeFile(
      join(fixture, "next.config.js"),
      `module.exports = { experimental: { cpus: 1 }, images: ${JSON.stringify(originalImages)} };`
    )
    await writeFile(
      join(fixture, "pages", "index.js"),
      "export default function Page() { return <p>public fixture</p> }"
    )
    await writeFile(
      join(fixture, "pages", "private.js"),
      "export default function Page() { return <p>private fixture</p> }"
    )
    await writeFile(
      join(fixture, "middleware.js"),
      `import { NextResponse } from "next/server";
export function middleware(request) {
  return request.cookies.get("security-fixture-session")?.value === "allowed"
    ? NextResponse.next() : new NextResponse("authentication required", { status: 401 });
}
export const config = { matcher: ["/private"] };
`
    )
    await writeFile(
      join(fixture, "public", "fixture.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
        "base64"
      )
    )
    const cli = appRequire.resolve("next/dist/bin/next")
    const build = start(process.execPath, [cli, "build"], fixture)
    const [code] = await once(build.child, "close")
    assert.equal(code, 0, build.output())
    const port = await freePort()
    server = start(
      process.execPath,
      [cli, "start", "--hostname", "127.0.0.1", "--port", String(port)],
      fixture
    )
    const origin = `http://127.0.0.1:${port}`
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.child.exitCode !== null) break
      try {
        if ((await fetch(origin)).ok) {
          ready = true
          break
        }
      } catch {}
      await delay(100)
    }
    assert.ok(ready, server.output())
    assert.equal(
      (await fetch(`${origin}/private`)).status,
      401,
      "Anonymous request must be denied"
    )
    const internalHeader = {
      "x-middleware-subrequest":
        "middleware:middleware:middleware:middleware:middleware",
    }
    assert.equal(
      (await fetch(`${origin}/private`, { headers: internalHeader })).status,
      401,
      "An external internal-routing header must not bypass middleware"
    )
    for (const headers of [{}, internalHeader]) {
      const response = await fetch(`${origin}/private`, {
        headers: { ...headers, cookie: "security-fixture-session=allowed" },
      })
      assert.equal(
        response.status,
        200,
        "Legitimate session must still reach the page"
      )
      assert.match(await response.text(), /private fixture/)
    }
    assert.equal(
      (await fetch(`${origin}/fixture.png`)).status,
      200,
      "Original images remain available"
    )
    const image = await fetch(
      `${origin}/_next/image?url=%2Ffixture.png&w=64&q=75`
    )
    assert.equal(
      image.status,
      originalImages.unoptimized ? 404 : 200,
      "Image route follows the configured fallback"
    )
    console.log(
      `${scope}: production middleware denial/acceptance and image boundary passed`
    )
  } finally {
    if (
      server &&
      server.child.exitCode === null &&
      server.child.signalCode === null
    ) {
      server.child.kill("SIGTERM")
      await once(server.child, "close")
    }
    await rm(fixture, { recursive: true, force: true })
  }
}
