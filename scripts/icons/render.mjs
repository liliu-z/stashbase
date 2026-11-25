// Runs inside Electron: rasterises build/icon.svg through Chromium and writes
// every icon the packagers read. build.mjs launches it with a clean
// environment; under plain Node the electron import has no app to offer.
//
// One master is rendered per stroke weight and every raster is resampled from
// it with Skia's best filter, so the 16, 32 and 48 px images come from the
// heavier variants encode.mjs assigns them and everything else from the mark
// as drawn. The capture arrives at the host display's scale (2048 px on a
// retina Mac); anything square and at least MASTER_SIZE serves as the master.

import { app, BrowserWindow } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderStatusIcons } from './status.mjs';

import {
  encodeIcns,
  encodeIco,
  ICNS_ENTRIES,
  ICO_SIZES,
  MASTER_SIZE,
  PNG_SIZES,
  strokeWeights,
  weightedSvg,
} from "./encode.mjs";

const buildDirectory = fileURLToPath(new URL("../../build/", import.meta.url));

/** Reads one pixel of a capture as {r, g, b, a}. It crops first: pulling the
 *  whole bitmap of a 2048 px capture into a JS buffer twice is enough external
 *  memory churn to crash the main process during collection. */
function pixel(image, x, y) {
  const bitmap = image.crop({ height: 1, width: 1, x, y }).toBitmap();
  // Bitmaps are BGRA.
  return { a: bitmap[3], b: bitmap[0], g: bitmap[1], r: bitmap[2] };
}

/** The SVG rendered on a transparent square canvas of at least MASTER_SIZE. */
async function rasterise(svg) {
  const window = new BrowserWindow({
    backgroundColor: "#00000000",
    frame: false,
    height: MASTER_SIZE,
    show: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true },
    width: MASTER_SIZE,
  });
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${MASTER_SIZE}px;height:${MASTER_SIZE}px}</style></head><body>${svg}</body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  // Two frames: the first paints, the second guarantees the paint is done.
  await window.webContents.executeJavaScript(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const image = await window.webContents.capturePage();
  window.destroy();

  const { height, width } = image.getSize();
  if (width !== height || width < MASTER_SIZE) {
    throw new Error(`master rendered at ${width}x${height}, expected a square of at least ${MASTER_SIZE}`);
  }
  // A blank or opaque capture would resample into a plausible-looking file,
  // so check one corner outside the rounded plate and one point on the ink.
  const corner = pixel(image, 2, 2);
  const scale = width / 512;
  const ink = pixel(image, Math.round(420 * scale), Math.round(260 * scale));
  if (corner.a !== 0) throw new Error("the plate's corner is not transparent");
  if (ink.a !== 255 || ink.r > 64 || ink.g > 64 || ink.b > 64) {
    throw new Error(`no ink where the S's right edge should be (${JSON.stringify(ink)})`);
  }
  return image;
}

async function main() {
  const svg = await readFile(path.join(buildDirectory, "icon.svg"), "utf8");
  const masters = new Map();
  const masterFor = async (size) => {
    const weights = strokeWeights(size);
    const key = `${weights.ink}/${weights.frame}`;
    if (!masters.has(key)) masters.set(key, await rasterise(weightedSvg(svg, weights)));
    return masters.get(key);
  };
  const rasters = new Map();
  const pngAt = async (size) => {
    if (!rasters.has(size)) {
      const master = await masterFor(size);
      rasters.set(size, master.resize({ height: size, quality: "best", width: size }).toPNG());
    }
    return rasters.get(size);
  };

  await mkdir(path.join(buildDirectory, "icons"), { recursive: true });
  await writeFile(path.join(buildDirectory, "icon.png"), await pngAt(MASTER_SIZE));
  for (const size of PNG_SIZES) {
    await writeFile(path.join(buildDirectory, "icons", `${size}x${size}.png`), await pngAt(size));
  }
  const storeAssets = path.join(buildDirectory, 'windows-store', 'Assets');
  await mkdir(storeAssets, { recursive: true });
  for (const [name, size] of [['StoreLogo', 50], ['Square44x44Logo', 44], ['Square150x150Logo', 150]]) {
    await writeFile(path.join(storeAssets, `${name}.png`), await pngAt(size));
  }
  const icoFrames = [];
  for (const size of ICO_SIZES) icoFrames.push({ png: await pngAt(size), size });
  await writeFile(path.join(buildDirectory, "icon.ico"), encodeIco(icoFrames));
  const icnsEntries = [];
  for (const [type, size] of ICNS_ENTRIES) icnsEntries.push({ png: await pngAt(size), type });
  await writeFile(path.join(buildDirectory, "icon.icns"), encodeIcns(icnsEntries));
  await renderStatusIcons();

  const masterEdge = masters.values().next().value.getSize().width;
  return `icons: rendered ${masters.size} masters at ${masterEdge} px; wrote build/icon.png, build/icons/{${PNG_SIZES.join(",")}}, build/icon.ico (${ICO_SIZES.length} frames), build/icon.icns (${ICNS_ENTRIES.length} entries)`;
}

/** Writes a line and resolves once it has left the process: app.exit does not
 *  wait for stdout, so a summary logged just before it never reaches a pipe. */
function say(stream, line) {
  return new Promise((resolve) => stream.write(`${line}\n`, resolve));
}

app.dock?.hide();
// Destroying the render window would otherwise trigger the default quit and
// end the process, exit code 0, in the middle of writing the files.
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(main)
  .then(
    async (summary) => {
      await say(process.stdout, summary);
      app.exit(0);
    },
    async (error) => {
      await say(process.stderr, error?.stack ?? String(error));
      app.exit(1);
    },
  );
