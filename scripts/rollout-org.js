#!/usr/bin/env node
'use strict';

/*
 * A deliberately small rollout driver.  Its YAML edits are guarded edits of
 * the gh-aw package template, not YAML parsing: a changed template stops the
 * rollout rather than risking a broad text rewrite.
 */
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_ORG = 'bootc-dev';
const DEFAULT_SOURCE = 'bootc-dev/gh-agentic-workflows';
const INSTALL_BRANCH = 'agent-pipeline-rollout';
const CORE_FILES = ['drafter.md', 'fix.md', 'review.md', 'merge.yml', 'install-labels.yml', 'upgrade.yml'];
const SEMVER = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const NETWORKS = { Rust: 'rust', Go: 'go', Python: 'python' };

function parseArgs(argv) {
  const result = { org: DEFAULT_ORG, source: DEFAULT_SOURCE, repos: [], apply: false, all: false, json: false, repairSignoffs: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply' || arg === '--all' || arg === '--json' || arg === '--repair-signoffs') result[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
    else if (arg === '--org' || arg === '--version' || arg === '--source' || arg === '--repo' || arg === '--confirm-org') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--repo') result.repos.push(value);
      else result[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else if (arg === '--help') result.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (result.help) return result;
  if (!result.version || !SEMVER.test(result.version)) throw new Error('--version must be an exact semver tag such as v1.2.3 (prereleases allowed)');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.source)) throw new Error('--source must be OWNER/REPOSITORY');
  result.repos = [...new Set(result.repos.map((repo) => normalizeRepo(repo, result.org)))];
  if (result.apply && result.confirmOrg !== result.org) throw new Error('--apply requires --confirm-org matching --org exactly');
  if (result.repairSignoffs && !result.apply) throw new Error('--repair-signoffs requires --apply');
  if (result.apply && !result.all && result.repos.length === 0) throw new Error('--apply requires --repo (repeatable) or explicit --all');
  if (result.all && result.repos.length) throw new Error('use either --all or --repo, not both');
  return result;
}

function normalizeRepo(repo, org) {
  const parts = repo.split('/');
  if (parts.length === 1 && /^[A-Za-z0-9_.-]+$/.test(parts[0])) return `${org}/${parts[0]}`;
  if (parts.length === 2 && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) {
    if (parts[0] !== org) throw new Error(`--repo ${repo} is outside --org ${org}`);
    return repo;
  }
  throw new Error(`--repo must be NAME or ${org}/NAME`);
}

function eligible(repo) {
  if (repo.isArchived || repo.isFork || repo.isTemplate || repo.isEmpty || !repo.defaultBranchRef) return false;
  const name = repo.name || (repo.nameWithOwner || '').split('/').pop();
  return name !== 'community' && name !== '.github' && !name.endsWith('.project') && !name.endsWith('sandbox');
}

function selectRepos(repos, requested) {
  const selected = requested.length ? repos.filter((repo) => requested.includes(repo.nameWithOwner)) : repos;
  const missing = requested.filter((name) => !repos.some((repo) => repo.nameWithOwner === name));
  return { selected, missing };
}

const AUTO_MERGE_CONDITION = "      github.event.label.name == 'agent/lgtm' &&\n      startsWith(github.event.pull_request.head.ref, 'agent/') &&\n      github.event.pull_request.head.repo.id == github.repository_id\n";
const PILOT_COMMENT = '    # Pilot rollout: delete the `false &&` line above once reviewer/fixer\n    # judgment quality has been watched for a couple of weeks.\n';

function autoMergeState(source) {
  const condition = AUTO_MERGE_CONDITION;
  const escaped = condition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const comments = '(?:    #[^\\n]*\\n)*';
  const expected = new RegExp(`^(    if: \\|\\n)(${escaped})${comments}(?=    runs-on:)`, 'm');
  const disabled = new RegExp(`^    if: \\|\\n      false &&\\n${escaped}${comments}(?=    runs-on:)`, 'm');
  if (disabled.test(source)) return 'pilot';
  if (expected.test(source)) return 'enabled';
  throw new Error('merge.yml does not have the known enabled or pilot-disabled guard; refusing to overwrite it');
}

