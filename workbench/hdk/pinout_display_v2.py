"""A capability-local display option for exact LDO_VO<n> source nets.

The legacy renderer and its release fingerprints stay unchanged. The caller
must enter this context only around synchronous V2 capability execution in its
dedicated Python process; this is not a thread-local or concurrent patch API.
"""
from contextlib import contextmanager
import re


@contextmanager
def display_v2_scope():
    """Allow the source-derived ``VO<n>`` alias, restoring legacy rules on exit.

    ``LDO_VO4`` permits ``VO4``; the suffix is a source identifier, not a voltage
    measurement or GPIO mapping. All existing plan validation, electrical facts,
    colors, physical pads and geometry continue through the legacy code.
    """
    from hdk import pinout_facts

    original = pinout_facts._label_candidates

    def candidates(net):
        labels = original(net)
        match = re.fullmatch(r'LDO_(VO\d+)', net)
        if match:
            return list(dict.fromkeys([*labels, match.group(1)]))
        return labels

    pinout_facts._label_candidates = candidates
    try:
        yield
    finally:
        pinout_facts._label_candidates = original
