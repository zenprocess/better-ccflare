import type { ComponentType, ReactNode } from "react";
import {
	CartesianGrid,
	Legend,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { CHART_PROPS } from "../../constants";
import { ChartContainer } from "./ChartContainer";
import {
	type CommonChartProps,
	getChartHeight,
	getTooltipStyles,
	isChartEmpty,
} from "./chart-utils";

type XYChartComponentProps = {
	children?: ReactNode;
	data?: CommonChartProps["data"];
	margin?: CommonChartProps["margin"];
	onClick?: CommonChartProps["onChartClick"];
};

interface BaseXYChartFrameProps extends CommonChartProps {
	chartComponent: ComponentType<XYChartComponentProps>;
	defs?: ReactNode;
	children: ReactNode;
}

export function BaseXYChartFrame({
	data,
	chartComponent: ChartComponent,
	defs,
	xAxisKey = "time",
	loading = false,
	height = "medium",
	xAxisAngle = 0,
	xAxisTextAnchor = "middle",
	xAxisHeight = 30,
	xAxisTickFormatter,
	yAxisDomain,
	yAxisTickFormatter,
	tooltipFormatter,
	tooltipLabelFormatter,
	tooltipStyle = "default",
	showLegend = false,
	legendHeight = 36,
	margin,
	className = "",
	error = null,
	emptyState,
	onChartClick,
	children,
}: BaseXYChartFrameProps) {
	const chartHeight = getChartHeight(height);
	const isEmpty = isChartEmpty(data);
	const tooltipStyles = getTooltipStyles(tooltipStyle);

	return (
		<ChartContainer
			loading={loading}
			height={height}
			className={className}
			error={error}
			isEmpty={isEmpty}
			emptyState={emptyState}
		>
			<ResponsiveContainer width="100%" height={chartHeight}>
				<ChartComponent data={data} margin={margin} onClick={onChartClick}>
					{defs}
					<CartesianGrid
						strokeDasharray={CHART_PROPS.strokeDasharray}
						className={CHART_PROPS.gridClassName}
					/>
					<XAxis
						dataKey={xAxisKey}
						className="text-xs"
						angle={xAxisAngle}
						textAnchor={xAxisTextAnchor}
						height={xAxisHeight}
						tickFormatter={xAxisTickFormatter}
					/>
					<YAxis
						className="text-xs"
						domain={yAxisDomain}
						tickFormatter={yAxisTickFormatter}
					/>
					<Tooltip
						contentStyle={tooltipStyles}
						formatter={tooltipFormatter}
						labelFormatter={tooltipLabelFormatter}
					/>
					{showLegend && <Legend height={legendHeight} />}
					{children}
				</ChartComponent>
			</ResponsiveContainer>
		</ChartContainer>
	);
}
