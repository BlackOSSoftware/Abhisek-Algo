export function money(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export function num(value?: number) {
  return typeof value === "number" ? value.toFixed(2) : "-";
}
