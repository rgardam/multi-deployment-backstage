# Plugins

Plugins written in this repository. They are ordinary Backstage plugins
(created with `yarn new`), built from source into the images that use them.

| Package               | Role                                                         | Used by                               |
| --------------------- | ------------------------------------------------------------ | ------------------------------------- |
| `noticeboard`         | Frontend: a page at `/noticeboard`                           | `packages/app`                        |
| `noticeboard-backend` | Backend: notices in the plugin's own database                | `packages/backend-core`               |
| `scorecards`          | Frontend: a card on component pages, a page at `/scorecards` | `packages/app`                        |
| `scorecards-backend`  | Backend: scores entities read from the catalog               | `packages/backend-scorecards`         |
| `scorecards-common`   | Shared checks and types                                      | `scorecards` and `scorecards-backend` |

How they get into the builds:

- A frontend plugin only has to be a dependency of `packages/app`. Feature
  discovery (`app.packages: all`) installs it, and its `title` and `icon`
  make the sidebar entry.
- A backend plugin is a dependency of the backend that hosts it, plus one
  `backend.add(import(...))` line. Its built code ships in that backend's
  bundle and its npm dependencies in that backend's dependency layer.
  Anything else the plugin needs at runtime, like `migrations/`, goes in its
  `files` field so it is packed into the bundle.
- `scripts/workspace-deps.mjs` tells Task which local packages each bundle
  contains, so changing a plugin rebuilds only the images that include it.

Adding one: `yarn new`, pick `frontend-plugin` or `backend-plugin`, then wire
it up as above. A backend plugin added to `backend-core` needs no gateway
change; to run it as its own deployment, copy `packages/backend-scorecards`
and add a compose service and a gateway `location` (see `docs/PLAN.md`,
section 7).

One gotcha from writing these: in `@backstage/ui` tables, row ids and column
ids share one key space, so a row whose id equals a column id breaks
rendering ("Cell count must match column count"). Prefix row ids.
