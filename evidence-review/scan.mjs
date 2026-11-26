const maxBytes = 12 * 1024 * 1024;
const maxDimension = 1700;
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

export function imageMimeType(header) {
  if (pngSignature.every((byte, index) => header[index] === byte)) return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  return null;
}

export async function prepareScan(blob) {
  if (!blob.size || blob.size > maxBytes) throw new Error("Choose an image no larger than 12 MB.");
  const header = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const mimeType = imageMimeType(header);
  if (!mimeType) throw new Error("Choose a PNG or JPEG image.");

  const bitmap = await createImageBitmap(new Blob([blob], { type: mimeType })).catch(() => {
    throw new Error("This image could not be opened. Try another PNG or JPEG.");
  });
  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(image => image ? resolve(image) : reject(new Error("The image could not be prepared.")),
        "image/jpeg", 0.94);
    });
  } finally {
    bitmap.close();
  }
}

export function scanPart(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve({ mimeType: blob.type, data: reader.result.split(",")[1] });
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.addEventListener("abort", () => reject(new Error("Image reading was canceled.")));
    reader.readAsDataURL(blob);
  });
}
