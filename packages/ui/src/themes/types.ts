export interface ThemePalette {
	id: string;
	name: string;
	family: string;
	appearance: "dark" | "light";

	// Surfaces
	background: string;
	foreground: string;
	card: string;
	cardForeground: string;
	popover: string;
	popoverForeground: string;

	// Brand
	primary: string;
	primaryForeground: string;
	secondary: string;
	secondaryForeground: string;

	// Subtle
	muted: string;
	mutedForeground: string;
	accent: string;
	accentForeground: string;

	// Danger
	destructive: string;
	destructiveForeground: string;

	// Chrome
	border: string;
	input: string;
	ring: string;

	// Semantic status
	success: string;
	warning: string;
	error: string;
	info: string;

	// Chart palette
	chart1: string;
	chart2: string;
	chart3: string;
	chart4: string;
	chart5: string;
}
