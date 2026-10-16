"use client";

import { format, parse } from "date-fns";
import { tz } from "@date-fns/tz";
import { useAtomValue } from "jotai";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { DailyUsageStats } from "@/server-actions/stats";
import { timeZoneAtom } from "@/atoms/user-cookies";

const CHARTS = {
  threads: {
    config: {
      value: { label: "Tasks", color: "var(--chart-1)" },
    } satisfies ChartConfig,
    unit: "tasks",
    pick: (day: DailyUsageStats) => day.threadsCreated,
  },
  prs: {
    config: {
      value: { label: "PRs merged", color: "var(--chart-2)" },
    } satisfies ChartConfig,
    unit: "PRs",
    pick: (day: DailyUsageStats) => day.prsMerged,
  },
} as const;

/** One daily bar series in ink, tabular TX-02 axis labels. */
export function UsageChart({
  dailyStats,
  series,
}: {
  dailyStats: DailyUsageStats[];
  series: keyof typeof CHARTS;
}) {
  const timeZone = useAtomValue(timeZoneAtom);
  const chart = CHARTS[series];
  if (dailyStats.length === 0) {
    return null;
  }
  const chartData = [...dailyStats].reverse().map((day) => ({
    date: format(
      parse(day.date, "yyyy-MM-dd", new Date(), { in: tz(timeZone) }),
      "MMM d",
    ),
    value: chart.pick(day),
  }));
  return (
    <ChartContainer
      config={chart.config}
      className="mt-3 h-[140px] w-full max-w-xl font-ui text-[11px]"
    >
      <BarChart data={chartData} margin={{ left: -24, right: 0, top: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--line-soft)" />
        <XAxis
          dataKey="date"
          tickLine={false}
          tickMargin={8}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          domain={[0, (dataMax: number) => Math.max(5, dataMax)]}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) => value}
              formatter={(value) => `${value} ${chart.unit}`}
            />
          }
        />
        <Bar dataKey="value" fill="var(--color-value)" radius={1} />
      </BarChart>
    </ChartContainer>
  );
}
