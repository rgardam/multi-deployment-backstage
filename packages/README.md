# Packages

| Package              | Deployed as                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `app`                | The frontend image (static files served by nginx)                                        |
| `backend-core`       | `backend-core`                                                                           |
| `backend-catalog`    | One deployment per catalog shard (`catalog-org`, `catalog-payments`, `catalog-default`)  |
| `backend-scaffolder` | `backend-scaffolder`                                                                     |
| `backend-search`     | `backend-search`                                                                         |
| `backend-techdocs`   | `backend-techdocs`                                                                       |
| `backend-scorecards` | `backend-scorecards`: hosts the local scorecards plugin from `plugins/`                  |
| `catalog-router`     | `catalog-router`, in front of the catalog shards                                         |
| `catalog-sharding`   | Not deployed: shard rules, inlined into the router and the catalog backend at build time |

Each deployable package has its own `Dockerfile` and
`Dockerfile.dockerignore`. See the root README and `docs/PLAN.md`.
