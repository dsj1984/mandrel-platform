# mandrel-platform

Mandrel agent framework platform. Hosts shared GitHub Actions reusable composites consumed by downstream repos.

## Shared Composite Actions

### `setup-toolchain`

Installs pnpm (version sourced from the consuming repo's `packageManager` field), Node.js (version sourced from `.nvmrc`), and project dependencies via `pnpm install --frozen-lockfile`.

**Reference by SHA** to pin an exact version:

```yaml
- name: Setup toolchain
  uses: dsj1984/mandrel-platform/.github/actions/setup-toolchain@<sha>
  with:
    cache: 'true'   # omit or pass 'false' on self-hosted runners with a warm pnpm store
```

**Inputs:**

| Input   | Required | Default | Description                                                                                  |
| ------- | -------- | ------- | -------------------------------------------------------------------------------------------- |
| `cache` | No       | `true`  | Enable pnpm store caching via `actions/setup-node`. Pass `false` on self-hosted runners. |

**When to pass `cache: 'false'`:** Self-hosted runners that maintain their own warm pnpm store do not need the `actions/setup-node` pnpm cache layer. Ubuntu runners on `ubuntu-latest` benefit from the default `cache: 'true'`.