// 0.5.166 — combos store "provider/model" strings. /api/models returns records
// ({ provider, model, fullModel, alias }), so convert before saving; null means
// the record has no usable identifier (upstream b677bfce).
function comboModelId(model) {
  if (typeof model === "string") return model || null;
  if (typeof model?.fullModel === "string" && model.fullModel) return model.fullModel;
  if (typeof model?.provider === "string" && model.provider
    && typeof model?.model === "string" && model.model) {
    return `${model.provider}/${model.model}`;
  }
  return null;
}

module.exports = { comboModelId };
