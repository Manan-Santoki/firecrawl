"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { formatCompact, formatNumber } from "@/lib/format";

export type ChartSeries = { keys: string[]; points: Array<Record<string, number | string>> };

const SERIES_COLORS = Array.from({ length: 9 }, (_, i) => `var(--series-${i + 1})`);

function shortDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${Number(month)}/${Number(date)}`;
}

/**
 * Daily stacked bars. Recharts is the only non-coss UI dependency; every color
 * and font here comes from the coss theme variables, so it follows dark mode.
 */
export function StackedDailyChart({
  series,
  height = 260,
  emptyLabel = "No data in this range yet.",
  testId,
}: {
  series: ChartSeries;
  height?: number;
  emptyLabel?: string;
  testId?: string;
}) {
  const hasData = series.keys.length > 0 && series.points.some((point) => series.keys.some((key) => Number(point[key]) > 0));
  if (!hasData) {
    return (
      <Empty className="min-h-40" data-testid={testId}>
        <EmptyHeader>
          <EmptyTitle className="text-base">Nothing to chart</EmptyTitle>
          <EmptyDescription>{emptyLabel}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div style={{ height }} className="w-full text-xs" data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={series.points} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="day"
            tickFormatter={shortDay}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--muted-foreground)" }}
            minTickGap={12}
          />
          <YAxis
            tickFormatter={(value: number) => formatCompact(value)}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--muted-foreground)" }}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ fill: "var(--accent)", opacity: 0.5 }}
            formatter={(value) => formatNumber(Number(value))}
            labelFormatter={(label) => String(label)}
            contentStyle={{
              background: "var(--popover)",
              color: "var(--popover-foreground)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)",
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--muted-foreground)" }}
          />
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ color: "var(--muted-foreground)", paddingTop: 8 }}
          />
          {series.keys.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="total"
              fill={SERIES_COLORS[index % SERIES_COLORS.length]}
              radius={index === series.keys.length - 1 ? [3, 3, 0, 0] : 0}
              maxBarSize={36}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
