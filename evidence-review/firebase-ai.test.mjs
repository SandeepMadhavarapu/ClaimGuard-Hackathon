import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, SourceTextModule } from "node:vm";
import { PUBLIC_PROMPT } from "./evidence.mjs";

test("Firebase adapter constrains what each inference model receives", async () => {
  const calls = [];
  let appCheckProvider;
  let recaptchaProvider;
  let deviceInitialized = false;
  let sourceOverride;
  let localUnavailable = false;
  let deviceModeAvailable = true;
  const context = createContext({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        firebase: { appId: "test", projectId: "test", apiKey: "test" },
        recaptchaSiteKey: "test",
        recaptchaProvider,
      }),
    }),
    performance,
    log: (mode, prompt) => calls.push({ mode, prompt }),
    check: provider => { appCheckProvider = provider; },
    prepare: () => { deviceInitialized = true; },
    getSource: mode => sourceOverride ?? (mode === "only_on_device" ? "on_device" : "in_cloud"),
    localUnavailable: () => localUnavailable,
    deviceModeAvailable: () => deviceModeAvailable,
    models: [],
    constrainedFails: () => constrainedFails,
  });
  let constrainedFails = false;
  const sdk = new Map([
    ["firebase-app.js", "export const initializeApp = config => config;"],
    ["firebase-app-check.js", `
      export class ReCaptchaV3Provider { name = "v3"; }
      export class ReCaptchaEnterpriseProvider { name = "enterprise"; }
      export const initializeAppCheck = (app, { provider }) => check(provider.name);
    `],
    ["firebase-ai.js", `
      export class GoogleAIBackend {}
      export const InferenceMode = { ONLY_ON_DEVICE: deviceModeAvailable() ? "only_on_device" : undefined, ONLY_IN_CLOUD: "only_in_cloud", PREFER_ON_DEVICE: "prefer_on_device" };
      export const InferenceSource = { ON_DEVICE: "on_device", IN_CLOUD: "in_cloud" };
      export const getAI = app => app;
      export const getGenerativeModel = (ai, options) => {
        const { mode } = options;
        const constrained = Boolean(options.onDeviceParams?.promptOptions?.responseConstraint);
        models.push(options);
        return {
          initializeDeviceModel: () => prepare(),
          generateContent: async prompt => {
            if (constrained && constrainedFails()) throw new Error("Unsupported response constraint");
            log(mode, prompt);
            if (mode === "only_on_device" && localUnavailable()) throw new Error("Nano is unavailable");
            return { response: { inferenceSource: getSource(mode), text: () => "test" } };
          },
        };
      };
    `],
  ]);
  const source = await readFile(new URL("./firebase-ai.mjs", import.meta.url), "utf8");
  const mod = new SourceTextModule(source, {
    context,
    importModuleDynamically: async specifier => {
      const code = sdk.get(specifier.split("/").at(-1));
      assert.ok(code, specifier);
      const dependency = new SourceTextModule(code, { context });
      await dependency.link(() => {});
      await dependency.evaluate();
      return dependency;
    },
  });
  await mod.link(async path => {
    const code = await readFile(new URL(path, import.meta.url), "utf8");
    return new SourceTextModule(code, { context });
  });
  await mod.evaluate();
  const adapter = await mod.namespace.setupInference();
  assert.equal(appCheckProvider, "v3");
  await assert.rejects(adapter.prepareLocal(() => {}), /Prompt API is unavailable/);
  await assert.rejects(adapter.extract("PRIVATE-LETTER-CANARY"), /Prompt API is unavailable/);
  await assert.rejects(adapter.extractScan({ mimeType: "image/png", data: "PRIVATE-IMAGE-CANARY" }), /Prompt API is unavailable/);
  assert.equal(calls.length, 0);
  assert.equal(deviceInitialized, false);
  context.LanguageModel = { create() {} };
  await adapter.prepareLocal(() => {});
  assert.ok(deviceInitialized);
  assert.equal((await adapter.extract("PRIVATE-LETTER-CANARY")).source, "ON_DEVICE");
  assert.equal((await adapter.explain()).source, "IN_CLOUD");
  assert.match(calls[0].prompt, /PRIVATE-LETTER-CANARY/);
  assert.deepEqual(calls[1], { mode: "only_in_cloud", prompt: PUBLIC_PROMPT });
  sourceOverride = "in_cloud";
  await assert.rejects(adapter.extract("PRIVATE-LETTER-CANARY"), /source could not be verified/);
  assert.deepEqual(calls.map(call => call.mode), ["only_on_device", "only_in_cloud", "only_on_device"]);
  sourceOverride = undefined;
  const inlineData = { mimeType: "image/png", data: "c2Nhbi1jYW5hcnk=" };
  assert.equal((await adapter.extractScan(inlineData)).source, "ON_DEVICE");
  assert.equal(calls[3].prompt[1].inlineData, inlineData);
  localUnavailable = true;
  await assert.rejects(adapter.extractScan(inlineData), /Nano is unavailable/);
  await adapter.explain();
  assert.equal(calls[4].mode, "only_on_device");
  assert.equal(calls[5].prompt, PUBLIC_PROMPT);
  assert.equal(calls.filter(call => call.mode === "only_in_cloud").length, 2);
  assert.equal((await adapter.explainHybrid()).source, "IN_CLOUD");
  sourceOverride = "on_device";
  assert.equal((await adapter.explainHybrid()).source, "ON_DEVICE");
  sourceOverride = "unknown";
  await assert.rejects(adapter.explainHybrid(), /source could not be verified/);
  assert.deepEqual(calls.slice(6).map(call => call.mode), Array(3).fill("prefer_on_device"));
  assert.ok(calls.slice(6).every(call => call.prompt === PUBLIC_PROMPT));
  const { EXTRACTION_SCHEMA } = await import("./firebase-ai.mjs");
  const constrainedModel = context.models.find(options => options.onDeviceParams?.promptOptions?.responseConstraint);
  assert.ok(constrainedModel, "the on-device read uses a schema-constrained session");
  assert.equal(constrainedModel.mode, "only_on_device");
  assert.equal(JSON.stringify(constrainedModel.onDeviceParams.promptOptions.responseConstraint), JSON.stringify(EXTRACTION_SCHEMA));
  assert.equal(JSON.stringify(constrainedModel.onDeviceParams.createOptions.expectedOutputs), JSON.stringify([{ type: "text", languages: ["en"] }]));
  const { nextStepPrompt } = await import("./evidence.mjs");
  sourceOverride = "in_cloud";
  const nextStart = calls.length;
  assert.equal((await adapter.nextStep("CONFLICT")).source, "IN_CLOUD");
  assert.deepEqual(calls[nextStart], { mode: "prefer_on_device", prompt: nextStepPrompt("CONFLICT") });
  await assert.rejects(adapter.nextStep("DEMO-PA-240817"), /Unknown outcome code/);
  assert.equal(calls.length, nextStart + 1);
  assert.equal((await adapter.nextStep("CONFLICT", "sw")).source, "IN_CLOUD");
  assert.deepEqual(calls[nextStart + 1], { mode: "only_in_cloud", prompt: nextStepPrompt("CONFLICT", "sw") });
  await assert.rejects(adapter.nextStep("CONFLICT", "PRIVATE-LETTER-CANARY"), /Unknown language/);
  assert.equal(calls.length, nextStart + 2);
  sourceOverride = undefined;
  recaptchaProvider = "enterprise";
  await mod.namespace.setupInference();
  assert.equal(appCheckProvider, "enterprise");
  deviceModeAvailable = false;
  const withoutDeviceMode = await mod.namespace.setupInference();
  const before = calls.length;
  await assert.rejects(withoutDeviceMode.extractScan(inlineData), /cannot enforce/);
  assert.equal(calls.length, before);
  recaptchaProvider = "invalid";
  await assert.rejects(mod.namespace.setupInference(), /Unsupported reCAPTCHA provider/);
});

