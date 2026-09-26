// The two targets are alternative half-hours, so keep their outcomes separate.
function outlookRows(data) {
  if (!Array.isArray(data?.predictions) || data.predictions.length !== 2 ||
      !Array.isArray(data?.scenario?.outcomes) || data.scenario.outcomes.length !== 2) {
    throw new TypeError('Energy outlook needs two predictions and two scenario outcomes.');
  }

  const number = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`Invalid ${label}.`);
    }
    return value;
  };
  const horizon = (value) => {
    if (!Number.isInteger(value) || value <= 0) throw new TypeError('Invalid forecast horizon.');
    return value;
  };
  const time = (value, label) => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
      throw new TypeError(`Invalid ${label}.`);
    }
    return value;
  };
  const close = (left, right) => {
    const tolerance = Math.min(1e-6, Math.max(left, right) * 1e-12);
    return Math.abs(left - right) <= tolerance;
  };

  const outcomes = new Map();
  for (const outcome of data.scenario.outcomes) {
    const key = horizon(outcome?.horizonMinutes);
    if (outcomes.has(key)) throw new TypeError('Duplicate scenario horizon.');
    outcomes.set(key, outcome);
  }

  const seen = new Set();
  const rows = data.predictions.map((prediction) => {
    const key = horizon(prediction?.horizonMinutes);
    if (seen.has(key)) throw new TypeError('Duplicate prediction horizon.');
    seen.add(key);
    const outcome = outcomes.get(key);
    if (!outcome) throw new TypeError('Scenario outcome does not match prediction.');

    const targetAt = time(prediction.targetAt, 'forecast target');
    const issuedAt = time(prediction.issuedAt, 'forecast issue time');
    if (time(outcome.targetAt, 'scenario target') !== targetAt) {
      throw new TypeError('Scenario target does not match prediction.');
    }
    const atRiskMwh = number(prediction.atRiskMwh, 'at-risk energy');
    const scenarioRisk = number(outcome.atRiskMwh, 'scenario at-risk energy');
    const potentialRecoveryMwh = number(outcome.potentialRecoveryMwh, 'potential absorption');
    const remainingWasteMwh = number(outcome.remainingWasteMwh, 'remaining at-risk energy');
    if (!close(atRiskMwh, scenarioRisk) ||
        !close(atRiskMwh, potentialRecoveryMwh + remainingWasteMwh)) {
      throw new TypeError('Scenario energy does not balance with forecast risk.');
    }
    return { horizonMinutes: key, targetAt, issuedAt, atRiskMwh,
      potentialRecoveryMwh, remainingWasteMwh };
  });
  return rows.sort((left, right) => left.horizonMinutes - right.horizonMinutes);
}

function outlookScale(rows) {
  if (!Array.isArray(rows) || rows.length !== 2) {
    throw new TypeError('Energy outlook scale needs two targets.');
  }
  const values = rows.flatMap((row) => [row?.atRiskMwh, row?.potentialRecoveryMwh, row?.remainingWasteMwh]);
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new TypeError('Invalid chart energy value.');
  }
  const peak = Math.max(...values);
  if (peak === 0) return { max: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] };

  const rawStep = peak / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  if (rawStep === 0 || magnitude === 0) return { max: peak, ticks: [0, peak] };
  const normalized = rawStep / magnitude;
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate >= normalized) * magnitude;
  const intervals = Math.ceil(peak / step);
  const ticks = Array.from({ length: intervals + 1 }, (_, index) =>
    index === 0 ? 0 : Number((index * step).toPrecision(12)));
  const max = ticks[ticks.length - 1];
  if (!Number.isFinite(max) || max < peak) throw new RangeError('Energy outlook cannot scale this value.');
  return { max, ticks };
}

function outlookFormat(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('Invalid energy value.');
  }
  if (value !== 0 && value < 0.0001) {
    const [mantissa, exponent] = value.toExponential(5).split('e');
    return `${Number(mantissa)}e${Number(exponent)}`;
  }
  return new Intl.NumberFormat('en-IE', { maximumFractionDigits: 6 }).format(value);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { outlookRows, outlookScale, outlookFormat };
}