function disableAutoMerge(source) {
  if (autoMergeState(source) === 'pilot') return source;
  const escaped = AUTO_MERGE_CONDITION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expected = new RegExp(`^(    if: \\|\\n)(${escaped})((?:    #[^\\n]*\\n)*)(?=    runs-on:)`, 'm');
  return source.replace(expected, `$1      false &&\n$2$3${PILOT_COMMENT}`);
}

function enableAutoMerge(source) {
  if (autoMergeState(source) === 'enabled') return source;
  return source.replace('      false &&\n', '').replace(PILOT_COMMENT, '');
}

function addNetworkAccess(source, language) {
  const ecosystem = NETWORKS[language];
  if (!ecosystem) return { source, changed: false, ecosystem: null };
  const frontmatter = source.match(/^(---\n)([\s\S]*?)(^---\n)/m);
  if (!frontmatter) throw new Error('workflow has no recognizable frontmatter; refusing network edit');
  const body = frontmatter[2];
  if (/^network:/m.test(body)) {
    const blocks = body.match(/^network:$/gm);
    const known = body.match(/^network:\n  allowed:\n((?:    - [^\n]+\n)+)\n?$/m);
    if (!blocks || blocks.length !== 1 || !known) throw new Error('workflow network block is not the known allowed-list shape; manual network review required');
    const allowed = [...known[1].matchAll(/^    - ([^\n]+)$/gm)].map((match) => match[1]);
    const wildcard = allowed.includes('"*"') || allowed.includes("'*'");
    if (!allowed.includes(ecosystem) && !wildcard) throw new Error(`workflow network block does not allow ${ecosystem}; manual network review required`);
    return { source, changed: false, ecosystem };
  }
  const anchors = body.match(/^safe-outputs:$/gm);
  if (!anchors || anchors.length !== 1) throw new Error('workflow does not have one safe-outputs anchor; refusing network edit');
  const inserted = body.replace(/^safe-outputs:$/m, `network:\n  allowed:\n    - defaults\n    - ${ecosystem}\n\nsafe-outputs:`);
  return { source: source.replace(body, inserted), changed: true, ecosystem };
}

function normalizePackageWhitespace(source) {
  return source.replace(/(?<![ \t]) (?=\n)/g, '');
}

