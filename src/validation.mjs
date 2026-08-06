export function toolError(tool, detail) {
  return new Error(`The ${tool} tool was called with invalid arguments: ${detail}.\nPlease rewrite the input so it satisfies the expected schema.`)
}

export function object(tool, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw toolError(tool, "arguments must be an object")
  return value
}

export function string(tool, args, key, optional = false) {
  const value = args[key]
  if (value === undefined && optional) return undefined
  if (typeof value !== "string" || (!optional && value.length === 0)) throw toolError(tool, `${key} must be a ${optional ? "string when provided" : "non-empty string"}`)
  return value
}

export function integer(tool, args, key, options = {}) {
  const value = args[key]
  if (value === undefined && options.optional) return undefined
  if (!Number.isInteger(value) || (options.min !== undefined && value < options.min) || (options.max !== undefined && value > options.max)) throw toolError(tool, `${key} must be an integer${options.min !== undefined ? ` >= ${options.min}` : ""}`)
  return value
}
