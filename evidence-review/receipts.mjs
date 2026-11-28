// Signed, tamper-evident receipts. Each step is chained (SHA-256 of the previous hash plus the
// step's canonical JSON), and the whole receipt is signed with a device key that never leaves this
// browser (Ed25519, or ECDSA P-256 where Ed25519 is unavailable). The public key travels in the
// receipt, so anyone can check it in a browser with verify.html, with no server.
//
// What this proves: the receipt was not altered after this device produced it. It does not prove
// the device itself is honest; that is what the published code and the leak gate are for.

const encoder = new TextEncoder();

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
const b64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)));
const unb64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

export async function sha256(text) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

const ALGORITHMS = [
  { name: "Ed25519", generate: { name: "Ed25519" }, sign: { name: "Ed25519" }, import: { name: "Ed25519" } },
  { name: "ECDSA-P256", generate: { name: "ECDSA", namedCurve: "P-256" }, sign: { name: "ECDSA", hash: "SHA-256" }, import: { name: "ECDSA", namedCurve: "P-256" } },
];

async function newKeyPair() {
  for (const algorithm of ALGORITHMS) {
    try {
      const pair = await crypto.subtle.generateKey(algorithm.generate, false, ["sign", "verify"]);
      return { algorithm: algorithm.name, privateKey: pair.privateKey, publicKey: pair.publicKey };
    } catch {
      // Try the next algorithm.
    }
  }
  throw new Error("No signing algorithm available");
}

// The private key is created non-extractable and kept in IndexedDB, so it can sign but never be read.
async function storedKeyPair() {
  if (typeof indexedDB === "undefined") return newKeyPair();
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("claimguard-receipts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const read = await new Promise(resolve => {
    const request = db.transaction("keys").objectStore("keys").get("device");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  if (read) return read;
  const pair = await newKeyPair();
  await new Promise(resolve => {
    const tx = db.transaction("keys", "readwrite");
    tx.objectStore("keys").put(pair, "device");
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
  return pair;
}

export async function signReceipt(receipt, keyPair = null) {
  const pair = keyPair ?? await storedKeyPair();
  let previous = "0".repeat(64);
  const chain = [];
  for (const step of receipt.steps ?? []) {
    previous = await sha256(previous + canonicalJson(step));
    chain.push(previous);
  }
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const body = { ...receipt, chain, signer: { algorithm: pair.algorithm, publicKeyJwk, keyFingerprint: (await sha256(canonicalJson(publicKeyJwk))).slice(0, 16) } };
  const algorithm = ALGORITHMS.find(entry => entry.name === pair.algorithm);
  const signature = await crypto.subtle.sign(algorithm.sign, pair.privateKey, encoder.encode(canonicalJson(body)));
  return { ...body, signature: b64(signature) };
}

// Returns { ok, checks: [{ name, ok, detail }] }.
export async function verifyReceipt(receipt) {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });
  try {
    const { signature, ...body } = receipt;
    const algorithm = ALGORITHMS.find(entry => entry.name === body.signer?.algorithm);
    add("Signer and algorithm present", Boolean(algorithm && body.signer?.publicKeyJwk && signature), body.signer?.algorithm ?? "missing");
    if (!algorithm) return { ok: false, checks };
    let previous = "0".repeat(64);
    let chainOk = Array.isArray(body.chain) && body.chain.length === (body.steps ?? []).length;
    for (const [index, step] of (body.steps ?? []).entries()) {
      previous = await sha256(previous + canonicalJson(step));
      if (body.chain?.[index] !== previous) chainOk = false;
    }
    add("Hash chain matches every step", chainOk, `${(body.steps ?? []).length} steps`);
    const fingerprint = (await sha256(canonicalJson(body.signer.publicKeyJwk))).slice(0, 16);
    add("Key fingerprint matches the public key", fingerprint === body.signer.keyFingerprint, fingerprint);
    const key = await crypto.subtle.importKey("jwk", body.signer.publicKeyJwk, algorithm.import, false, ["verify"]);
    const valid = await crypto.subtle.verify(algorithm.sign, key, unb64(signature), encoder.encode(canonicalJson(body)));
    add("Signature is valid for this exact content", valid);
    const egress = body.egress ?? [];
    const leaks = egress.filter(entry => entry.identifiers !== 0);
    add("Egress manifest: 0 identifiers in every outbound request", egress.length === 0 || leaks.length === 0,
      `${egress.length} outbound request${egress.length === 1 ? "" : "s"}`);
  } catch (error) {
    add("Receipt could be parsed", false, String(error?.message ?? error));
  }
  return { ok: checks.every(check => check.ok), checks };
}

// What left the device and what stayed, for a list of private-layout steps.
export function egressManifest(steps) {
  const egress = steps.filter(step => step.requestSha256).map(step => ({
    step: step.step, route: step.route ?? null, bytes: step.requestBytes ?? null,
    sha256: step.requestSha256, identifiers: step.identifiersInRequest ?? null,
    contains: "Form words from a fixed public vocabulary and slot names ([ID-n]). No identifier values, names or free text.",
  }));
  return {
    egress,
    stayedOnDevice: ["The scan image", "All OCR text", "Every identifier value (only slot names are sent)",
      "The reference shown to the clerk and the clerk's confirmation", "The claim fields and the claim pre-check"],
  };
}
