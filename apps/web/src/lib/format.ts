export function formatPrice(minorUnits: number, currency = 'INR', maximumFractionDigits = 0) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency || 'INR',
    maximumFractionDigits,
  }).format(minorUnits / 100);
}

// Major-unit money for merchant-entered prices (typed as 2499.00, not paise).
export function formatMoney(majorUnits: number, currency = 'INR') {
  const locale = (currency || 'INR') === 'INR' ? 'en-IN' : 'en-US';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency || 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(majorUnits);
}
