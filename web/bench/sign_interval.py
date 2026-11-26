"""Exact two-sided 95% sign interval for a median of independent rounds."""
from math import comb


def median_sign_index(n):
    """Return the zero-based index of the lower endpoint in the sorted samples.

    >>> [median_sign_index(n) for n in (6, 12, 14, 16, 20)]
    [0, 2, 2, 3, 5]
    >>> median_sign_index(5)
    Traceback (most recent call last):
    ...
    ValueError: a finite 95% sign interval requires at least six observations
    """
    if n < 6:
        raise ValueError("a finite 95% sign interval requires at least six observations")
    tail = 0
    for i in range(n):
        # Falling below sample[i] includes outcomes with exactly i observations
        # below the population median. Count that outcome in each tail.
        tail += comb(n, i)
        if 40 * tail > 2**n:
            return i - 1
