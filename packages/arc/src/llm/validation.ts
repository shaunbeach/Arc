import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "./types.ts";

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();

interface ObjectSchema {
	properties?: Record<string, ObjectSchema>;
	required?: string[];
}

function getValidator(schema: TSchema): ReturnType<typeof Compile> {
	const cached = validatorCache.get(schema);
	if (cached) return cached;
	const validator = Compile(schema);
	validatorCache.set(schema, validator);
	return validator;
}

/** Local models often send `null` for optional fields they mean to omit. Drop those so validation matches intent. */
function dropNullOptionals(value: unknown, schema: ObjectSchema): void {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !schema.properties) return;
	const object = value as Record<string, unknown>;
	const required = new Set(schema.required ?? []);
	for (const [key, propertySchema] of Object.entries(schema.properties)) {
		if (!(key in object)) continue;
		if (object[key] === null && !required.has(key) && !getValidator(propertySchema as TSchema).Check(null)) {
			delete object[key];
		} else {
			dropNullOptionals(object[key], propertySchema);
		}
	}
}

function formatValidationPath(error: TLocalizedValidationError): string {
	const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	if (error.keyword === "required") {
		const requiredProperty = (error.params as { requiredProperties?: string[] }).requiredProperties?.[0];
		if (requiredProperty) return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
	}
	return basePath || "root";
}

/**
 * Validate tool-call arguments against the tool's TypeBox schema, converting loose values first
 * (for example `"10"` to `10`). Returns the converted arguments; throws a message the model can act on.
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): unknown {
	const args = structuredClone(toolCall.arguments);
	dropNullOptionals(args, tool.parameters as ObjectSchema);
	const converted = Value.Convert(tool.parameters, args);

	const validator = getValidator(tool.parameters);
	if (validator.Check(converted)) return converted;

	const errors =
		validator
			.Errors(converted)
			.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
			.join("\n") || "Unknown validation error";
	throw new Error(
		`Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`,
	);
}
