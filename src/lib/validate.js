'use strict';
const { E } = require('./errors');

/**
 * A small JSON-Schema-subset validator. The same schema object is used to
 * validate input AND is published verbatim as an MCP tool inputSchema, so the
 * contract Claude sees is exactly the contract the server enforces.
 *
 * Supported: type (object|string|integer|number|boolean|array), properties,
 * required, additionalProperties:false, enum, minLength, maxLength, pattern,
 * format (email|date|uri), minimum, maximum, items, minItems, maxItems.
 */
const FORMATS = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) &&
    new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v,
  uri: (v) => { try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } },
};

function check(schema, value, path, errors, opts) {
  const label = path || 'input';
  if (value === undefined || value === null) return value;
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) { errors.push(`${label} must be an object`); return value; }
      const out = {};
      const props = schema.properties || {};
      for (const key of schema.required || []) {
        const v = value[key];
        if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) errors.push(`${path ? path + '.' : ''}${key} is required`);
      }
      for (const [key, v] of Object.entries(value)) {
        if (!props[key]) {
          if (schema.additionalProperties === false && !opts.stripUnknown) errors.push(`${path ? path + '.' : ''}${key} is not a recognised field`);
          continue;
        }
        const res = check(props[key], v, path ? `${path}.${key}` : key, errors, opts);
        if (res !== undefined) out[key] = res;
      }
      return out;
    }
    case 'string': {
      if (typeof value !== 'string') { errors.push(`${label} must be a string`); return value; }
      const v = value.trim();
      if (v === '' && !opts.keepEmpty) return undefined;
      if (schema.minLength && v.length < schema.minLength) errors.push(`${label} must be at least ${schema.minLength} characters`);
      if (schema.maxLength && v.length > schema.maxLength) errors.push(`${label} must be at most ${schema.maxLength} characters`);
      if (schema.enum && !schema.enum.includes(v)) errors.push(`${label} must be one of: ${schema.enum.join(', ')}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(v)) errors.push(`${label} has an invalid format${schema.patternHint ? ` (${schema.patternHint})` : ''}`);
      if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format](v)) {
        errors.push(`${label} must be a valid ${schema.format === 'date' ? 'date in YYYY-MM-DD format' : schema.format}`);
      }
      return v;
    }
    case 'integer':
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || Number.isNaN(n)) { errors.push(`${label} must be a number`); return value; }
      if (schema.type === 'integer' && !Number.isInteger(n)) errors.push(`${label} must be a whole number`);
      if (schema.minimum !== undefined && n < schema.minimum) errors.push(`${label} must be ≥ ${schema.minimum}`);
      if (schema.maximum !== undefined && n > schema.maximum) errors.push(`${label} must be ≤ ${schema.maximum}`);
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'on' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
      errors.push(`${label} must be true or false`);
      return value;
    }
    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${label} must be an array`); return value; }
      if (schema.minItems && value.length < schema.minItems) errors.push(`${label} must contain at least ${schema.minItems} item(s)`);
      if (schema.maxItems && value.length > schema.maxItems) errors.push(`${label} must contain at most ${schema.maxItems} items`);
      return value.map((item, i) => check(schema.items || {}, item, `${label}[${i}]`, errors, opts));
    }
    default:
      return value;
  }
}

/** Validate and normalise; throws AppError(VALIDATION) listing every problem. */
function validate(schema, input, opts = {}) {
  const errors = [];
  const value = check(schema, input ?? {}, '', errors, opts);
  if (errors.length) throw E.validation(`Invalid input: ${errors.join('; ')}.`, { errors });
  return value;
}

/** Strip non-standard keys before publishing a schema to MCP clients. */
function toJsonSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'patternHint') continue;
    out[k] = typeof v === 'object' ? toJsonSchema(v) : v;
  }
  return out;
}

module.exports = { validate, toJsonSchema, FORMATS };
