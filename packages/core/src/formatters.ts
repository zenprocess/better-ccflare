/**
 * Format USD cost with 4 decimal places.
 */
export function formatCost(cost?: number | null): string {
	if (!cost || cost === 0) return "$0.0000";
	return `$${cost.toFixed(4)}`;
}
