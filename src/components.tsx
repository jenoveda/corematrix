import { useI18n } from "./i18n";
import type { ReactNode } from "react";
import { ArrowUpRight, Info } from "lucide-react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="actions">{actions}</div>
    </header>
  );
}
export function Stats({ children }: { children: ReactNode }) {
  return <div className="stats">{children}</div>;
}
export function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail: string;
}) {
  return (
    <section className="stat">
      <span>{label}</span>
      <div className="stat-value">{value}</div>
      <small>{detail}</small>
    </section>
  );
}
export function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-header">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Badge({
  children,
  tone = "blue",
}: {
  children: ReactNode;
  tone?: "blue" | "green" | "amber";
}) {
  return (
    <span className={`badge ${tone}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}
export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="note">
      <Info size={16} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-symbol">
        <ArrowUpRight size={22} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function DataTable({
  headers,
  rows,
  caption,
}: {
  headers: string[];
  rows: ReactNode[][];
  caption: string;
}) {
  return (
    <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {headers.map((h) => (
              <th scope="col" key={h}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RevenueChart({
  values,
}: {
  values: { day: string; revenue: number }[];
}) {
  const { t, money } = useI18n();
  if (!values.length)
    return <Empty title={t("common.none")} description={t("reports.note")} />;
  // Cross-day refunds can make daily net revenue negative; keep the signed amounts visible.
  if (values.some((v) => v.revenue < 0))
    return (
      <DataTable
        caption={t("reports.daily")}
        headers={[`${t("common.time")} (UTC+8)`, t("reports.revenue")]}
        rows={values.map((v) => [v.day, money(v.revenue)])}
      />
    );
  const max = Math.max(...values.map((v) => v.revenue), 1);
  return (
    <div className="chart">
      <div className="chart-toolbar">
        <small>{t("reports.daily")} · CNY</small>
      </div>
      <div
        className="bar-chart"
        role="img"
        aria-label={values
          .map((v) => `${v.day}: ${money(v.revenue)}`)
          .join("；")}
      >
        <div className="chart-plot">
          {values.map((v) => (
            <div className="bar-group" key={v.day}>
              <div className="bars">
                <div
                  className="bar"
                  style={{ height: `${(v.revenue / max) * 100}%` }}
                  title={`${v.day} ${money(v.revenue)}`}
                />
              </div>
              <small>{v.day.slice(5)}</small>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
