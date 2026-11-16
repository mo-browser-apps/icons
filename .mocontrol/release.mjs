import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const env = process.env;
const command = process.argv[2];
const origin = new URL(env.MOCONTROL_RELEASE_URL);
if (origin.protocol !== 'https:') throw new Error('HTTPS release service required');
const base = `${origin.origin}/v1/orgs/${encodeURIComponent(env.MOCONTROL_ORGANIZATION_ID)}/apps/${encodeURIComponent(env.MOCONTROL_APP_ID)}/releases`;
const version = env.RELEASE_VERSION;
const target = env.RELEASE_TARGET;
const platform = target === 'windows' ? 'windows' : 'macos';
const architecture = target === 'macos' ? 'arm64' : 'x64';
if (
  !['macos', 'macos-x64', 'windows'].includes(target) ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')
)
  throw new Error('Invalid release target');
async function call(operation, fields = {}) {
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', origin.origin);
  const oidc = await fetch(url, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!oidc.ok) throw new Error('GitHub identity unavailable');
  const token = (await oidc.json()).value;
  const response = await fetch(`${base}/${operation}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.MOCONTROL_RELEASE_TOKEN}`,
      'X-GitHub-OIDC': token,
    },
    body: JSON.stringify({
      version,
      platform,
      architecture,
      notes: env.RELEASE_NOTES ?? '',
      dispatchId: env.RELEASE_DISPATCH_ID ?? '',
      sourceCommit: env.RELEASE_SOURCE_COMMIT,
      ...fields,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    // The service returns a short error code; show it so a failure is diagnosable from the run log.
    const code = await response
      .json()
      .then((body) => (typeof body?.error === 'string' ? body.error.slice(0, 80) : ''))
      .catch(() => '');
    throw Object.assign(
      new Error(`Release ${operation} failed (${response.status}${code ? ` ${code}` : ''})`),
      { status: response.status },
    );
  }
  return response.json();
}
const targetName = {
  macos: 'macOS (Apple silicon)',
  'macos-x64': 'macOS (Intel)',
  windows: 'Windows',
}[target];
/** Adds a line to the run's summary page, linking to the app in MoControl once register knows it. */
async function summary(text) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  const { appUrl } = await readStage();
  const link = appUrl ? ` [Open in MoControl](${appUrl})` : '';
  await appendFile(env.GITHUB_STEP_SUMMARY, `**${targetName} ${version}:** ${text}${link}\n`);
}
const stageFile = `${env.RUNNER_TEMP}/mocontrol-release-stage-${platform}.json`;
async function readStage() {
  return JSON.parse(await readFile(stageFile, 'utf8').catch(() => '{}'));
}
async function stage(value) {
  await writeFile(stageFile, JSON.stringify({ ...(await readStage()), ...value }));
}
// Velopack update packages and feed; outside build/, which a production build removes.
const releasesDir = `${env.RUNNER_TEMP}/mocontrol-releases-${platform}`.replaceAll('\\', '/');
// Velopack channel MoBrowser packs per target; Apple Silicon keeps the bare `osx`.
const feedName = `releases.${platform === 'windows' ? 'win' : architecture === 'x64' ? 'osx-x64' : 'osx'}.json`;
const compareVersions = (left, right) => {
  const a = left.split('.').map(Number),
    b = right.split('.').map(Number);
  return (a[0] - b[0]) * 1e12 + (a[1] - b[1]) * 1e6 + (a[2] - b[2]);
};
/** The installer name: the app name lowercased to `a-z0-9` words joined by dashes, or `app`. */
function installerName(appName, extension) {
  const suffix = `-${version}-${platform}-${architecture}.${extension}`;
  const stem = String(appName ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, Math.min(100, 160 - suffix.length))
    .replace(/-+$/, '');
  return `${stem || 'app'}${suffix}`;
}
async function digest(file) {
  const md5 = createHash('md5'),
    sha256 = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    md5.update(chunk);
    sha256.update(chunk);
  }
  return { size: (await stat(file)).size, md5: md5.digest('hex'), sha256: sha256.digest('hex') };
}
/** Seed the latest published full package so the pack step can build a delta from it. */
async function downloadPreviousPackage(updateUrl) {
  let assets;
  try {
    const feed = await fetch(new URL(feedName, updateUrl), { signal: AbortSignal.timeout(30000) });
    if (feed.ok) assets = (await feed.json()).Assets;
    else console.log(`No previous update feed (${feed.status}).`);
  } catch (error) {
    console.log(`Update feed unavailable (${error.message}); publishing without a delta.`);
  }
  const published = (Array.isArray(assets) ? assets : []).filter(
    (asset) =>
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.nupkg$/.test(asset?.FileName) &&
      /^\d+\.\d+\.\d+$/.test(asset.Version),
  );
  // Clients only move forward, so an older version would never be offered; finalize rejects it too.
  if (published.some((asset) => compareVersions(asset.Version, version) > 0))
    throw new Error(
      `A newer version than ${version} is already published; release a higher version.`,
    );
  const previous = published
    .filter((asset) => asset.Type === 'Full' && compareVersions(asset.Version, version) < 0)
    .sort((a, b) => compareVersions(b.Version, a.Version))[0];
  if (!previous) return;
  const file = `${releasesDir}/${previous.FileName}`;
  try {
    const response = await fetch(new URL(previous.FileName, updateUrl), {
      signal: AbortSignal.timeout(900000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
    const actual = await digest(file);
    if (actual.size !== previous.Size || actual.sha256 !== previous.SHA256.toLowerCase())
      throw new Error('checksum mismatch');
  } catch (error) {
    await rm(file, { force: true });
    console.log(`Previous package unavailable (${error.message}); publishing without a delta.`);
  }
}
async function put(target, file, size) {
  const response = await fetch(target.url, {
    method: 'PUT',
    headers: { ...target.headers, 'Content-Length': String(size) },
    body: createReadStream(file),
    duplex: 'half',
    signal: AbortSignal.timeout(900000),
  });
  if (!response.ok && response.status !== 412)
    throw new Error(`Artifact upload failed (${response.status})`);
}
if (command === 'register') {
  const release = await call('register').catch(async (error) => {
    // 409: no pending reservation for this run. 400: inputs MoControl never sends, typed in GitHub.
    if (error.status !== 409 && error.status !== 400) throw error;
    // There is nothing in MoControl for this run to record.
    await stage({ unreserved: true });
    await summary('no pending MoControl release. Start releases from MoControl.');
    throw new Error(
      'MoControl has no pending release for this run: it was started or re-run in GitHub, or MoControl already ended it. Start releases from MoControl.',
    );
  });
  if (
    release.details?.destination !== env.RELEASE_DESTINATION ||
    Boolean(release.details?.signing.profileId) !== (env.RELEASE_SIGN === 'true')
  )
    throw new Error('Workflow inputs do not match reserved settings');
  if (release.updateUrl && new URL(release.updateUrl).protocol !== 'https:')
    throw new Error('HTTPS update URL required');
  await stage({
    failureStage: 'build',
    updateUrl: release.updateUrl ?? null,
    appUrl: release.appUrl?.startsWith('https://') ? release.appUrl : null,
  });
} else if (command === 'prepare') {
  const config = JSON.parse(await readFile('mobrowser.conf.json', 'utf8'));
  const [major, minor, patch] = version.split('.');
  config.app.version = { major, minor, patch };
  if (env.RELEASE_SIGN !== 'true') {
    if (config.app.bundle.macOS)
      for (const key of [
        'codesignIdentity',
        'teamID',
        'appleID',
        'password',
        'provisioningProfile',
      ])
        config.app.bundle.macOS[key] = '';
    if (config.app.bundle.Windows) config.app.bundle.Windows.signCommand = '';
  }
  const { updateUrl } = await readStage();
  if (updateUrl) {
    config.app.updateServerUrl ||= updateUrl;
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    if (config.app.updateServerUrl !== updateUrl)
      console.log('Custom update server URL; update files will not be published.');
    else if (pkg.scripts?.pack === 'mobrowser pack') {
      pkg.scripts.pack = `mobrowser pack --releases "${releasesDir}"`;
      await writeFile('package.json', JSON.stringify(pkg, null, 2));
      await mkdir(releasesDir, { recursive: true });
      await downloadPreviousPackage(updateUrl);
    } else console.log('Custom pack script; update files will not be published.');
  }
  await writeFile('mobrowser.conf.json', JSON.stringify(config, null, 2));
} else if (command === 'signing') {
  await stage({ failureStage: 'sign' });
  await call('progress', { state: 'signing' });
} else if (command === 'verified') {
  await call('progress', { state: 'signing', signingVerified: true });
} else if (command === 'publish') {
  await stage({ failureStage: 'publish' });
  const directory = `build/dist/${platform === 'macos' ? 'mac' : 'win'}-${architecture}/pack`;
  const extension = platform === 'macos' ? 'dmg' : 'exe';
  const files = (await readdir(directory)).filter(
    (name) => name.endsWith(`.${extension}`) && !name.startsWith('rw.'),
  );
  if (files.length !== 1) throw new Error('Expected exactly one installer');
  const file = `${directory}/${files[0]}`;
  const config = JSON.parse(await readFile('mobrowser.conf.json', 'utf8'));
  const artifact = {
    filename: installerName(config.app?.name, extension),
    ...(await digest(file)),
    platform,
    architecture,
  };
  const feedFile = `${releasesDir}/${feedName}`;
  const feed =
    (await readStage()).updateUrl && existsSync(feedFile) ? await readFile(feedFile, 'utf8') : null;
  const updates = feed
    ? await Promise.all(
        JSON.parse(feed)
          .Assets.filter((asset) => asset.Version === version)
          .map(async ({ FileName }) => ({
            filename: FileName,
            ...(await digest(`${releasesDir}/${FileName}`)),
          })),
      )
    : null;
  const fields = updates ? { artifact, updates } : { artifact };
  const upload = await call('upload', fields);
  await put(upload, file, artifact.size);
  // Each upload call re-signs the URLs, so a slow installer upload can't expire the next one.
  for (const update of updates ?? []) {
    const { updates: targets } = await call('upload', fields);
    const target = targets.find((value) => value.filename === update.filename);
    await put(target, `${releasesDir}/${update.filename}`, update.size);
  }
  let published;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      published = await call('finalize', feed ? { feed } : {});
      break;
    } catch {
      if (attempt === 3) throw new Error('Publication pending; check MoControl');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  if (published?.state !== 'published') throw new Error('Publication is not confirmed');
  console.log('Installer published.');
  await summary(`published \`${artifact.filename}\` (${(artifact.size / 1e6).toFixed(1)} MB).`);
} else if (command === 'failed' || command === 'cancelled') {
  const { unreserved, failureStage = 'setup' } = await readStage();
  if (!unreserved) {
    const during = { setup: 'setup', build: 'the build', sign: 'signing', publish: 'publishing' };
    await call('progress', { state: command, failureStage });
    await summary(command === 'failed' ? `failed during ${during[failureStage]}.` : 'cancelled.');
  }
} else throw new Error('Unknown release command');