test("the on-device read falls back to an unconstrained session if the schema is rejected", async () => {
  const calls = [];
  const models = [];
  const context = createContext({
    fetch: async () => ({ ok: true, json: async () => ({ firebase: { appId: "t", projectId: "t", apiKey: "t" }, recaptchaSiteKey: "t" }) }),
    performance, LanguageModel: { create() {} },
    log: (mode, prompt) => calls.push({ mode, prompt }), models,
  });
  const sdk = new Map([
    ["firebase-app.js", "export const initializeApp = config => config;"],
    ["firebase-app-check.js", "export class ReCaptchaV3Provider {} export class ReCaptchaEnterpriseProvider {} export const initializeAppCheck = () => {};"],
    ["firebase-ai.js", `
      export class GoogleAIBackend {}
      export const InferenceMode = { ONLY_ON_DEVICE: "only_on_device", ONLY_IN_CLOUD: "only_in_cloud", PREFER_ON_DEVICE: "prefer_on_device" };
      export const InferenceSource = { ON_DEVICE: "on_device", IN_CLOUD: "in_cloud" };
      export const getAI = app => app;
      export const getGenerativeModel = (ai, options) => {
        models.push(options);
        const constrained = Boolean(options.onDeviceParams?.promptOptions?.responseConstraint);
        return {
          initializeDeviceModel: async () => { if (constrained) throw new Error("Unsupported response constraint"); },
          generateContent: async prompt => {
            if (constrained) throw new Error("Unsupported response constraint");
            log(options.mode, prompt);
            return { response: { inferenceSource: "on_device", text: () => "{}" } };
          },
        };
      };
    `],
  ]);
  const source = await readFile(new URL("./firebase-ai.mjs", import.meta.url), "utf8");
  const mod = new SourceTextModule(source, {
    context,
    importModuleDynamically: async specifier => {
      const dependency = new SourceTextModule(sdk.get(specifier.split("/").at(-1)), { context });
      await dependency.link(() => {});
      await dependency.evaluate();
      return dependency;
    },
  });
  await mod.link(async path => new SourceTextModule(await readFile(new URL(path, import.meta.url), "utf8"), { context }));
  await mod.evaluate();
  const adapter = await mod.namespace.setupInference();
  await adapter.prepareLocal(() => {});
  const reply = await adapter.extractScan({ mimeType: "image/png", data: "eA==" });
  assert.equal(reply.source, "ON_DEVICE");
  assert.equal(reply.constrained, false);
  assert.equal(JSON.stringify(calls.map(call => call.mode)), JSON.stringify(["only_on_device"]));
});

