import { describe, expect, it } from "bun:test";
import {
	getStatusCodeBadgeVariant,
	getStatusCodeTextClass,
	isSuccessStatusCode,
} from "./request-status";

describe("request status helpers", () => {
	it("treats websocket 101 statuses as successful", () => {
		expect(isSuccessStatusCode(101)).toBe(true);
		expect(getStatusCodeTextClass(101)).toBe("text-success");
		expect(getStatusCodeBadgeVariant(101)).toBe("success");
	});

	it("keeps non-success classes aligned with existing semantics", () => {
		expect(getStatusCodeTextClass(404)).toBe("text-warning");
		expect(getStatusCodeBadgeVariant(404)).toBe("warning");
		expect(getStatusCodeTextClass(500)).toBe("text-destructive");
		expect(getStatusCodeBadgeVariant(500)).toBe("destructive");
		expect(getStatusCodeTextClass(302)).toBe("text-muted-foreground");
		expect(getStatusCodeBadgeVariant(302)).toBe("secondary");
	});
});
