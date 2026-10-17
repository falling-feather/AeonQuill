const V1 = new Set(['schemaVersion', 'strokes'])
const V2 = new Set(['schemaVersion', 'strokes', 'morphology'])
const MORPHOLOGY = new Set(['expand', 'feather', 'trim'])
const STROKE = new Set(['id', 'mode', 'size', 'hardness', 'points'])
const POINT = new Set(['x', 'y'])

function defaultFail(code, message) { throw Object.assign(new Error(message), { code }) }

export function assertMaskRecipe(recipe, path = 'maskRecipe', fail = defaultFail) {
  const keys = (value, allowed, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_MASK_RECIPE', `${label} must be an object`)
    const unknown = Object.keys(value).filter((key) => !allowed.has(key))
    if (unknown.length) fail('UNKNOWN_FIELD', `${label} contains unsupported fields`, { fields: unknown })
  }
  const number = (value, label, minimum, maximum, integer = false) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum
      || integer && !Number.isSafeInteger(value)) fail(integer ? 'INVALID_INTEGER' : 'INVALID_NUMBER', `${label} is out of range`)
  }
  if (!recipe || typeof recipe !== 'object' || ![1, 2].includes(recipe.schemaVersion)) fail('INVALID_MASK_RECIPE', `${path}.schemaVersion must be 1 or 2`)
  keys(recipe, recipe.schemaVersion === 2 ? V2 : V1, path)
  if (recipe.schemaVersion === 2) {
    keys(recipe.morphology, MORPHOLOGY, `${path}.morphology`)
    number(recipe.morphology.expand, `${path}.morphology.expand`, -32, 32, true)
    number(recipe.morphology.feather, `${path}.morphology.feather`, 0, 32, true)
    number(recipe.morphology.trim, `${path}.morphology.trim`, 0, 127, true)
  }
  if (!Array.isArray(recipe.strokes) || recipe.strokes.length > 512) fail('INVALID_MASK_RECIPE', `${path}.strokes must contain at most 512 strokes`)
  let points = 0
  for (const [index, stroke] of recipe.strokes.entries()) {
    const label = `${path}.strokes[${index}]`
    keys(stroke, STROKE, label)
    if (typeof stroke.id !== 'string' || !stroke.id.trim() || stroke.id.length > 160) fail('INVALID_STRING', `${label}.id must be a non-empty bounded string`)
    if (!['remove', 'restore'].includes(stroke.mode)) fail('INVALID_MASK_RECIPE', `${label}.mode must be remove or restore`)
    number(stroke.size, `${label}.size`, 0.001, 0.75)
    number(stroke.hardness, `${label}.hardness`, 0, 1)
    if (!Array.isArray(stroke.points) || !stroke.points.length) fail('INVALID_MASK_RECIPE', `${label}.points must be a non-empty array`)
    points += stroke.points.length
    if (points > 20_000) fail('INVALID_MASK_RECIPE', `${path} exceeds 20000 total points`)
    for (const [pointIndex, point] of stroke.points.entries()) {
      const pointPath = `${label}.points[${pointIndex}]`
      keys(point, POINT, pointPath)
      number(point.x, `${pointPath}.x`, 0, 1)
      number(point.y, `${pointPath}.y`, 0, 1)
    }
  }
  return recipe
}
