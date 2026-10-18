// 0.5.165 (upstream b677bfce) — the CLI TUI "Create New Combo" flow pushed the
// raw /api/models record ({ provider, model, fullModel, alias }) into the combo,
// so the saved combo held objects instead of "provider/model" strings and the
// router could not resolve any of its members.
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const CLI = path.resolve(__dirname, "../../cli/src/cli");
const { comboModelId } = require(path.join(CLI, "utils/comboModelId.js"));

describe("comboModelId", () => {
  it("uses fullModel for /api/models records", () => {
    expect(comboModelId({ provider: "ag", model: "gemini-3.8-flash", fullModel: "ag/gemini-3.8-flash" }))
      .toBe("ag/gemini-3.8-flash");
  });

  it("falls back to provider/model", () => {
    expect(comboModelId({ provider: "ag", model: "gemini-3.8-flash" })).toBe("ag/gemini-3.8-flash");
  });

  it("passes a string through", () => {
    expect(comboModelId("cx/gpt-5.6")).toBe("cx/gpt-5.6");
  });

  it("rejects records with no usable identifier", () => {
    expect(comboModelId({ provider: "ag" })).toBeNull();
    expect(comboModelId({ fullModel: "" })).toBeNull();
    expect(comboModelId(null)).toBeNull();
    expect(comboModelId(undefined)).toBeNull();
    expect(comboModelId("")).toBeNull();
  });
});

// Drive the real handleCreateCombo through showCombosMenu by stubbing the CJS
// modules it requires. require.cache entries are keyed by absolute filename.
function stubModule(relPath, exports) {
  const filename = require.resolve(path.join(CLI, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
  return filename;
}

describe("TUI Create New Combo", () => {
  const stubbed = [];
  let combosPath;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const f of stubbed.splice(0)) delete require.cache[f];
    if (combosPath) delete require.cache[combosPath];
    vi.restoreAllMocks();
  });

  it("saves provider/model strings, not /api/models objects", async () => {
    const createCombo = vi.fn(async () => ({ success: true }));
    const answers = ["vision-chain", "1", "2", "done"];
    stubbed.push(
      stubModule("api/client.js", {
        getModels: async () => ({
          success: true,
          data: {
            models: [
              { provider: "ag", model: "gemini-3.8-flash", fullModel: "ag/gemini-3.8-flash", alias: "gemini-3.8-flash" },
              { provider: "cx", model: "gpt-5.6", fullModel: "cx/gpt-5.6", alias: "gpt-5.6" },
            ],
          },
        }),
        createCombo,
      }),
      stubModule("utils/input.js", {
        prompt: async () => answers.shift() ?? "cancel",
        confirm: async () => false,
        pause: async () => {},
      }),
      stubModule("utils/display.js", {
        clearScreen: () => {},
        showStatus: () => {},
        showHeader: () => {},
      }),
      stubModule("utils/modelSelector.js", { selectModelFromList: async () => null }),
      stubModule("utils/menuHelper.js", {
        showMenuWithBack: async () => {},
        showListMenu: async (opts) => opts.createAction.action(),
      }),
    );

    combosPath = require.resolve(path.join(CLI, "menus/combos.js"));
    delete require.cache[combosPath];
    const { showCombosMenu } = require(combosPath);
    await showCombosMenu([]);

    expect(createCombo).toHaveBeenCalledTimes(1);
    expect(createCombo.mock.calls[0][0]).toEqual({
      name: "vision-chain",
      models: ["ag/gemini-3.8-flash", "cx/gpt-5.6"],
    });
  });
});
