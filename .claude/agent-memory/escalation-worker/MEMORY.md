# Memory index

- [D1 vs node:sqlite limit divergence](project-d1-vs-node-sqlite-divergence.md) — a green suite proves nothing about SQLite limits D1 enforces and the local driver raises; never write `LIKE ?`.
- [Free-plan CPU budget](project-free-plan-cpu-budget.md) — size requests by D1 operation count against the known production calibration, not local milliseconds.
