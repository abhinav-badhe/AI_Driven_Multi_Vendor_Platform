export function formatPrice(minorUnits: number, currency = "INR", maximumFractionDigits = 0) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency || "INR",
    maximumFractionDigits,
  }).format(minorUnits / 100);
}
