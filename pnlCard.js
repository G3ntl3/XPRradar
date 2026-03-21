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

  // Load background
  let img;
  try {
    img = await Jimp.read(BG_PATH);
    // Resize to standard card size
    img.resize(1100, 550);
  } catch {
    // Fallback: solid dark purple background
    img = new Jimp(1100, 550, 0x1a0033ff);
  }

  // Dark overlay on right half for readability
  const overlayColour = Jimp.rgbaToInt(0, 0, 0, 170);
  fillRect(img, 420, 0, 680, 550, overlayColour);

  // Subtle gradient fade on left edge of overlay
  for (let x = 380; x < 420; x++) {
    const alpha = Math.round(((x - 380) / 40) * 170);
    const fade = Jimp.rgbaToInt(0, 0, 0, alpha);
    fillRect(img, x, 0, 1, 550, fade);
  }

  // Load built-in jimp font
  const fontLarge  = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const fontMed    = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const fontSmall  = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

  // Green/red font for change
  const fontGreen = await Jimp.loadFont(
    isUp ? Jimp.FONT_SANS_64_WHITE : Jimp.FONT_SANS_64_WHITE
  );

  const PX = 450;  // left edge of text panel

  // ── Token name ──────────────────────────────────────────────────────────────
  img.print(fontLarge, PX, 55, tokenName);
  img.print(fontSmall, PX, 128, `$${symbol}  ·  XPR Network  ·  SimpleDEX`);

  // Divider
  hLine(img, PX, 158, 620, Jimp.rgbaToInt(255, 255, 255, 60));

  // ── Price row ───────────────────────────────────────────────────────────────
  img.print(fontSmall, PX,       175, "PRICE THEN");
  img.print(fontSmall, PX + 300, 175, "PRICE NOW");

  img.print(fontMed, PX,       200, fmtPrice(priceThen));
  img.print(fontMed, PX + 300, 200, fmtPrice(priceNow));

  // ── Big % change ────────────────────────────────────────────────────────────
  const sign    = isUp ? "+" : "";
  const arrow   = isUp ? "▲" : "▼";
  const pctText = `${arrow} ${sign}${pctChange.toFixed(2)}%`;

  // Coloured background pill behind the number
  const pillColor = isUp
    ? Jimp.rgbaToInt(30, 200, 30, 180)
    : Jimp.rgbaToInt(200, 30, 60, 180);
  fillRect(img, PX - 8, 258, 580, 80, pillColor);

  img.print(fontLarge, PX, 265, pctText);

  // ── X multiplier ────────────────────────────────────────────────────────────
  if (xChange >= 1.1 || xChange <= 0.9) {
    const xLabel = isUp ? `+${xChange.toFixed(2)}x` : `${xChange.toFixed(2)}x`;
    img.print(fontMed, PX, 360, xLabel);
  }

  // Divider
  hLine(img, PX, 405, 620, Jimp.rgbaToInt(255, 255, 255, 60));

  // ── Timestamp ───────────────────────────────────────────────────────────────
  const d = new Date(snapTimestamp * 1000);
  const snapDate = isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  img.print(fontSmall, PX, 420, `Checked: ${snapDate}  (${timeSince(snapTimestamp)})`);

  // ── Watermark ───────────────────────────────────────────────────────────────
  img.print(fontSmall, PX, 510, "XPR Radar Bot  ·  dex.protonnz.com");

  return await img.getBufferAsync(Jimp.MIME_PNG);
}
