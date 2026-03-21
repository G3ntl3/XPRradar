import Jimp from "jimp";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BG_PATH   = path.join(__dirname, "pnl_bg.png");

function timeSince(ts) {
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60)    return `${secs}s`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${m}m`;
  }
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

function fmtMcap(n) {
  if (!n || n <= 0) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function blendRect(img, x, y, w, h, r, g, b, alpha) {
  const a = alpha / 255;
  const ia = 1 - a;
  for (let px = x; px < Math.min(x + w, img.bitmap.width); px++) {
    for (let py = y; py < Math.min(y + h, img.bitmap.height); py++) {
      const c = Jimp.intToRGBA(img.getPixelColor(px, py));
      img.setPixelColor(Jimp.rgbaToInt(
        Math.round(r * a + c.r * ia),
        Math.round(g * a + c.g * ia),
        Math.round(b * a + c.b * ia),
        255
      ), px, py);
    }
  }
}

export async function generatePnlCard({
  symbol, tokenName, mcapThen, mcapNow, pctChange, xChange, snapTimestamp,
}) {
  const isUp = pctChange >= 0;
  const W = 900, H = 470;

  let img;
  try {
    img = await Jimp.read(BG_PATH);
    img.resize(W, H);
  } catch {
    img = new Jimp(W, H, 0x0d001aff);
  }

  blendRect(img, 360, 0, W - 360, H, 0, 0, 10, 140);
  for (let x = 340; x < 360; x++) {
    blendRect(img, x, 0, 1, H, 0, 0, 10, Math.round(((x - 340) / 20) * 140));
  }

  const f64 = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const f32 = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const f16 = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

  const PX = 390;

  // Token symbol + name
  img.print(f64, PX, 30, symbol);
  img.print(f16, PX, 104, tokenName);

  // Divider
  blendRect(img, PX, 132, W - PX - 30, 1, 255, 255, 255, 100);

  // called at mcap — uses mcapThen
  img.print(f16, PX, 145, `called at   ${fmtMcap(mcapThen)} mcap`);

  // Giant X pill
  const sign  = isUp ? "+" : "";
  const xText = `${sign}${xChange.toFixed(2)}X`;
  blendRect(img, PX - 5, 182, W - PX - 25, 105,
    isUp ? 22 : 200, isUp ? 195 : 20, isUp ? 22 : 45, 255);
  img.print(f64, PX + 10, 197, xText);

  // % change
  img.print(f32, PX, 305, `${sign}${pctChange.toFixed(2)}%`);

  // Divider
  blendRect(img, PX, 362, W - PX - 30, 1, 255, 255, 255, 100);

  // Bottom row
  img.print(f16, PX,       378, timeSince(snapTimestamp));
  img.print(f16, PX + 180, 378, `$${symbol}   XPR Radar Bot`);
  img.print(f16, PX,       406, `dex.protonnz.com`);

  img.quality(88);
  return await img.getBufferAsync(Jimp.MIME_JPEG);
}
