/**
 * PNL Card Generator — pure JS, no native dependencies
 * Uses jimp for image manipulation + @jimp/plugin-print for text
 *
 * Install: npm install jimp
 */

import Jimp from "jimp";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BG_PATH   = path.join(__dirname, "pnl_bg.png");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPrice(n) {
  if (!n) return "$0";
  if (n >= 1)      return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(10)}`;
}

function timeSince(ts) {
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// Hex colour to Jimp int
function hex(h) {
  const r = parseInt(h.slice(1,3), 16);
  const g = parseInt(h.slice(3,5), 16);
  const b = parseInt(h.slice(5,7), 16);
  return Jimp.rgbaToInt(r, g, b, 255);
}

// Draw a filled rectangle
function fillRect(img, x, y, w, h, colour) {
  for (let dx = 0; dx < w; dx++) {
    for (let dy = 0; dy < h; dy++) {
      img.setPixelColor(colour, x + dx, y + dy);
    }
  }
}

// Draw a horizontal line
function hLine(img, x, y, w, colour) {
  fillRect(img, x, y, w, 1, colour);
}

// ─── Main card generator ──────────────────────────────────────────────────────

export async function generatePnlCard({
  symbol,
  tokenName,
  priceThen,
  priceNow,
  pctChange,
  xChange,
  snapTimestamp,
}) {
  const isUp = pctChange >= 0;

  // Load background — resize to 800x400 (safe for Telegram's 10MB limit)
  let img;
  try {
    img = await Jimp.read(BG_PATH);
    img.resize(800, 400);
  } catch {
    img = new Jimp(800, 400, 0x1a0033ff);
  }

  // Dark overlay on right half for readability
  const overlayColour = Jimp.rgbaToInt(0, 0, 0, 170);
  fillRect(img, 310, 0, 490, 400, overlayColour);

  for (let x = 275; x < 310; x++) {
    const alpha = Math.round(((x - 275) / 35) * 170);
    fillRect(img, x, 0, 1, 400, Jimp.rgbaToInt(0, 0, 0, alpha));
  }

  const fontLarge = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const fontMed   = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

  const PX = 325;

  // Token name
  img.print(fontLarge, PX, 30, tokenName);
  img.print(fontMed,   PX, 72, `$${symbol}  ·  XPR Network`);

  hLine(img, PX, 100, 460, Jimp.rgbaToInt(255, 255, 255, 60));

  // Prices
  img.print(fontMed, PX,       115, "PRICE THEN");
  img.print(fontMed, PX + 220, 115, "PRICE NOW");
  img.print(fontLarge, PX,       138, fmtPrice(priceThen));
  img.print(fontLarge, PX + 220, 138, fmtPrice(priceNow));

  // Big % change pill
  const sign     = isUp ? "+" : "";
  const arrow    = isUp ? "▲" : "▼";
  const pctText  = `${arrow} ${sign}${pctChange.toFixed(2)}%`;
  const pillColor = isUp
    ? Jimp.rgbaToInt(30, 180, 30, 190)
    : Jimp.rgbaToInt(190, 30, 50, 190);
  fillRect(img, PX - 6, 188, 460, 55, pillColor);
  img.print(fontLarge, PX, 195, pctText);

  // X multiplier
  if (xChange >= 1.1 || xChange <= 0.9) {
    const xLabel = isUp ? `+${xChange.toFixed(2)}x` : `${xChange.toFixed(2)}x`;
    img.print(fontMed, PX, 258, xLabel);
  }

  hLine(img, PX, 285, 460, Jimp.rgbaToInt(255, 255, 255, 60));

  // Timestamp
  const d = new Date(snapTimestamp * 1000);
  const snapDate = isNaN(d.getTime()) ? "—" : d.toISOString().slice(0,16).replace("T"," ") + " UTC";
  img.print(fontMed, PX, 300, `Checked: ${snapDate}  (${timeSince(snapTimestamp)})`);

  // Watermark
  img.print(fontMed, PX, 365, "XPR Radar  ·  dex.protonnz.com");

  // Output as JPEG (much smaller than PNG)
  img.quality(82);
  return await img.getBufferAsync(Jimp.MIME_JPEG);
}
