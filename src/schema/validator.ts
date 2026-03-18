import { isPlainObject } from "../utils.ts";
import type { JsonSchema, ValidationIssue } from "../types.ts";

const DEFAULT_LIMITS = {
  max_schema_depth: 40,
  max_schema_nodes: 2_000,
  max_value_depth: 80,
  max_value_nodes: 20_000,
  max_enum_comparisons: 5_000
} as const;

const SUPPORTED_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null"
]);

const ALLOWED_SCHEMA_KEYS = new Set([
  "type",
  "enum",
  "required",
  "properties",
  "items",
  "additionalProperties",
  "title",
  "description",
  "default",
  "examples"
]);

interface ValidationBudget {
  schemaNodes: number;
  valueNodes: number;
  enumComparisons: number;
  schemaLimitHit: boolean;
  valueLimitHit: boolean;
  enumLimitHit: boolean;
}

export function validateSchemaShape(schema: unknown, path = "$"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(schema)) {
    issues.push({ path, message: "schema must be an object" });
    return issues;
  }
  validateSchemaNode(schema as JsonSchema, path, issues, 1, {
    schemaNodes: 0,
    valueNodes: 0,
    enumComparisons: 0,
    schemaLimitHit: false,
    valueLimitHit: false,
    enumLimitHit: false
  });
  return issues;
}

function validateSchemaNode(
  schema: JsonSchema,
  path: string,
  issues: ValidationIssue[],
  depth: number,
  budget: ValidationBudget
): void {
  if (depth > DEFAULT_LIMITS.max_schema_depth) {
    if (!budget.schemaLimitHit) {
      issues.push({ path, message: "schema exceeds maximum depth" });
      budget.schemaLimitHit = true;
    }
    return;
  }
  budget.schemaNodes += 1;
  if (budget.schemaNodes > DEFAULT_LIMITS.max_schema_nodes) {
    if (!budget.schemaLimitHit) {
      issues.push({ path, message: "schema exceeds maximum node budget" });
      budget.schemaLimitHit = true;
    }
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) {
      issues.push({ path: `${path}.${key}`, message: "keyword is not supported by the bo_staff JSON Schema subset" });
    }
  }
  if ("type" in schema) {
    if (Array.isArray(schema.type)) {
      issues.push({ path: `${path}.type`, message: "type unions are not supported" });
    } else if (typeof schema.type !== "string") {
      issues.push({ path: `${path}.type`, message: "type must be a string" });
    } else if (!SUPPORTED_SCHEMA_TYPES.has(schema.type)) {
      issues.push({ path: `${path}.type`, message: `unsupported type '${schema.type}'` });
    }
  }
  if ("required" in schema) {
    if (!Array.isArray(schema.required)) {
      issues.push({ path: `${path}.required`, message: "required must be an array" });
    } else {
      const requiredEntries = new Set<string>();
      for (const [index, entry] of schema.required.entries()) {
        if (typeof entry !== "string") {
          issues.push({ path: `${path}.required[${index}]`, message: "required entries must be strings" });
          continue;
        }
        if (requiredEntries.has(entry)) {
          issues.push({ path: `${path}.required[${index}]`, message: "required entries must be unique" });
          continue;
        }
        requiredEntries.add(entry);
      }
    }
  }
  if ("enum" in schema && !Array.isArray(schema.enum)) {
    issues.push({ path: `${path}.enum`, message: "enum must be an array" });
  }
  if ("additionalProperties" in schema && typeof schema.additionalProperties !== "boolean") {
    issues.push({ path: `${path}.additionalProperties`, message: "additionalProperties must be a boolean" });
  }
  if ("properties" in schema) {
    if (!isPlainObject(schema.properties)) {
      issues.push({ path: `${path}.properties`, message: "properties must be an object" });
    } else {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (!isPlainObject(child)) {
          issues.push({ path: `${path}.properties.${key}`, message: "property schema must be an object" });
          continue;
        }
        validateSchemaNode(child, `${path}.properties.${key}`, issues, depth + 1, budget);
      }
    }
  }
  if ("items" in schema && Array.isArray(schema.items)) {
    issues.push({ path: `${path}.items`, message: "tuple-style items are not supported" });
  } else if ("items" in schema && schema.items !== undefined && !isPlainObject(schema.items)) {
    issues.push({ path: `${path}.items`, message: "items must be an object" });
  } else if (isPlainObject(schema.items)) {
    validateSchemaNode(schema.items, `${path}.items`, issues, depth + 1, budget);
  }
}

export function validateAgainstSchema(schema: JsonSchema, value: unknown, path = "$"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateValue(schema, value, path, issues, 1, {
    schemaNodes: 0,
    valueNodes: 0,
    enumComparisons: 0,
    schemaLimitHit: false,
    valueLimitHit: false,
    enumLimitHit: false
  });
  return issues;
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  depth: number,
  budget: ValidationBudget
): void {
  if (depth > DEFAULT_LIMITS.max_value_depth) {
    if (!budget.valueLimitHit) {
      issues.push({ path, message: "value exceeds maximum depth" });
      budget.valueLimitHit = true;
    }
    return;
  }
  budget.valueNodes += 1;
  if (budget.valueNodes > DEFAULT_LIMITS.max_value_nodes) {
    if (!budget.valueLimitHit) {
      issues.push({ path, message: "value exceeds maximum node budget" });
      budget.valueLimitHit = true;
    }
    return;
  }
  const type = typeof schema.type === "string" ? schema.type : undefined;

  if (type && !matchesType(type, value)) {
    issues.push({ path, message: `expected ${type}` });
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(entry, value, budget, issues, path))) {
    issues.push({ path, message: "value must be one of enum values" });
  }

  if (type === "object" && isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : [];
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const key of required) {
      if (!(key in value)) {
        issues.push({ path: `${path}.${key}`, message: "is required" });
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in value) || !isPlainObject(childSchema)) {
        continue;
      }
      validateValue(childSchema, value[key], `${path}.${key}`, issues, depth + 1, budget);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          issues.push({ path: `${path}.${key}`, message: "additional properties are not allowed" });
        }
      }
    }
  }

  if (type === "array" && Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((item, index) => validateValue(schema.items as JsonSchema, item, `${path}[${index}]`, issues, depth + 1, budget));
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

function deepEqual(
  left: unknown,
  right: unknown,
  budget: ValidationBudget,
  issues: ValidationIssue[],
  path: string
): boolean {
  budget.enumComparisons += 1;
  if (budget.enumComparisons > DEFAULT_LIMITS.max_enum_comparisons) {
    if (!budget.enumLimitHit) {
      issues.push({ path, message: "enum comparison budget exceeded" });
      budget.enumLimitHit = true;
    }
    return false;
  }
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index], budget, issues, path));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key], budget, issues, path));
  }
  return false;
}
