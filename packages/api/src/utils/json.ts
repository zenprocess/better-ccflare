import { ValidationError } from "@ccflare/core";

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function parseJsonObject(
	req: Request,
	field = "body",
): Promise<Record<string, unknown>> {
	const body = await req.json();
	if (!isJsonObject(body)) {
		throw new ValidationError(`${field} must be an object`, field, body);
	}
	return body;
}
