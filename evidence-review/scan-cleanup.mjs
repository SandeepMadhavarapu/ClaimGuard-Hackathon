import { detectDocument } from "./vendor/doc-scanner/detect.mjs";
import { warpPerspective } from "./vendor/doc-scanner/warp.mjs";

export function straightenPixels(pixels) {
  const page = detectDocument(pixels, { minArea: 0.35 });
  if (!page || page.confidence < 0.5) return null;
  return warpPerspective(pixels, page.corners, { maxSide: 1500 });
}

export async function straightenScan(image) {
  const bitmap = await createImageBitmap(image);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const corrected = straightenPixels(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (!corrected) return null;
    canvas.width = corrected.width;
    canvas.height = corrected.height;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(corrected.data), corrected.width, corrected.height), 0, 0);
    return await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  } finally {
    bitmap.close();
  }
}
