// Anonymous fixed public SHA; an explicit frozen overlay is optional and candidate-only.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, readlink, realpath } from 'node:fs/promises'
import { join, resolve, relative, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const PUBLIC_URL = 'https://github.com/nengong-ai/AccessMux.git'
const PLUGIN = 'integrations/dsh-accessmux-connect'
// Only the reviewed T045/T046 changes may be overlaid. Never walk a developer tree.
const CANDIDATE_PATHS = new Set([
  'src/adapters/trae/bridge.ts', 'src/adapters/trae/index.ts', 'src/adapters/types.ts',
  'src/adapters/workbuddy/body-shaper.ts', 'src/adapters/workbuddy/index.ts',
  'src/adapters/workbuddy/reasoning-fields.ts', 'src/protocol/server.ts',
  'src/protocol/reasoning.ts', 'src/types.ts', 'src/ui/model-badges.ts',
  'src/ui/public/onboard-prompt.ts', 'tests/adapters/trae/bridge.test.ts',
  'tests/adapters/workbuddy/body-shaper.test.ts', 'tests/ui-onboard-prompt.test.ts',
  'tests/protocol/reasoning-control.test.ts',
  ...['README.md', 'catalog.js', 'adapter.js', 'package.json', 'package-lock.json',
    'vitest.config.ts', 'scripts/reasoning-fixture.mjs', 'scripts/verify-daemon.mjs',
    'scripts/verify-reasoning.mjs', 'scripts/verify-first-install.mjs',
    'test/reasoning.spec.js'].map(path => `${PLUGIN}/${path}`),
])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fullSHA = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
export function parseOptions(args) {
  const options = {}
  const keys = new Set(['--sha', '--evidence-dir', '--candidate-root', '--manifest'])
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(keys.has(args[i]), `unknown option: ${args[i]}`)
    assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `missing value: ${args[i]}`)
    assert.ok(!Object.hasOwn(options, args[i]), `duplicate option: ${args[i]}`)
    options[args[i]] = args[i + 1]
  }
  assert.ok(fullSHA(options['--sha']), '--sha must be a full lowercase 40-character commit SHA')
  assert.ok(options['--evidence-dir'], '--evidence-dir is required (use a new directory outside the clone)')
  assert.equal(Boolean(options['--candidate-root']), Boolean(options['--manifest']),
    '--candidate-root and --manifest must be supplied together for candidate mode')
  return { sha: options['--sha'], evidenceDir: resolve(options['--evidence-dir']),
    candidate: options['--candidate-root'] ? resolve(options['--candidate-root']) : null,
    manifestPath: options['--manifest'] ? resolve(options['--manifest']) : null }
}
export function validateOverlay(value, sha) {
  assert.equal(value?.schemaVersion, 1, 'unsupported candidate manifest schemaVersion')
  assert.equal(value.publicCommit, sha, 'candidate manifest publicCommit differs from --sha')
  assert.ok(Array.isArray(value.files) && value.files.length > 0, 'candidate manifest files must be nonempty')
  const seen = new Set()
  for (const entry of value.files) {
    assert.ok(CANDIDATE_PATHS.has(entry?.path), `candidate path is not reviewed public input: ${entry?.path}`)
    assert.ok(!seen.has(entry.path), `duplicate candidate path: ${entry.path}`)
    assert.match(entry.sha256 ?? '', /^[0-9a-f]{64}$/, `invalid SHA-256: ${entry.path}`)
    seen.add(entry.path)
  }
  assert.equal(seen.has(`${PLUGIN}/package.json`), seen.has(`${PLUGIN}/package-lock.json`),
    'candidate plugin package.json and package-lock.json must be supplied together')
  return value.files.map(({ path, sha256 }) => ({ path, sha256 }))
}
// Reject symlinks in every component before reading/copying an explicit input.
export async function readPlainFile(root, path) {
  let current = root
  assert.ok((await lstat(root)).isDirectory(), 'candidate root must be a plain directory')
  for (const part of path.split('/')) {
    current = join(current, part)
    const info = await lstat(current)
    assert.ok(!info.isSymbolicLink(), `symlink input refused: ${path}`)
    assert.ok(current === join(root, path) ? info.isFile() : info.isDirectory(), `not a plain file: ${path}`)
  }
  return readFile(current)
}
const exists = async path => {
  try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

export async function main(args) {
  let options
  try { options = parseOptions(args) } catch (error) {
    console.error(String(error)); process.exitCode = 1; return
  }
  const { candidate, evidenceDir, manifestPath } = options
  // Never overwrite an earlier run or emit partial evidence into the source tree.
  assert.ok(!candidate || relative(candidate, evidenceDir).startsWith('..' + '/') ||
    relative(candidate, evidenceDir) === '..', 'evidence directory must be outside candidate root')
  assert.ok(!await exists(evidenceDir), 'evidence directory already exists; select a new run directory')
  await mkdir(evidenceDir, { recursive: true })
  const temp = await mkdtemp(join(tmpdir(), 'accessmux-first-install-'))
  const home = join(temp, 'home')
  const repo = join(temp, 'repo')
  const profile = join(home, '.dsh/profiles/desktop')
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'en_US.UTF-8', TMPDIR: temp,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    npm_config_cache: join(home, '.npm'), npm_config_userconfig: join(home, '.npmrc'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
  const transcript = []
  const manifest = { mode: candidate ? 'candidate' : 'public', publicURL: PUBLIC_URL,
    publicCommit: options.sha, node: process.version, temporaryRoot: temp,
    overlay: [], sdk: {}, checks: {}, cleanup: {} }
  const run = (command, args, cwd = repo) => {
    transcript.push({ command, args, cwd: relative(temp, cwd) })
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024, timeout: 180000 })
    transcript.at(-1).exitCode = result.status
    transcript.at(-1).output = (result.stdout ?? '') + (result.stderr ?? '')
    if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${transcript.at(-1).output.slice(-4000)}`)
    return result.stdout.trim()
  }
  try {
    await mkdir(profile, { recursive: true })
    let frozen = []
    if (candidate) {
      const bytes = await readFile(manifestPath)
      manifest.candidateManifestSHA256 = hash(bytes)
      frozen = validateOverlay(JSON.parse(bytes), options.sha)
      // Validate ALL entries before copying any, fetching Git, or installing packages.
      for (const entry of frozen) {
        assert.equal(hash(await readPlainFile(candidate, entry.path)), entry.sha256, `candidate hash drift: ${entry.path}`)
      }
      manifest.checks.candidateManifestValid = true
    }
    // Anonymous HTTPS only: no caller HOME/config/helper/env or local Git metadata.
    run('git', ['-c', 'credential.helper=', 'clone', '--no-checkout', PUBLIC_URL, repo], temp)
    try { run('git', ['checkout', '--detach', options.sha]) } catch (error) {
      throw new Error(`SHA ${options.sha} is unavailable in the anonymous public clone; publish it before public verification. ${error}`)
    }
    manifest.actualHEAD = run('git', ['rev-parse', 'HEAD'])
    assert.equal(manifest.actualHEAD, options.sha, 'cloned HEAD differs from --sha')
    assert.equal(run('git', ['status', '--porcelain']), '')
    manifest.publicTreeSHA = run('git', ['rev-parse', 'HEAD^{tree}'])
    manifest.checks.publicSHAExact = true
    manifest.rootPackageSHA256 = hash(await readFile(join(repo, 'package.json')))
    manifest.rootLockSHA256 = hash(await readFile(join(repo, 'package-lock.json')))
    for (const entry of frozen) {
      const bytes = await readPlainFile(candidate, entry.path)
      assert.equal(hash(bytes), entry.sha256, `candidate hash drift before copy: ${entry.path}`)
      await mkdir(dirname(join(repo, entry.path)), { recursive: true })
      await writeFile(join(repo, entry.path), bytes)
      manifest.overlay.push(entry)
    }
    assert.equal(hash(await readFile(join(repo, 'package.json'))), manifest.rootPackageSHA256)
    assert.equal(hash(await readFile(join(repo, 'package-lock.json'))), manifest.rootLockSHA256)
    manifest.checks.publicRootPackageAndLockPreserved = true
    manifest.internalDirectoriesPresent = []
    for (const dir of ['investigations', 'receipts', 'tasks', 'memory']) {
      if (await exists(join(repo, dir))) manifest.internalDirectoriesPresent.push(dir)
    }
    const pluginDir = join(repo, PLUGIN)
    for (const path of ['scripts/verify-daemon.mjs', 'scripts/verify-reasoning.mjs', 'scripts/reasoning-fixture.mjs']) {
      assert.ok(await exists(join(pluginDir, path)), `fixed SHA/candidate lacks ${PLUGIN}/${path}; use the reviewed release SHA`)
    }
    manifest.validatorSHA256 = hash(await readFile(fileURLToPath(import.meta.url)))
    assert.equal(hash(await readPlainFile(repo, `${PLUGIN}/scripts/verify-first-install.mjs`)),
      manifest.validatorSHA256, 'invoked validator differs from fixed SHA/candidate validator; run its own script')
    const pluginPkg = JSON.parse(await readFile(join(pluginDir, 'package.json')))
    const pluginLock = JSON.parse(await readFile(join(pluginDir, 'package-lock.json')))
    assert.equal(pluginPkg.version, pluginLock.version, 'plugin package/lock version mismatch')
    assert.equal(pluginPkg.version, pluginLock.packages[''].version, 'plugin lock root version mismatch')
    // Freeze runtime/build/install/plugin inputs actually consumed, from public Git + explicit overlay.
    const inputPaths = new Set([...run('git', ['ls-files', '-z']).split('\0').filter(Boolean), ...frozen.map(f => f.path)])
    manifest.inputFiles = []
    for (const path of [...inputPaths].sort()) {
      if (/^(src\/|scripts\/|integrations\/dsh-accessmux-connect\/)/.test(path) ||
        ['install.sh', 'tsconfig.json', 'package.json', 'package-lock.json'].includes(path)) {
        manifest.inputFiles.push({ path, sha256: hash(await readPlainFile(repo, path)) })
      }
    }
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
    run('npm', ['run', 'build'])
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], pluginDir)
    run('npm', ['test'], pluginDir)
    run('npm', ['run', 'typecheck'], pluginDir)
    manifest.checks.pluginTestsAndTypecheck = true
    const dependencies = { '@deepseek-ai/cordis': '4.0.4', '@deepseek-ai/dsh-llm': '0.2.0-rc.2',
      '@deepseek-ai/dsh-llm-pi-ai': '0.2.0-rc.2', '@deepseek-ai/schemastery': '3.18.4', '@earendil-works/pi-ai': '0.87.1' }
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'synthetic-desktop', private: true, type: 'module',
      dependencies, dsh: { profile: { bundles: [] } } }, null, 2))
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], profile)
    for (const name of Object.keys(dependencies)) {
      const installed = JSON.parse(await readFile(join(profile, 'node_modules', name, 'package.json')))
      assert.equal(installed.version, dependencies[name]); manifest.sdk[name] = installed.version
    }
    manifest.sdkSourceHashes = {}
    for (const path of ['@deepseek-ai/dsh-llm-pi-ai/lib/index.js', '@deepseek-ai/dsh-llm/lib/index.js',
      '@earendil-works/pi-ai/dist/types.d.ts', '@earendil-works/pi-ai/dist/api/openai-completions.js']) {
      manifest.sdkSourceHashes[path] = hash(await readFile(join(profile, 'node_modules', path)))
    }
    await rm(join(pluginDir, 'node_modules'), { recursive: true, force: true })
    // Full real runOnboard installation happens inside the production daemon verifier.
    // That runner uses only built-ins until installed, then imports the host-resolved bundle.
    run('node', ['--preserve-symlinks', '--preserve-symlinks-main', join(pluginDir, 'scripts/verify-daemon.mjs'), repo, join(evidenceDir, 'first-install-daemon.json')], profile)
    manifest.checks.productionDaemonSyntheticHTTP = true
    manifest.checks.onboardFirstAndRepeat = true
    const pkg = JSON.parse(await readFile(join(profile, 'package.json')))
    assert.deepEqual(pkg.dsh.profile.bundles, ['dsh-accessmux-connect'])
    assert.equal(pkg.dependencies['dsh-accessmux-connect'], `link:${pluginDir}`)
    const linked = join(profile, 'node_modules/dsh-accessmux-connect')
    assert.ok((await lstat(linked)).isSymbolicLink()); assert.equal(await readlink(linked), pluginDir)
    assert.ok(!pkg.models && !pkg.providers && !pkg.credentials)
    const patch = await readFile(join(linked, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /id: llm-accessmux/); assert.match(patch, /name: dsh-accessmux-connect/)
    manifest.checks.onboardFirstAndRepeat = true
    manifest.profile = pkg
    // Node preserves host's link resolution, so peer packages come from the clean host profile.
    run('node', ['--preserve-symlinks', '--preserve-symlinks-main', join(linked, 'scripts/verify-reasoning.mjs'), join(evidenceDir, 'first-install-sdk.json')], profile)
    manifest.checks.registeredSDK = true
    const changes = []
    for (const entry of manifest.inputFiles) {
      if (hash(await readPlainFile(repo, entry.path)) !== entry.sha256) changes.push(entry.path)
    }
    if (candidate) {
      for (const entry of frozen) {
        if (hash(await readPlainFile(candidate, entry.path)) !== entry.sha256) changes.push(`candidate:${entry.path}`)
      }
      assert.equal(hash(await readFile(manifestPath)), manifest.candidateManifestSHA256, 'candidate manifest changed during verification')
    }
    manifest.changedDuringVerification = changes
    manifest.checks.sourceStableDuringVerification = changes.length === 0
    assert.deepEqual(changes, [], 'input source changed during verification')
    manifest.pass = true
  } catch (error) {
    manifest.error = String(error)
    process.exitCode = 1
  } finally {
    await rm(temp, { recursive: true, force: true })
    manifest.cleanup = { tempRemoved: !await exists(temp),
      services: 'child verifier services use random ports and close in finally; foreground children exited',
      realHostModified: false, published: false }
    await writeFile(join(evidenceDir, 'first-install-commands.json'), JSON.stringify(transcript, null, 2) + '\n')
    await writeFile(join(evidenceDir, 'first-install-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    console.log(JSON.stringify({ mode: manifest.mode, publicCommit: manifest.publicCommit, actualHEAD: manifest.actualHEAD,
      pass: manifest.pass ?? false, checks: manifest.checks, error: manifest.error, cleanup: manifest.cleanup }))
  }
}
if (process.argv[1] && await realpath(resolve(process.argv[1])) === await realpath(fileURLToPath(import.meta.url))) {
  await main(process.argv.slice(2))
}
