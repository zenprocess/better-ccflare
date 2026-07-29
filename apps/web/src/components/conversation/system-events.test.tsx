import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Message } from "./Message";

describe("system event rendering", () => {
	it("renders recognized system notices as dedicated blocks", () => {
		const messageProps = {
			role: "system" as const,
			content:
				"Session state changed: requires_action\n\nTool progress: Bash (2.5s)\n\nTool summary: Searched in auth/\n\nTool permission requested: Bash",
			contentBlocks: [],
			tools: [],
			toolResults: [],
			cleanLineNumbers: (value: string) => value,
		};
		const html = renderToStaticMarkup(<Message {...messageProps} />);

		expect(html).toContain("Session State");
		expect(html).toContain("requires_action");
		expect(html).toContain("Tool Progress");
		expect(html).toContain("Bash (2.5s)");
		expect(html).toContain("Tool Summary");
		expect(html).toContain("Searched in auth/");
		expect(html).toContain("Tool Permission");
	});
});
