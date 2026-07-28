import { isTimeRange, type TimeRange } from "@ccflare/types";
import { TIME_RANGE_OPTIONS } from "@ccflare/ui";
import { Clock } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

interface TimeRangeSelectorProps {
	value: TimeRange;
	onChange: (value: TimeRange) => void;
}

export function TimeRangeSelector({ value, onChange }: TimeRangeSelectorProps) {
	return (
		<div className="flex items-center gap-2">
			<Clock className="h-4 w-4 text-muted-foreground" />
			<Select
				value={value}
				onValueChange={(nextValue) => {
					if (isTimeRange(nextValue)) {
						onChange(nextValue);
					}
				}}
			>
				<SelectTrigger className="w-[150px]">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{TIME_RANGE_OPTIONS.map((range) => (
						<SelectItem key={range.value} value={range.value}>
							{range.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
