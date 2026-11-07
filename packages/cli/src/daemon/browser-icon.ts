// The connected browser's real app icon, read from its local installation (never downloaded,
// never bundled), so the extension popup can show it. macOS: AppKit via JXA; Windows: the .exe's
// associated icon via System.Drawing. Elsewhere: none (the popup shows a letter).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessIdentity } from "@browser-control/protocol";

const run = promisify(execFile);
const SIZE = 96;
const cache = new Map<string, string | null>();

const JXA = `
ObjC.import("AppKit");
function run(argv) {
  const size = Number(argv[1]);
  const img = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1.0);
  $.NSGraphicsContext.restoreGraphicsState;
  return rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).base64EncodedStringWithOptions(0).js;
}`;

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The outermost `.app` bundle of a macOS executable path (helpers live inside the main app). */
export function macAppBundle(path: string): string | null {
  const m = /^(\/.*?\.app)(?:\/|$)/.exec(path);
  return m ? m[1]! : null;
}

/** `data:image/png;base64,…` for the browser behind a connection, or undefined. */
export async function browserIcon(proc: ProcessIdentity | undefined): Promise<string | undefined> {
  const path = proc?.path;
  if (!path) return undefined;
  const key = process.platform === "darwin" ? macAppBundle(path) : path;
  if (!key) return undefined;
  if (cache.has(key)) return cache.get(key) ?? undefined;
  let b64 = "";
  try {
    if (process.platform === "darwin") {
      ({ stdout: b64 } = await run("osascript", ["-l", "JavaScript", "-e", JXA, key, String(SIZE)], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }));
    } else if (process.platform === "win32") {
      const script = `Add-Type -AssemblyName System.Drawing; $i = [System.Drawing.Icon]::ExtractAssociatedIcon(${psQuote(key)}); $b = New-Object System.Drawing.Bitmap $i.ToBitmap(), ${SIZE}, ${SIZE}; $m = New-Object System.IO.MemoryStream; $b.Save($m, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($m.ToArray())`;
      ({ stdout: b64 } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }));
    }
  } catch {
    b64 = "";
  }
  b64 = b64.trim();
  // A PNG starts with \x89PNG → base64 "iVBORw0KGgo".
  const icon = /^iVBORw0KGgo[A-Za-z0-9+/=]+$/.test(b64) && b64.length < 300_000 ? `data:image/png;base64,${b64}` : null;
  cache.set(key, icon);
  return icon ?? undefined;
}
