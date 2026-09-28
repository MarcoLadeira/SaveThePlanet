"""Which forecast dispatch-down energy a site's charging may be claimed against.

Kept apart from the optimizer so real network/location data can replace these
assumptions later. Without a network map or operator confirmation nothing is ever
'eligible': the best status is 'conditional', and the reason says what is assumed.
"""

STATUSES = ('eligible', 'conditional', 'unknown', 'ineligible')
UNCERTAINTY_MODES = ('expected', 'conservative')


def opportunity_pools(prediction, mode='expected'):
    """Forecast at-risk energy (kWh) split into system-wide curtailment and local constraints.

    'expected' uses the point forecast. 'conservative' scales both components down to
    the P10 quantity. P10 is a model interval estimate, not a guaranteed floor, and it
    is separate from the dispatch-down event probability, which is reported, not applied.
    """
    if mode not in UNCERTAINTY_MODES:
        raise ValueError(f'Uncertainty mode must be one of {", ".join(UNCERTAINTY_MODES)}')
    total = prediction['atRiskMwh']
    scale = 1.0 if mode == 'expected' or total <= 0 else min(1.0, prediction['lowerMwh'] / total)
    return dict(curtailment=prediction['curtailmentMwh'] * scale * 1000,
                constraint=prediction['constraintMwh'] * scale * 1000)


def site_claims(site):
    """Status and reason for claiming each dispatch-down component at a site."""
    if site['region'] != 'IE':
        reason = 'The forecast covers Ireland only; this site is outside it.'
        return dict(curtailment=dict(status='ineligible', reason=reason),
                    constraint=dict(status='ineligible', reason=reason))
    curtailment = dict(status='conditional', reason=(
        'Curtailment is system-wide, so extra demand anywhere on the Irish grid could in principle '
        'absorb it. Not confirmed with the system operator.'))
    if site['hypotheticalConstraintZone']:
        constraint = dict(status='conditional', reason=(
            'Hypothetical: this site is assumed to sit behind the same network constraint as the '
            'dispatched-down generation. No network map verifies this.'))
    else:
        constraint = dict(status='unknown', reason=(
            'Constraints are location-specific and no network data links this site to the '
            'constrained generation, so its charging is not claimed against them.'))
    return dict(curtailment=curtailment, constraint=constraint)


def claimable_components(site):
    """Pool names this site's charging may draw on, local constraint first."""
    claims = site_claims(site)
    return [name for name in ('constraint', 'curtailment') if claims[name]['status'] in ('eligible', 'conditional')]
