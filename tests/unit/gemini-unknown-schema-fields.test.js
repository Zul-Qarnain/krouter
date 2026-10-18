/**
 * 0.5.165 (upstream aafe3002 + 09f6d395) — Gemini's schema proto has no field
 * for non-standard annotation keywords, and a single occurrence anywhere in a
 * tool schema rejects the whole request with
 * "Unknown name X: Cannot find field."
 *
 * 09f6d395 is the other half: ensureObjectType() walked INTO a `properties` map
 * as if it were a schema node, so an MCP tool with a parameter literally named
 * `properties` had `type: "object"` stamped onto the map itself.
 */
import { describe, it, expect } from "vitest";
import {
  cleanJSONSchemaForAntigravity,
  UNSUPPORTED_SCHEMA_CONSTRAINTS,
} from "../../open-sse/translator/helpers/geminiHelper.js";

const clean = (schema) => cleanJSONSchemaForAntigravity(structuredClone(schema));

describe("UNSUPPORTED_SCHEMA_CONSTRAINTS covers the non-standard annotation keywords", () => {
  for (const key of [
    "errorMessage",
    "errorMessages",
    "markdownDescription",
    "doNotSuggest",
    "suggestSortText",
    "minProperties",
    "maxProperties",
    "deprecated",
  ]) {
    it(`includes ${key}`, () => {
      expect(UNSUPPORTED_SCHEMA_CONSTRAINTS).toContain(key);
    });
  }
});

describe("cleanJSONSchemaForAntigravity strips them recursively", () => {
  it("strips a top-level errorMessage", () => {
    const out = clean({ type: "object", properties: { code: { type: "integer" } }, errorMessage: "Invalid input" });
    expect(out).not.toHaveProperty("errorMessage");
  });

  it("strips errorMessage nested inside array items", () => {
    const out = clean({
      type: "object",
      properties: { tags: { type: "array", items: { type: "string", errorMessage: "Must be non-empty" } } },
    });
    expect(out.properties.tags.items).not.toHaveProperty("errorMessage");
  });

  it("strips markdownDescription from a nested property", () => {
    const out = clean({ type: "object", properties: { name: { type: "string", markdownDescription: "The **name**" } } });
    expect(out.properties.name).not.toHaveProperty("markdownDescription");
  });

  it("strips minProperties / maxProperties", () => {
    const out = clean({ type: "object", minProperties: 1, maxProperties: 10, properties: { x: { type: "string" } } });
    expect(out).not.toHaveProperty("minProperties");
    expect(out).not.toHaveProperty("maxProperties");
  });

  it("strips deprecated, doNotSuggest and suggestSortText", () => {
    const out = clean({
      type: "object",
      properties: { x: { type: "string", deprecated: true, doNotSuggest: true, suggestSortText: "zzz" } },
    });
    expect(out.properties.x).not.toHaveProperty("deprecated");
    expect(out.properties.x).not.toHaveProperty("doNotSuggest");
    expect(out.properties.x).not.toHaveProperty("suggestSortText");
  });

  it("still strips the x- vendor extensions these ship with", () => {
    const out = clean({
      type: "object",
      properties: {
        x: {
          type: "string",
          "x-errorMessage": "bad",
          "x-intellij-html-description": "<b>hi</b>",
          "x-taplo": { hidden: true },
          "x-taplo-info": { docs: "x" },
        },
      },
    });
    expect(Object.keys(out.properties.x)).toEqual(["type"]);
  });

  it("leaves valid fields intact", () => {
    const out = clean({ type: "object", description: "A valid tool", properties: { n: { type: "number", description: "A number" } } });
    expect(out.description).toBe("A valid tool");
    expect(out.properties.n.description).toBe("A number");
  });
});

describe("a tool parameter literally named 'properties' is not treated as a schema node", () => {
  it("does not stamp type:object onto the properties map itself", () => {
    const out = clean({
      type: "object",
      properties: {
        properties: { type: "object", properties: { key: { type: "string" } } },
      },
    });
    // The map that holds the single `properties` parameter must stay a plain map.
    expect(out.properties).not.toHaveProperty("type");
    expect(out.properties.properties.type).toBe("object");
    expect(out.properties.properties.properties.key.type).toBe("string");
  });

  it("still infers type:object for a real schema node that only declares properties", () => {
    const out = clean({ properties: { a: { properties: { b: { type: "string" } } } } });
    expect(out.type).toBe("object");
    expect(out.properties.a.type).toBe("object");
  });
});
