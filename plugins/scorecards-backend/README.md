# scorecards (backend)

Scores catalog entities against the checks in
`@internal/backstage-plugin-scorecards-common`:

- `GET /api/scorecards/entities/:kind/:namespace/:name`: one entity
- `GET /api/scorecards/summary?kind=component`: every entity of a kind,
  overall and per namespace

Deployed as its own backend, `packages/backend-scorecards`. It reads the
catalog through the catalog service, which in this deployment means the
gateway and the catalog router.
