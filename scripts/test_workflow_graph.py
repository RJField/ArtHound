"""
Unit test for lib/workflow_graph.detect_cycle — workflow dependency cycle detection
(workflow_dependency_validation).

Edge semantics: deps row {step_id, depends_on_step_id} = "step_id depends on depends_on_step_id".
detect_cycle returns a cycle path (ids, looping back) or None, optionally applying a proposed change.

Pure function — no DB.  Usage: python scripts/test_workflow_graph.py  (exit 0 = pass, 1 = fail)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from lib.workflow_graph import detect_cycle

STEPS = [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}]


def check(label, cond):
    if not cond:
        print(f"FAIL: {label}")
        sys.exit(1)


# 1. Acyclic chain a->b->c (a depends on b depends on c): no cycle.
deps = [{"step_id": "a", "depends_on_step_id": "b"},
        {"step_id": "b", "depends_on_step_id": "c"}]
check("acyclic chain has no cycle", detect_cycle(STEPS, deps) is None)

# 2. Existing direct cycle a->b->a is detected.
deps_cycle = [{"step_id": "a", "depends_on_step_id": "b"},
              {"step_id": "b", "depends_on_step_id": "a"}]
cyc = detect_cycle(STEPS, deps_cycle)
check("direct cycle detected", cyc is not None)
check("cycle loops back on itself", cyc[0] == cyc[-1])
check("cycle involves a and b", set(cyc) == {"a", "b"})

# 3. Proposed update closing a longer loop: a->b->c already; making c depend on a forms a->b->c->a.
chain = [{"step_id": "a", "depends_on_step_id": "b"},
         {"step_id": "b", "depends_on_step_id": "c"}]
cyc3 = detect_cycle(chain_steps := STEPS, chain, step_id="c", depends_on=["a"])
check("proposed transitive cycle detected", cyc3 is not None and set(cyc3) >= {"a", "b", "c"})

# 4. Proposed update that stays acyclic: making d depend on a (a->b->c, d->a) — no cycle.
check("proposed acyclic change allowed",
      detect_cycle(STEPS, chain, step_id="d", depends_on=["a"]) is None)

# 5. Proposed change REPLACES the step's existing edges (doesn't union them).
#    b currently depends on c; replacing b's deps with [] breaks the chain — still acyclic, and a
#    self-loop proposal b->b is caught.
check("replacing edges clears prior deps", detect_cycle(STEPS, chain, step_id="b", depends_on=[]) is None)
self_loop = detect_cycle(STEPS, [], step_id="b", depends_on=["b"])
check("self-dependency is a cycle", self_loop is not None and set(self_loop) == {"b"})

print("OK: detect_cycle (acyclic, direct cycle, transitive cycle, replace semantics, self-loop)")