function defaultRun(command, args, options = {}) {
  const output = childProcess.spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8' });
  if (output.error) throw output.error;
  if (output.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(output.stderr || output.stdout || '').trim()}`);
  return output.stdout;
}

function ghJson(run, args) {
  const output = run('gh', args);
  try { return JSON.parse(output); } catch (_) { throw new Error(`gh returned invalid JSON for: ${args.join(' ')}`); }
}

function validateRelease(options, run) {
  const release = ghJson(run, ['release', 'view', options.version, '--repo', options.source, '--json', 'tagName']);
  if (!release || release.tagName !== options.version) throw new Error(`release validation returned tag ${release && release.tagName ? release.tagName : 'nothing'}, expected ${options.version}`);
}

function survey(repo, run) {
  const details = ghJson(run, ['api', `repos/${repo.nameWithOwner}`]);
  const branch = repo.defaultBranchRef.name;
  let files;
  try { files = ghJson(run, ['api', `repos/${repo.nameWithOwner}/contents/.github/workflows?ref=${encodeURIComponent(branch)}`]); }
  catch (error) {
    if (/404|Not Found/.test(error.message)) files = [];
    else throw error;
  }
  const names = new Set(Array.isArray(files) ? files.map((file) => file.name) : []);
  return { branch, language: repo.primaryLanguage && repo.primaryLanguage.name, installed: CORE_FILES.every((name) => names.has(name)), topics: details.topics || [] };
}

function operationFor(installed, version) {
  return installed
    ? { kind: 'update', branch: `agent-pipeline-update-${version}` }
    : { kind: 'install', branch: INSTALL_BRANCH };
}

function rolloutState(repo, branch, run) {
  const pulls = ghJson(run, ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number,url']);
  if (pulls.length) return { kind: 'open-pr', prNumber: pulls[0].number, prUrl: pulls[0].url };
  try {
    ghJson(run, ['api', `repos/${repo}/git/ref/heads/${branch}`]);
    return { kind: 'branch-only' };
  } catch (error) {
    if (/404|Not Found/.test(error.message)) return { kind: 'available' };
    throw error;
  }
}

function repairSignoff(target, options, operation, state, deps) {
  const { run, fs: fileSystem, tempDir } = deps;
  const expected = commitMessage(options, operation);
  const pr = ghJson(run, ['pr', 'view', String(state.prNumber), '--repo', target.repo, '--json', 'headRefName,headRefOid,isCrossRepository,commits']);
  if (pr.isCrossRepository || pr.headRefName !== operation.branch || pr.commits.length !== 1 || pr.commits[0].oid !== pr.headRefOid) {
    throw new Error('open rollout PR is not a single-commit same-repository branch; refusing to rewrite it');
  }
  const commit = pr.commits[0];
  const message = `${commit.messageHeadline}${commit.messageBody ? `\n\n${commit.messageBody}` : ''}`;
  if (/^Signed-off-by:/m.test(message)) return { status: 'already-open', prUrl: state.prUrl, reason: 'rollout commit is already signed off' };
  if (message !== expected) throw new Error('open rollout PR commit message differs from the tool-generated message; refusing to rewrite it');

  const directory = tempDir();
  try {
    run('gh', ['repo', 'clone', target.repo, directory]);
    run('git', ['fetch', 'origin', operation.branch], { cwd: directory });
    const fetched = run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: directory }).trim();
    if (fetched !== pr.headRefOid) throw new Error('rollout branch changed while preparing signoff repair; retry after reviewing it');
    run('git', ['checkout', '--detach', fetched], { cwd: directory });
    run('git', ['commit', '--amend', '--no-edit', '--signoff'], { cwd: directory });
    run('git', ['push', `--force-with-lease=refs/heads/${operation.branch}:${fetched}`, 'origin', `HEAD:refs/heads/${operation.branch}`], { cwd: directory });
    return { status: 'signoff-repaired', prUrl: state.prUrl };
  } finally { fileSystem.rmSync(directory, { recursive: true, force: true }); }
}

function applyRepo(target, options, operation, deps) {
  const { run, fs: fileSystem, tempDir } = deps;
  const directory = tempDir();
  let pushed = false;
  try {
    run('gh', ['repo', 'clone', target.repo, directory]);
    const clean = run('git', ['status', '--porcelain'], { cwd: directory });
    if (clean.trim()) throw new Error('fresh clone is not clean; refusing to modify it');
    run('git', ['checkout', '-b', operation.branch], { cwd: directory });
    let previousAutoMerge;
    if (operation.kind === 'update') {
      const merge = path.join(directory, '.github/workflows/merge.yml');
      previousAutoMerge = autoMergeState(fileSystem.readFileSync(merge, 'utf8'));
    }
    const addArgs = ['aw', 'add', `${options.source}@${options.version}`, '--dir', '.github/workflows'];
    if (operation.kind === 'update') addArgs.push('--force');
    run('gh', addArgs, { cwd: directory });
    for (const name of ['drafter.md', 'fix.md', 'review.md']) {
      const file = path.join(directory, '.github/workflows', name);
      fileSystem.writeFileSync(file, normalizePackageWhitespace(fileSystem.readFileSync(file, 'utf8')));
    }
    const merge = path.join(directory, '.github/workflows/merge.yml');
    if (operation.kind === 'install' || previousAutoMerge === 'pilot') {
      fileSystem.writeFileSync(merge, disableAutoMerge(fileSystem.readFileSync(merge, 'utf8')));
    } else {
      fileSystem.writeFileSync(merge, enableAutoMerge(fileSystem.readFileSync(merge, 'utf8')));
    }
    for (const name of ['drafter.md', 'fix.md']) {
      const file = path.join(directory, '.github/workflows', name);
      const changed = addNetworkAccess(fileSystem.readFileSync(file, 'utf8'), target.language);
      if (changed.changed) fileSystem.writeFileSync(file, changed.source);
    }
    run('gh', ['aw', 'compile', 'drafter', 'fix', 'review', '--approve'], { cwd: directory });
    const changes = run('git', ['status', '--porcelain'], { cwd: directory });
    if (!changes.trim()) {
      return { status: 'unchanged', ecosystem: NETWORKS[target.language] || null, manualReview: !NETWORKS[target.language] };
    }
    run('git', ['add', '--all'], { cwd: directory });
    run('git', ['diff', '--cached', '--check'], { cwd: directory });
    run('git', ['commit', '--signoff', '-m', commitMessage(options, operation)], { cwd: directory });
    run('git', ['push', '-u', 'origin', operation.branch], { cwd: directory });
    pushed = true;
    const prUrl = run('gh', ['pr', 'create', '--draft', '--base', target.branch, '--title', prTitle(options, operation), '--body', prBody(options, target.language, operation)], { cwd: directory }).trim();
    if (!prUrl) throw new Error('gh pr create did not return a PR URL');
    return { status: operation.kind === 'update' ? 'update-opened' : 'opened', ecosystem: NETWORKS[target.language] || null, manualReview: !NETWORKS[target.language], prUrl };
  } catch (error) {
    if (pushed) error.rolloutBranchPushed = true;
    throw error;
  } finally { fileSystem.rmSync(directory, { recursive: true, force: true }); }
}

function executeRollout(options, deps = {}) {
  const run = deps.run || defaultRun;
  const fileSystem = deps.fs || fs;
  const tempDir = deps.tempDir || (() => fs.mkdtempSync(path.join(os.tmpdir(), 'gh-aw-rollout-')));
  validateRelease(options, run);
  const repos = ghJson(run, ['repo', 'list', options.org, '--limit', '1000', '--json', 'name,nameWithOwner,isArchived,isFork,isTemplate,isEmpty,defaultBranchRef,primaryLanguage']);
  const { selected, missing } = selectRepos(repos, options.repos);
  const results = missing.map((repo) => ({ repo, status: 'unclassified', reason: 'requested repository was not discovered' }));
  for (const repo of selected) {
    const explicitlyRequested = options.repos.includes(repo.nameWithOwner);
    if (!eligible(repo)) { results.push({ repo: repo.nameWithOwner, status: explicitlyRequested ? 'blocked' : 'skipped', reason: 'ineligible repository metadata' }); continue; }
    if (repo.nameWithOwner === options.source) { results.push({ repo: repo.nameWithOwner, status: 'skipped', reason: 'source package repository' }); continue; }
    let info;
    try { info = survey(repo, run); } catch (error) { results.push({ repo: repo.nameWithOwner, status: 'failed', reason: error.message }); continue; }
    if (info.topics.includes('community')) { results.push({ repo: repo.nameWithOwner, status: explicitlyRequested ? 'blocked' : 'skipped', reason: 'community topic' }); continue; }
    const operation = operationFor(info.installed, options.version);
    let state;
    try { state = rolloutState(repo.nameWithOwner, operation.branch, run); }
    catch (error) { results.push({ repo: repo.nameWithOwner, status: 'failed', reason: error.message }); continue; }
    if (!options.apply) {
      if (state.kind === 'open-pr') results.push({ repo: repo.nameWithOwner, status: operation.kind === 'update' ? 'update-open' : 'already-open', prUrl: state.prUrl, operationBranch: operation.branch, reason: `draft PR for ${operation.branch} is already open` });
      else if (state.kind === 'branch-only') results.push({ repo: repo.nameWithOwner, status: 'blocked', operationBranch: operation.branch, reason: `remote branch ${operation.branch} exists without an open PR` });
      else results.push({ repo: repo.nameWithOwner, status: info.installed ? 'update-planned' : 'planned', branch: info.branch, language: info.language, operationBranch: operation.branch, manualReview: !NETWORKS[info.language] });
      continue;
    }
    try {
      if (state.kind === 'open-pr') {
        if (options.repairSignoffs) results.push({ repo: repo.nameWithOwner, ...repairSignoff({ repo: repo.nameWithOwner, ...info }, options, operation, state, { run, fs: fileSystem, tempDir }) });
        else results.push({ repo: repo.nameWithOwner, status: operation.kind === 'update' ? 'update-open' : 'already-open', prUrl: state.prUrl, reason: `draft PR for ${operation.branch} is already open` });
        continue;
      }
      if (state.kind === 'branch-only') { results.push({ repo: repo.nameWithOwner, status: 'blocked', reason: `remote branch ${operation.branch} exists without an open PR; inspect it, open a draft PR, or delete the branch before retrying` }); continue; }
      if (options.repairSignoffs) { results.push({ repo: repo.nameWithOwner, status: 'skipped', reason: `no open rollout PR for ${operation.branch} to repair` }); continue; }
      results.push({ repo: repo.nameWithOwner, branch: info.branch, language: info.language, operationBranch: operation.branch, ...applyRepo({ repo: repo.nameWithOwner, ...info }, options, operation, { run, fs: fileSystem, tempDir }) });
    }
    catch (error) {
      if (error.rolloutBranchPushed) results.push({ repo: repo.nameWithOwner, status: 'blocked', reason: `branch ${operation.branch} was pushed but draft PR creation failed; inspect it and open a draft PR manually: ${error.message}` });
      else results.push({ repo: repo.nameWithOwner, status: 'failed', reason: error.message });
    }
  }
  return results;
}

function print(results, json) {
  if (json) console.log(JSON.stringify(results, null, 2));
  else results.forEach((item) => console.log(`${item.repo}: ${item.status}${item.branch ? ` (${item.branch}${item.language ? `, ${item.language}` : ''})` : ''}${item.operationBranch ? ` — operation branch ${item.operationBranch}` : ''}${item.prUrl ? ` — ${item.prUrl}` : ''}${item.manualReview ? ' — manual network review required' : ''}${item.reason ? ` — ${item.reason}` : ''}`));
}

function commitMessage(options, operation) {
  if (operation.kind === 'update') {
    return `agent pipeline: Update to ${options.version}\n\nUse an exact package refresh because stable gh-aw cannot target an exact new package tag with update. Review overwritten local package customizations and any stale files retained from the previous package.\n\nAssisted-by: AI`;
  }
  return `agent pipeline: Roll out ${options.version}\n\nKeep package-managed support files and pilot customizations together so review covers the complete installation.\n\nAssisted-by: AI`;
}

function prTitle(options, operation) {
  return operation.kind === 'update' ? `agent pipeline: update to ${options.version}` : 'agent pipeline: pilot rollout';
}

function prBody(options, language, operation) {
  const networkReview = NETWORKS[language] ? '' : '\n- [ ] Review network access manually before enabling agent build/test validation for this language.';
  if (operation.kind === 'update') {
    return `Exact package update from \`${options.source}@${options.version}\` using \`gh aw add --force\`. Stable gh-aw cannot select an exact new package tag with \`gh aw update\`, and package-aware URL updates are not stable.\n\nThis is an overwrite, not a three-way merge. Review local package-file customizations that may have been replaced and stale package files that may have been retained. The drafter and fixer network policy was reapplied after the refresh.\n\nBefore merging:\n- [ ] Verify the GitHub App configuration and required labels still work.\n- [ ] Keep the release pin at \`${options.source}@${options.version}\` unless intentionally upgrading.\n- [ ] Confirm the preserved auto-merge guard is appropriate for this repository.\n- [ ] If this repository uses a merge queue, keep its Allow auto-merge repository setting enabled.${networkReview}`;
  }
  return `Pilot rollout of ${options.source}@${options.version}. Auto-merge is disabled for the pilot.\n\nBefore enabling the pipeline:\n- [ ] Keep the release pin at \`${options.source}@${options.version}\` unless intentionally upgrading.\n- [ ] Install the GitHub App and configure \`GH_AW_APP_CLIENT_ID\`, \`GH_AW_APP_PRIVATE_KEY\`, and \`GH_AW_APP_BOT_SLUG\`.\n- [ ] Run the Install Labels workflow.\n- [ ] File and label a low-stakes E2E issue to validate the draft/review/fix loop.\n- [ ] Enable auto-merge only after the pilot has been reviewed; remove the guarded \`false &&\` in \`merge.yml\`.\n- [ ] If this repository uses a merge queue, enable its Allow auto-merge repository setting.${networkReview}`;
}

function usage() { console.log('Usage: node scripts/rollout-org.js --version vX.Y.Z [--org ORG] [--repo ORG/REPO ...] [--apply --confirm-org ORG (--all|--repo ORG/REPO) [--repair-signoffs]] [--json]'); }

if (require.main === module) {
  try { const options = parseArgs(process.argv.slice(2)); if (options.help) usage(); else { const results = executeRollout(options); print(results, options.json); if (results.some((item) => ['failed', 'blocked', 'unclassified'].includes(item.status))) process.exitCode = 1; } }
  catch (error) { console.error(`rollout-org: ${error.message}`); process.exitCode = 1; }
}

module.exports = { SEMVER, NETWORKS, parseArgs, normalizeRepo, eligible, selectRepos, autoMergeState, disableAutoMerge, enableAutoMerge, addNetworkAccess, normalizePackageWhitespace, validateRelease, operationFor, rolloutState, repairSignoff, applyRepo, commitMessage, prTitle, prBody, executeRollout };
