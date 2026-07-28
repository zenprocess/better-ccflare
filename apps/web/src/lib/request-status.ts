import { getStatusCategory, getStatusCodeCssClass } from "@ccflare/ui";

export type RequestStatusBadgeVariant =
	| "success"
	| "warning"
	| "destructive"
	| "secondary";

export function isSuccessStatusCode(statusCode: number): boolean {
	return getStatusCategory(statusCode) === "success";
}

export function getStatusCodeTextClass(statusCode: number): string {
	return getStatusCodeCssClass(statusCode);
}

export function getStatusCodeBadgeVariant(
	statusCode: number,
): RequestStatusBadgeVariant {
	const category = getStatusCategory(statusCode);
	switch (category) {
		case "success":
			return "success";
		case "warning":
			return "warning";
		case "error":
			return "destructive";
		default:
			return "secondary";
	}
}
