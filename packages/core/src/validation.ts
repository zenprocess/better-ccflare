/**
 * Input validation and sanitization utilities
 */
import { ValidationError } from "./errors";

/**
 * Validates and sanitizes a string input
 */
export function validateString(
	value: unknown,
	field: string,
	options: {
		required?: boolean;
		minLength?: number;
		maxLength?: number;
		pattern?: RegExp;
		allowedValues?: readonly string[];
		transform?: (value: string) => string;
	} = {},
): string | undefined {
	// Handle undefined/null
	if (value === undefined || value === null) {
		if (options.required) {
			throw new ValidationError(`${field} is required`, field);
		}
		return undefined;
	}

	// Ensure it's a string
	if (typeof value !== "string") {
		throw new ValidationError(`${field} must be a string`, field, value);
	}

	// Apply transformation if provided
	const sanitized = options.transform ? options.transform(value) : value;

	// Validate length
	if (options.minLength !== undefined && sanitized.length < options.minLength) {
		throw new ValidationError(
			`${field} must be at least ${options.minLength} characters long`,
			field,
			value,
		);
	}

	if (options.maxLength !== undefined && sanitized.length > options.maxLength) {
		throw new ValidationError(
			`${field} must be at most ${options.maxLength} characters long`,
			field,
			value,
		);
	}

	// Validate pattern
	if (options.pattern && !options.pattern.test(sanitized)) {
		throw new ValidationError(`${field} has an invalid format`, field, value);
	}

	// Validate allowed values
	if (options.allowedValues && !options.allowedValues.includes(sanitized)) {
		throw new ValidationError(
			`${field} must be one of: ${options.allowedValues.join(", ")}`,
			field,
			value,
		);
	}

	return sanitized;
}

/**
 * Validates and sanitizes a number input
 */
export function validateNumber(
	value: unknown,
	field: string,
	options: {
		required?: boolean;
		min?: number;
		max?: number;
		integer?: boolean;
		allowedValues?: readonly number[];
	} = {},
): number | undefined {
	// Handle undefined/null
	if (value === undefined || value === null) {
		if (options.required) {
			throw new ValidationError(`${field} is required`, field);
		}
		return undefined;
	}

	// Convert string to number if needed
	let num: number;
	if (typeof value === "string") {
		num = Number(value);
		if (Number.isNaN(num)) {
			throw new ValidationError(
				`${field} must be a valid number`,
				field,
				value,
			);
		}
	} else if (typeof value === "number") {
		num = value;
	} else {
		throw new ValidationError(`${field} must be a number`, field, value);
	}

	// Validate integer
	if (options.integer && !Number.isInteger(num)) {
		throw new ValidationError(`${field} must be an integer`, field, value);
	}

	// Validate range
	if (options.min !== undefined && num < options.min) {
		throw new ValidationError(
			`${field} must be at least ${options.min}`,
			field,
			value,
		);
	}

	if (options.max !== undefined && num > options.max) {
		throw new ValidationError(
			`${field} must be at most ${options.max}`,
			field,
			value,
		);
	}

	// Validate allowed values
	if (options.allowedValues && !options.allowedValues.includes(num)) {
		throw new ValidationError(
			`${field} must be one of: ${options.allowedValues.join(", ")}`,
			field,
			value,
		);
	}

	return num;
}

/**
 * Common string sanitizers
 */
export const sanitizers = {
	trim: (value: string) => value.trim(),
	lowercase: (value: string) => value.toLowerCase(),
	uppercase: (value: string) => value.toUpperCase(),
	removeWhitespace: (value: string) => value.replace(/\s+/g, ""),
	alphanumeric: (value: string) => value.replace(/[^a-zA-Z0-9]/g, ""),
	alphanumericWithSpaces: (value: string) =>
		value.replace(/[^a-zA-Z0-9\s]/g, ""),
	email: (value: string) => value.trim().toLowerCase(),
	url: (value: string) => {
		try {
			const parsed = new URL(value);
			return parsed.toString();
		} catch {
			throw new ValidationError("Invalid URL format", "url", value);
		}
	},
};

/**
 * Common validation patterns
 */
export const patterns = {
	email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
	uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	alphanumeric: /^[a-zA-Z0-9]+$/,
	alphanumericWithSpaces: /^[a-zA-Z0-9\s]+$/,
	// Account name: alphanumeric with spaces, hyphens, underscores, plus @ and . for email addresses
	accountName: /^[a-zA-Z0-9\s\-_@.+]+$/,
	// Path pattern for API endpoints
	apiPath: /^\/v1\/[a-zA-Z0-9\-_/]*$/,
};
