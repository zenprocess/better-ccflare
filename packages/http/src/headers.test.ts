import { describe, expect, it } from "bun:test";
import { sanitizeRequestHeaders } from "./headers";

describe("sanitizeRequestHeaders", () => {
	it("removes persisted auth and cookie headers", () => {
		const sanitized = sanitizeRequestHeaders(
			new Headers({
				authorization: "Bearer secret-token",
				"x-api-key": "secret-key",
				cookie: "session=secret",
				"content-type": "application/json",
			}),
		);

		expect(sanitized.get("authorization")).toBeNull();
		expect(sanitized.get("x-api-key")).toBeNull();
		expect(sanitized.get("cookie")).toBeNull();
		expect(sanitized.get("content-type")).toBe("application/json");
	});
});
