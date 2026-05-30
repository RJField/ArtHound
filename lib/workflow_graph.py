"""Workflow-step dependency graph validation (workflow_dependency_validation).

Pure helpers — no DB — so cycle detection stays unit-testable (scripts/test_workflow_graph.py).

Edge semantics: an edge ``A -> B`` means "step A depends on B" (A needs B done first). A directed
cycle (A -> B -> … -> A) is an impossible dependency configuration and must be rejected before it is
persisted. A brand-new step has no incoming edges, so only an *update* can introduce a cycle — but the
detector is run with the full proposed graph either way.
"""


def _find_cycle(adjacency: dict[str, set[str]]) -> list[str] | None:
    """Return a cycle as a path of node ids ending where it began (e.g. [a, b, a]), or None.

    Iterative DFS with an explicit stack so deep graphs can't blow the recursion limit.
    """
    WHITE, GREY, BLACK = 0, 1, 2
    color: dict[str, int] = {}

    for root in adjacency:
        if color.get(root, WHITE) != WHITE:
            continue
        # Each frame: (node, iterator over its out-edges). `path` is the current grey chain.
        stack: list[tuple[str, iter]] = [(root, iter(adjacency.get(root, ())))]
        path: list[str] = [root]
        color[root] = GREY
        while stack:
            node, it = stack[-1]
            advanced = False
            for nxt in it:
                c = color.get(nxt, WHITE)
                if c == WHITE:
                    color[nxt] = GREY
                    path.append(nxt)
                    stack.append((nxt, iter(adjacency.get(nxt, ()))))
                    advanced = True
                    break
                if c == GREY:
                    # Back-edge into the active chain → cycle from nxt to here.
                    return path[path.index(nxt):] + [nxt]
            if not advanced:
                color[node] = BLACK
                stack.pop()
                path.pop()
    return None


def detect_cycle(
    steps: list[dict],
    deps: list[dict],
    *,
    step_id: str | None = None,
    depends_on: list[str] | None = None,
) -> list[str] | None:
    """Build the owner's dependency graph and return a cycle path (or None).

    When ``step_id`` is given, that step's outgoing edges are *replaced* with ``depends_on`` — i.e.
    the graph as it would be after the proposed create/update is applied.

    steps: ``[{"id": ...}, ...]``; deps: ``[{"step_id": ..., "depends_on_step_id": ...}, ...]``.
    """
    adj: dict[str, set[str]] = {s["id"]: set() for s in steps}
    for d in deps:
        sid = d["step_id"]
        if sid in adj:
            adj[sid].add(d["depends_on_step_id"])
    if step_id is not None:
        adj[step_id] = set(depends_on or [])
    return _find_cycle(adj)
