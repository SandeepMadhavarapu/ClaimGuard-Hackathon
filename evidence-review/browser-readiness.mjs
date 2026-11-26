export async function imageModelAvailability(model = globalThis.LanguageModel) {
  if (typeof model?.availability !== "function") return "unsupported";
  try {
    return await model.availability({ expectedInputs: [{ type: "image" }] });
  } catch {
    return "unknown";
  }
}
