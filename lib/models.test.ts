import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_MODEL,
  TEXT_MODELS,
  isTextModel,
  textModelLabel,
} from "./models";

const OPENROUTER_IDS = [
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "inclusionai/ling-3.2-flash:free",
  "baidu/ernie-5.5-flash-preview:free",
];

describe("TEXT_MODELS registry", () => {
  it("has unique model ids containing the default", () => {
    const ids = TEXT_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_TEXT_MODEL);
  });

  it("lists the OpenRouter free-tier catalog", () => {
    expect(TEXT_MODELS.map((model) => model.id)).toEqual(OPENROUTER_IDS);
    expect(DEFAULT_TEXT_MODEL).toBe("google/gemma-4-31b-it:free");
    expect(TEXT_MODELS.every((model) => model.id.endsWith(":free"))).toBe(true);
    expect(TEXT_MODELS.some((model) => model.id.startsWith("nvidia/"))).toBe(
      false
    );
  });

  it("marks only the endpoint that forces reasoning as mandatory", () => {
    for (const model of TEXT_MODELS) {
      expect(model.reasoning).toBe(
        model.id === "baidu/ernie-5.5-flash-preview:free"
          ? "mandatory"
          : undefined
      );
    }
  });

  it("labels every model", () => {
    for (const model of TEXT_MODELS) {
      expect(model.label.trim()).not.toBe("");
      expect(model.detail.trim()).not.toBe("");
    }
  });
});

describe("isTextModel", () => {
  it("accepts registered ids and rejects anything else", () => {
    for (const model of TEXT_MODELS) {
      expect(isTextModel(model.id)).toBe(true);
    }
    expect(isTextModel("nvidia/nemotron-3.5-bolt-e4b")).toBe(false);
    expect(isTextModel("gpt-4")).toBe(false);
    expect(isTextModel("")).toBe(false);
  });
});

describe("textModelLabel", () => {
  it("maps known ids to labels", () => {
    expect(textModelLabel(DEFAULT_TEXT_MODEL)).toBe(
      TEXT_MODELS.find((model) => model.id === DEFAULT_TEXT_MODEL)!.label
    );
  });

  it("passes unknown values through unchanged", () => {
    expect(textModelLabel("custom-model")).toBe("custom-model");
  });
});
