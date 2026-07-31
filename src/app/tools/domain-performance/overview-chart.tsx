"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { EmailStatsChartPoint } from "@/lib/plusvibe-types";
import { formatNumber } from "@/lib/format";

const ACCENT = "#7c5cfc";
const REPLY = "#22c55e";
const AXIS = "hsl(240 5% 55%)";
const GRID = "hsl(240 6% 50% / 0.15)";

interface Props {
  data: EmailStatsChartPoint[];
  title: string;
  loading?: boolean;
}

export function OverviewChart({ data, title, loading }: Props) {
  const empty = !loading && data.length === 0;

  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Sent &amp; replies over time</h3>
          <p className="text-xs text-muted-foreground">{title}</p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <Legend color={ACCENT} label="Sent" />
          <Legend color={REPLY} label="Replies" />
        </div>
      </div>

      <div className="h-64 w-full">
        {empty ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No activity in this range.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={data}
              margin={{ top: 6, right: 6, bottom: 0, left: -12 }}
            >
              <defs>
                <linearGradient id="sentFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={ACCENT} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: AXIS, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
              />
              <YAxis
                tick={{ fill: AXIS, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={44}
                allowDecimals={false}
              />
              <Tooltip content={<ChartTooltip />} />
              <Area
                type="monotone"
                dataKey="total_sent_count"
                name="Sent"
                stroke={ACCENT}
                strokeWidth={2}
                fill="url(#sentFill)"
              />
              <Line
                type="monotone"
                dataKey="total_reply_count"
                name="Replies"
                stroke={REPLY}
                strokeWidth={2}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload as EmailStatsChartPoint;
  return (
    <div className="pv-card px-3 py-2 text-xs shadow-card">
      <div className="mb-1 font-medium">{label}</div>
      <Row color={ACCENT} label="Sent" value={point.total_sent_count} />
      <Row color={REPLY} label="Replies" value={point.total_reply_count} />
      <Row label="Replies (OOO)" value={point.total_ooo_reply_count} />
      <Row label="Contacted" value={point.total_contacted_count} />
      <Row label="Bounces" value={point.total_bounce_count} />
    </div>
  );
}

function Row({
  color,
  label,
  value,
}: {
  color?: string;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {color && (
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        {label}
      </span>
      <span className="tabular-nums">{formatNumber(value)}</span>
    </div>
  );
}
