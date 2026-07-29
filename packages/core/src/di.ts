export { container } from "./container";

export const SERVICE_KEYS = {
	Logger: Symbol("Logger"),
	Config: Symbol("Config"),
	Database: Symbol("Database"),
	PricingLogger: Symbol("PricingLogger"),
	AsyncWriter: Symbol("AsyncWriter"),
} as const;
