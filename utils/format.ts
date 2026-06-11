export function formatSAL(amount: number | string, showFullPrecision: boolean = false): string {
  let num = typeof amount === 'string' ? parseFloat(amount) : amount;

  if (isNaN(num)) return '0.00';

  if (showFullPrecision) {
    return num.toFixed(8);
  }

  // toFixed(8) also converts scientific notation to a decimal string.
  let fixed = num.toFixed(8);

  // Repair floating-point artifacts where decimals like .99 are not exactly representable.
  const [intPart, decPart] = fixed.split('.');
  if (decPart) {
    const ninesMatch = decPart.match(/^(\d*)([0-8])9{5,}$/);
    if (ninesMatch) {
      const [, prefix, lastNonNine] = ninesMatch;
      const roundedDigit = parseInt(lastNonNine) + 1;
      const newDecimal = (prefix + roundedDigit).padEnd(8, '0');
      fixed = intPart + '.' + newDecimal;
    }

    const zerosMatch = decPart.match(/^(\d*[1-9])0{5,}[1-3]$/);
    if (zerosMatch) {
      const [, prefix] = zerosMatch;
      const newDecimal = prefix.padEnd(8, '0');
      fixed = intPart + '.' + newDecimal;
    }
  }
  const [whole, decimal] = fixed.split('.');

  let trimmed = decimal.replace(/0+$/, '');
  if (trimmed.length < 2) {
    trimmed = trimmed.padEnd(2, '0');
  }

  const wholeFormatted = parseInt(whole).toLocaleString('en-US');

  return `${wholeFormatted}.${trimmed}`;
}

export function formatSALWithUnit(amount: number, showFullPrecision: boolean = false): string {
  return `${formatSAL(amount, showFullPrecision)} SAL`;
}

export function formatSAL3(amount: number): string {
  if (isNaN(amount)) return '0.00';

  const rounded = Math.round(amount * 1e3) / 1e3;
  const fixed = rounded.toFixed(3);
  const [whole, decimal] = fixed.split('.');

  let trimmed = decimal.replace(/0+$/, '');
  if (trimmed.length < 2) {
    trimmed = trimmed.padEnd(2, '0');
  }

  const wholeFormatted = parseInt(whole).toLocaleString('en-US');
  return `${wholeFormatted}.${trimmed}`;
}

export function formatSAL2(amount: number): string {
  if (isNaN(amount)) return '0.00';

  const rounded = Math.round(amount * 1e2) / 1e2;
  const fixed = rounded.toFixed(2);
  const [whole, decimal] = fixed.split('.');
  const wholeFormatted = Number(whole).toLocaleString('en-US');

  return `${wholeFormatted}.${decimal}`;
}

export function formatSALCompact(amount: number): string {
  if (isNaN(amount)) return '0.00';

  const absAmount = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';

  if (absAmount >= 1_000_000) {
    return `${sign}${(absAmount / 1_000_000).toFixed(2)}M`;
  } else if (absAmount >= 1_000) {
    return `${sign}${(absAmount / 1_000).toFixed(2)}k`;
  } else {
    return `${sign}${absAmount.toFixed(2)}`;
  }
}
