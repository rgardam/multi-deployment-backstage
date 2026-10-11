# How the split Backstage setup works

Backstage runs here as nine images, each built, versioned and released on its
own: an nginx gateway, the frontend, and seven backend services behind it. The
catalog runs as three shards, split by namespace and kind, behind a router
that asks only the shards that can hold an answer. The UI, search and every
plugin still see one catalog.

This guide follows a request through the system: how it gets in, how it is
authenticated, how the catalog finds its answer across shards, where the data
lives, and how each service is built and released only when it changed. To
run it, see the [README](../README.md); for design decisions, measurements
and limits, [PLAN.md](PLAN.md).

- [The pieces](#the-pieces)
- [Ingress: how a request finds its backend](#ingress-how-a-request-finds-its-backend)
- [Auth](#auth)
- [Catalog sharding](#catalog-sharding)
- [Databases](#databases)
- [Builds, releases and change detection](#builds-releases-and-change-detection)
- [In the repository](#in-the-repository)

## The pieces

```mermaid
flowchart LR
  browser([Browser]) --> gw
  ci([CI job]) --> gw
  gw["gateway<br/>nginx"]
  gw -- "/" --> app["app<br/>static frontend"]
  gw -- "/api/catalog" --> router["catalog-router"]
  gw -- "/api/search" --> search["backend-search"]
  gw -- "/api/scaffolder" --> scaffolder["backend-scaffolder"]
  gw -- "/api/techdocs" --> techdocs["backend-techdocs"]
  gw -- "/api/scorecards" --> scorecards["backend-scorecards"]
  gw -- "/api/* (the rest)" --> core["backend-core<br/>auth, permission, events, ..."]
  router --> org["catalog-org<br/>User, Group"]
  router --> payments["catalog-payments<br/>namespace payments"]
  router --> default["catalog-default<br/>everything else"]
```

| Service              | Image                | What it runs                                                                                   |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `gateway`            | `gateway`            | nginx: the only entry point, and the map of which deployment serves which plugin               |
| `app`                | `app`                | The frontend, as static files                                                                  |
| `backend-core`       | `backend-core`       | auth, permission, events, proxy, notifications, signals, and the local noticeboard plugin, ... |
| `catalog-router`     | `catalog-router`     | `/api/catalog`: picks the shards for each request, merges their answers                        |
| `catalog-org`        | `backend-catalog`    | The catalog shard for every User and Group                                                     |
| `catalog-payments`   | `backend-catalog`    | The catalog shard for the `payments` namespace                                                 |
| `catalog-default`    | `backend-catalog`    | The catalog shard for everything else                                                          |
| `backend-search`     | `backend-search`     | Search, and the collators that index the catalog and TechDocs                                  |
| `backend-scaffolder` | `backend-scaffolder` | Software templates                                                                             |
| `backend-techdocs`   | `backend-techdocs`   | TechDocs                                                                                       |
| `backend-scorecards` | `backend-scorecards` | The local scorecards plugin, deployed on its own                                               |

Every deployment scales on its own (`task scale SERVICE=... REPLICAS=...`).
Locally, `ci-oidc` also runs: a stand-in for a CI platform's token service,
used by [CI access](#ci-access).

## Ingress: how a request finds its backend

Every request enters through the gateway, which routes on the path alone. It
checks no credentials: each backend checks every token itself.

```mermaid
flowchart TD
  req(["A request to the gateway"]) --> api{"Path under /api/?"}
  api -- no --> app["app: the frontend's files"]
  api -- yes --> plugin{"Which plugin?<br/>/api/#lt;plugin#gt;/..."}
  plugin -- catalog --> named{"?shard=name or an<br/>X-Catalog-Shard header?"}
  named -- yes --> shard["That catalog shard, directly"]
  named -- no --> router["catalog-router"]
  plugin -- "search, scaffolder,<br/>techdocs, scorecards" --> own["The backend of that name"]
  plugin -- "anything else: auth,<br/>permission, events, ..." --> core["backend-core"]
```

Backends call each other through the same gateway. Their discovery config
resolves every plugin, their own included, to
`http://gateway:8080/api/<pluginId>`, so the gateway's routes are the only
place that knows which deployment hosts which plugin. Moving a plugin to
another deployment is a gateway change. Here, search reads the catalog to index
it:

```mermaid
sequenceDiagram
  participant S as backend-search
  participant G as gateway
  participant R as catalog-router
  participant P as catalog shards
  S->>G: GET /api/catalog/entities?... (discovery points at the gateway)
  G->>R: /api/catalog goes to the router
  R->>P: only the shards that may hold an answer
  P-->>R: their pages
  R-->>S: one answer, as from a single catalog
```

The gateway resolves service names again every 5 seconds, so new replicas get
traffic without a restart. Right after a container is replaced it can still
hold the old address for those seconds, so `task up` and `task deploy:*` wait
until the gateway reaches every deployment
([scripts/wait-for-gateway.mjs](../scripts/wait-for-gateway.mjs)).

## Auth

Nothing is shared between deployments: no secret, no session store. Every
token is a signed JWT, and a backend checks it against the issuer's public
keys, which it fetches through the gateway and caches.

| Token                      | Issued by                        | Checked against                              |
| -------------------------- | -------------------------------- | -------------------------------------------- |
| User token                 | the auth plugin, in backend-core | `/api/auth/.well-known/jwks.json`            |
| Plugin token               | the calling plugin               | `/api/<caller>/.backstage/auth/v1/jwks.json` |
| CI token (external access) | the CI platform (GitHub Actions) | the CI platform's JWKS, plus required claims |

### Signing in

```mermaid
sequenceDiagram
  autonumber
  actor U as Browser
  participant G as gateway
  participant A as auth (backend-core)
  participant C as catalog (router, org shard)
  U->>G: POST /api/auth/guest/refresh
  G->>A: /api/auth goes to backend-core
  A->>C: look up user:default/guest, with auth's own plugin token
  C-->>A: the user entity, with its memberOf groups
  A-->>U: user token for user:default/guest (ES256, valid 1 hour)
  Note over U,A: The app refreshes the token before it expires
```

The guest provider stands in for a real sign-in provider (OIDC, GitHub, ...),
which would add a redirect to the identity provider before step 3. The token
does not list the user's groups (Backstage 1.55 leaves them out); a backend
that needs them asks auth's `/v1/userinfo` and caches the answer.

### A user request, and one backend calling another

Every request from the browser carries the user token. A backend that calls
another plugin on the user's behalf signs a short-lived plugin token with its
own key: it names the caller and the target, and carries a limited copy of
the user's token, so the target knows who the call is for.

```mermaid
sequenceDiagram
  autonumber
  actor U as Browser
  participant SC as backend-scorecards
  participant G as gateway
  participant R as catalog-router
  participant S as catalog shard
  U->>G: GET /api/scorecards/..., Bearer user token
  G->>SC: /api/scorecards goes to backend-scorecards
  SC->>G: auth's public keys (first time only, then cached)
  SC->>SC: check the user token
  SC->>G: GET /api/catalog/..., Bearer plugin token (scorecards to catalog, for the user)
  G->>R: /api/catalog goes to the router
  R->>S: the same request, token unchanged
  S->>G: scorecards' public keys (first time only)
  S->>S: check the plugin token and the user token inside it
  S-->>R: entities
  R-->>SC: entities
  SC-->>U: the score
```

The router never checks tokens: it passes the `Authorization` header to every
shard it asks, and each shard checks it. A request without a valid token gets
401 from whichever backend receives it.

### The catalog's keys: three shards, one key set

Each plugin keeps its signing keys in its own database and replaces them
hourly. Replicas of one deployment share its database, so each publishes all
of their keys. The three catalog shards all sign as plugin `catalog`, but each
has its own database and keys, while a verifier fetches "the catalog's" keys
from one address, `/api/catalog/.backstage/auth/v1/jwks.json`, which lands on
the router. So the router answers it with all three shards' public keys.

```mermaid
flowchart LR
  org["catalog-org<br/>its own key pair"] --> union
  pay["catalog-payments<br/>its own key pair"] --> union
  def["catalog-default<br/>its own key pair"] --> union
  union["catalog-router<br/>/api/catalog/.backstage/auth/v1/jwks.json<br/>every shard's public keys"] --> verifier["Any plugin checking a token from 'catalog',<br/>e.g. permission, on every catalog read"]
```

Without the union, a token signed by the payments shard would fail whenever
the verifier's key request reached another shard.

### Permissions

The permission framework is on. On every catalog read for a user, the shard
asks the permission plugin in backend-core whether the user may read; the
policy here allows everything. Service callers, plugins and CI, are not put
to the policy: Backstage decides from their access restrictions alone.

### CI access

CI jobs read the catalog with the short-lived OIDC token their CI platform
issues them, so no Backstage secret is stored in CI. Only the catalog shards
accept these tokens, with `jwks-claims`
([ciAccess.ts](../packages/backend-catalog/src/ciAccess.ts)): Backstage's
`jwks` check plus required claims. GitHub's issuer signs tokens for every
repository on GitHub, and a workflow picks its own audience, so only a claim
such as `repository_owner_id` says whose workflow is calling.

```mermaid
sequenceDiagram
  autonumber
  participant J as CI job
  participant I as CI token service
  participant G as gateway and router
  participant S as catalog shard
  J->>I: a token for audience backstage-ci
  I-->>J: signed JWT: iss, aud, sub, repository_owner_id, ...
  J->>G: GET /api/catalog/entities/by-query, Bearer JWT
  G->>S: forwarded unchanged, to each shard asked
  S->>I: the issuer's public keys (first time only, then cached)
  S->>S: signature, issuer, audience, expiry, then repository_owner_id
  alt owner allowed, and a read
    S-->>J: 200, the entities
  else owner allowed, but a write
    S-->>J: 403, the access restrictions allow reading only
  else another owner, audience or signing key
    S-->>J: 401
  end
```

In GitHub Actions the token service is GitHub's (`id-token: write` in the
workflow); locally it is the `ci-oidc` stand-in, with the same interface and
claims. `task ci:read` runs the same script a CI job runs
([scripts/ci-catalog-read.mjs](../scripts/ci-catalog-read.mjs)). Setup, and
which owner IDs to allow: README, "CI access".

## Catalog sharding

### Who owns what

Every entity belongs to exactly one shard: the first one, in order, whose rule
matches its kind and namespace
([deploy/catalog-shards.json](../deploy/catalog-shards.json)).

```mermaid
flowchart TD
  entity(["An entity, read<br/>from a location"]) --> location{"kind Location?"}
  location -- yes --> local["Kept by the shard<br/>that read it: each<br/>shard has its own"]
  location -- no --> people{"kind User or Group?"}
  people -- yes --> org["org"]
  people -- no --> ns{"namespace payments?"}
  ns -- yes --> payments["payments"]
  ns -- no --> default["default, the catch-all"]
```

Each shard reads its own locations, and runs a guard that rejects an entity it
does not own, naming the shard that does
([shardGuard.ts](../packages/backend-catalog/src/shardGuard.ts)). So the
router can trust the rules: no entity sits in a shard the router would not
ask.

### A query, step by step

```mermaid
flowchart TD
  q(["A catalog query,<br/>e.g. entities/by-query"]) --> named{"Shard named?<br/>?shard=, or the<br/>X-Catalog-Shard header"}
  named -- yes --> direct["The gateway sends it<br/>straight to that shard:<br/>no router, no<br/>routing headers"]
  named -- no --> read["The router reads the<br/>kinds and namespaces<br/>the request can match,<br/>from its filter or path"]
  read --> keep["It keeps every shard<br/>whose rule may match.<br/>A request that may match<br/>Location keeps all."]
  keep --> one{"One shard left?"}
  one -- yes --> relay["Relay that shard's answer<br/>x-catalog-route: single"]
  one -- no --> fan["Ask each in parallel,<br/>merge in sort order<br/>x-catalog-route: fanout"]
```

| Request to `/api/catalog/...`                          | Shards asked      | Why                                                               |
| ------------------------------------------------------ | ----------------- | ----------------------------------------------------------------- |
| `entities/by-query?filter=kind=group`                  | org               | Groups only live in org                                           |
| `entities/by-query?filter=kind=component`              | payments, default | Components can be in either                                       |
| `...filter=kind=component,metadata.namespace=payments` | payments          | The namespace decides                                             |
| `...filter=kind=user,metadata.namespace=payments`      | org               | Users stay in org, whatever their namespace                       |
| `entities/by-name/component/payments/ledger`           | payments          | The path names the kind and the namespace                         |
| `...filter=metadata.namespace=payments`                | all three         | No kind, so it may match Location entities, which every shard has |
| `entity-facets?facet=kind`                             | all three         | Nothing narrows it down                                           |
| any request with `?shard=payments`                     | payments          | Named explicitly: the gateway sends it straight there             |

Responses from the router carry `x-catalog-route` (`single` or `fanout` for
queries) and `x-catalog-shards`, the shards asked; the gateway logs both.
Pruning is conservative: it may ask a shard that turns out to have nothing,
but never skips one that has an answer.

### Paging across shards

When several shards answer, each page is a merge of their sorted pages, and
the cursor records how far each shard has got. The cursor is all the state
there is, so any router replica can serve the next page.

```mermaid
sequenceDiagram
  participant C as client
  participant R as catalog-router
  participant P as payments
  participant D as default
  C->>R: kind=component, ordered by name, limit 2
  par
    R->>P: its first 2, sorted
  and
    R->>D: its first 2, sorted
  end
  R->>R: merge, keep the first 2, note how many came from each
  R-->>C: 2 entities, cursor: payments at 1, default at 1
  C->>R: the cursor
  par
    R->>P: 2 from position 1
  and
    R->>D: 2 from position 1
  end
  R-->>C: the next 2, and a new cursor
```

`totalItems` is the sum of the shards' totals. Pages neither skip nor repeat
entities unless entities are added or removed between them.

### Writes

- **Refresh and validation** go to the shard that owns the entity, from the
  kind and namespace in the request.
- **A delete** names only a uid, so every shard is asked, and the one that has
  it deletes it.
- **A new location** cannot be routed by its URL, since what decides the owner
  are the entities inside:

```mermaid
sequenceDiagram
  participant C as client
  participant R as catalog-router
  participant S as every shard
  C->>R: POST /api/catalog/locations, target
  R->>S: the same request, as a dry run
  S-->>R: accepted by the shard whose guard takes every entity, refused elsewhere
  R->>S: register it for real, on that shard only
  R-->>C: 201, the location
```

A location that mixes entities owned by different shards is refused, with the
catch-all's error naming each entity's owner.

### Ownership across shards

An entity can be owned by a user or team in another shard, and is here: every
entity in the payments shard is owned by `group:default/team-payments`, which
lives in org. The relation is stored with the entity that declares it.

```mermaid
flowchart LR
  subgraph paymentsShard ["payments shard"]
    ledger["ledger, a Component<br/>owned by team-payments:<br/>stores the ownedBy<br/>relation"]
  end
  subgraph orgShard ["org shard"]
    team["team-payments,<br/>a Group: no ownerOf<br/>edge to ledger"]
  end
  ledger -- "ownedBy, looked up<br/>by name in org" --> team
  team -. "its page lists what it owns:<br/>a relations.ownedBy query,<br/>fanned out" .-> ledger
```

What reads ownership from the owned entity works across shards: the owner on
the entity page, the "Owned" filter, the team's Ownership card, and owner-based
permission rules. Reverse relations do not cross: the team entity has no
`ownerOf` edge to `ledger`, so the relations graph centred on the team, or a
`relations.ownerOf=...` filter, misses it. The same goes for every relation
pair across shards (`partOf` and `hasPart`, `dependsOn` and `dependencyOf`,
...), and ancestry stays within a shard. Keeping all users and groups in one
shard, as org does, keeps group membership whole.

### Two instances, different namespaces

A shard's rule can name namespaces, so two catalog instances can each own a
set of namespaces, one of them taking everything else:

```json
{
  "catalogSharding": {
    "shards": [
      {
        "name": "team-a",
        "target": "http://catalog-team-a:7007/api/catalog",
        "match": { "namespaces": ["team-a", "team-a-legacy"] }
      },
      { "name": "default", "target": "http://catalog-default:7007/api/catalog" }
    ],
    "localKinds": ["Location"]
  }
}
```

Adding one takes configuration, not a new catalog image: the shard in
`deploy/catalog-shards.json` (first matching rule wins), a config file with its
name, database prefix, `catalog.rules` and locations, a deployment of the
catalog image mounting both files, and a restart of the router and the shards,
which read the topology at startup. Routing `?shard=team-a` too means a gateway
change, so a new gateway image. Details: [PLAN.md, section 9](PLAN.md#9-configuration-reference).

## Databases

Every plugin has a database of its own, and every catalog shard a database
prefix of its own, so any of them can move to a dedicated server by changing
its database address (`POSTGRES_HOST`) and copying its data across.
`task up DATABASES=dedicated` does that for the catalog shards and the
scaffolder ([docker-compose.databases.yml](../docker-compose.databases.yml)):

```mermaid
flowchart LR
  cp["catalog-payments"] --> sp[("postgres-payments<br/>backstage_shard_payments_catalog")]
  co["catalog-org"] --> sc[("postgres-catalog<br/>backstage_shard_org_catalog<br/>backstage_shard_default_catalog")]
  cd["catalog-default"] --> sc
  bs["backend-scaffolder"] --> ss[("postgres-scaffolder<br/>backstage_plugin_scaffolder")]
  rest["every other backend"] --> pg[("postgres, as before<br/>backstage_plugin_auth, backstage_plugin_search, ...")]
```

| Split                                          | Effort         | How                                                                                          |
| ---------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| A deployment on its own server                 | Low            | Its database host; move the data with `pg_dump` and `pg_restore`                             |
| One plugin of a deployment on its own server   | Low            | `backend.database.plugin.<pluginId>.connection`                                              |
| A catalog shard (a set of namespaces or kinds) | Low            | Its database host; it can rebuild from its locations, except ones registered through the API |
| One catalog's data across several servers      | Not supported  | Its tables join and transact in one database; shard it instead, as here                      |
| Read replicas for one shard                    | Medium to high | A read-only catalog deployment on a replica, the router sending it reads; not built here     |

## Builds, releases and change detection

### How an image is built

Bundles are built on the host, where dependencies and build caches are warm.
Each backend's image installs a lockfile pruned to that backend's production
dependencies, in its own cached layer, then adds its bundle on top.

```mermaid
flowchart LR
  src["packages/backend-search<br/>and the local packages<br/>it bundles"] --> bundle["bundle: backstage-cli<br/>package build,<br/>on the host"]
  lock["yarn.lock"] --> prune["prune-lockfile.mjs<br/>dist/deps: only its<br/>production dependencies"]
  subgraph image ["docker build, packages/backend-search/Dockerfile"]
    deps["layer: install dist/deps<br/>cached until they change"] --> code["layer: config and the bundle<br/>a few MB"]
  end
  prune --> deps
  bundle --> code
```

A code change rebuilds the bundle and the top layer only, in seconds. A
dependency bump in one backend changes only that backend's pruned lockfile, so
every other image keeps its cache. Task skips a bundle whose sources did not
change, and `task deploy:<service>` rebuilds one image and replaces only its
containers.

### Detecting which services changed

`task plan` decides which services need a new release. Each service, meaning
each `Dockerfile`, gets a fingerprint of exactly the inputs its image is
built from, compared with the fingerprint recorded at its last release in
[deploy/releases.json](../deploy/releases.json)
([scripts/release.mjs](../scripts/release.mjs)).

```mermaid
flowchart TD
  plan(["task plan"]) --> each["For each service"]
  each --> source["source: its package and the local packages it bundles,<br/>without tests, docs and the plugin dev harness"]
  each --> deps["dependencies: the lockfile pruned to<br/>its production dependencies"]
  each --> tool["toolchain: the Backstage CLI<br/>that builds every bundle"]
  each --> image["image: its Dockerfile, every file its .dockerignore<br/>lets in, and NODE_VERSION"]
  source --> same{"The same fingerprint as<br/>in deploy/releases.json?"}
  deps --> same
  tool --> same
  image --> same
  same -- yes --> unchanged["unchanged: nothing to build"]
  same -- no --> changed["changed, with the reasons: files changed since<br/>the release commit, dependency versions,<br/>toolchain, image inputs"]
  changed --> version["next version: BUMP patch, minor or major"]
```

The inputs follow what really reaches an image:

- **Plugins and libraries count where they are bundled.** A frontend plugin
  is compiled into the app; a backend plugin goes into the bundle of the
  backend that hosts it; an inline package such as
  `packages/catalog-sharding` counts for the packages that import it.
- **Dependencies are resolved, not declared.** Two backends declaring the
  same range are independent: only the backend whose resolved versions or
  checksums change is flagged. The plan names the versions that changed.
- **Config counts where it is copied.** `app-config.yaml` is compiled into the
  frontend and copied into every backend image;
  `app-config.production.yaml` and `examples/` only into the images whose
  `.dockerignore` lets them in.
- **What never reaches an image never counts**: tests, Markdown, Storybook
  files, the plugin dev harness, and everything outside the inputs above.

Each kind of change, and exactly what it flags (checked by
[scripts/release.test.mjs](../scripts/release.test.mjs), part of
`task check`):

| Change                                                               | Services flagged                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------- |
| Code in a backend plugin (`plugins/noticeboard-backend`)             | backend-core                                          |
| Tests, docs or the dev harness of a plugin                           | none                                                  |
| Code in a frontend plugin (`plugins/scorecards`)                     | app                                                   |
| A library shared by the frontend and a backend (`scorecards-common`) | app, backend-scorecards                               |
| An inline package (`packages/catalog-sharding`)                      | backend-catalog, catalog-router                       |
| `app-config.yaml`                                                    | app and the six backends                              |
| `app-config.production.yaml`                                         | the six backends                                      |
| `gateway/default.conf.template`                                      | gateway                                               |
| One service's `Dockerfile`                                           | that service                                          |
| `examples/`                                                          | backend-catalog, backend-scaffolder, backend-techdocs |
| A dependency of one backend                                          | that backend                                          |
| The build toolchain (`@backstage/cli`)                               | app, the six backends, catalog-router                 |
| `NODE_VERSION`                                                       | the six backends and catalog-router                   |

For example, after the CI access check was added to the catalog backend:

```text
Release plan: 1 of 9 services needs a new release

  SERVICE             RELEASED  NEXT   CHANGES
  app                 1.0.1     -      unchanged
  backend-catalog     1.0.1     1.0.2  code: packages/backend-catalog/package.json, packages/backend-catalog/src/ciAccess.ts, packages/backend-catalog/src/index.ts; dependencies: lockfile entries changed, same versions
  backend-core        1.0.1     -      unchanged
  ...
```

### Releasing

```mermaid
flowchart LR
  plan["task plan<br/>also on every pull request"] --> release["task release:changed<br/>builds and pushes only the changed services,<br/>records their versions"]
  release --> commit["commit deploy/releases.json"]
  commit --> tag["task release:tag<br/>git tags service@version"]
  commit --> up["task up:released<br/>each service at its recorded version"]
```

Images carry their version, commit and fingerprint as labels
(`org.opencontainers.image.version`, `org.opencontainers.image.revision`,
`io.backstage-poc.inputs`). In CI
([release.yml](../.github/workflows/release.yml)), every pull request shows
the plan in its job summary; running the workflow by hand builds and pushes
the changed services to GitHub's container registry, commits the record and
pushes the tags. A release replaces only its own containers: the other
services keep running their recorded versions.

## In the repository

| Part                                    | Where                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Gateway routes                          | [gateway/default.conf.template](../gateway/default.conf.template)                                  |
| Shard topology and per-shard config     | [deploy/catalog-shards.json](../deploy/catalog-shards.json), [deploy/catalog/](../deploy/catalog)  |
| Shard rules, shared by router and guard | [packages/catalog-sharding](../packages/catalog-sharding/src)                                      |
| Catalog router                          | [packages/catalog-router](../packages/catalog-router/src)                                          |
| Shard guard and CI token check          | [packages/backend-catalog/src](../packages/backend-catalog/src)                                    |
| CI access config and stand-in           | [deploy/external-access.yaml](../deploy/external-access.yaml), [docker/ci-oidc](../docker/ci-oidc) |
| Dedicated database servers              | [docker-compose.databases.yml](../docker-compose.databases.yml)                                    |
| Change detection and the release record | [scripts/release.mjs](../scripts/release.mjs), [deploy/releases.json](../deploy/releases.json)     |
| Smoke test of every flow above          | [scripts/smoke.mjs](../scripts/smoke.mjs) (`task smoke`)                                           |
