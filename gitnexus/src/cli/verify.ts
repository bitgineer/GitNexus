/**
 * `gitnexus verify` — Health check for all indexed repos.
 *
 * Opens each repo's LadybugDB and runs a simple query to detect corruption.
 * Reports which repos are healthy and which need re-indexing.
 */

import { listRegisteredRepos } from '../storage/repo-manager.js';
import { initLbug, executeQuery, closeLbug } from '../core/lbug/lbug-adapter.js';
import path from 'node:path';

export const verifyCommand = async (): Promise<void> => {
  console.log('\n  GitNexus Index Verifier\n');

  const repos = await listRegisteredRepos({ validate: true });
  if (repos.length === 0) {
    console.log('  No indexed repos found.');
    return;
  }

  console.log(`  Checking ${repos.length} indexed repos...\n`);

  let healthy = 0;
  let corrupt = 0;
  const corruptRepos: string[] = [];

  for (const repo of repos) {
    const lbugPath = path.join(repo.storagePath, 'lbug');
    try {
      await initLbug(lbugPath);
      const rows = await executeQuery('MATCH (n) RETURN count(n) AS cnt LIMIT 1');
      const count = rows[0]?.cnt ?? 0;
      await closeLbug();

      if (count > 0) {
        healthy++;
      } else {
        console.log(`  ⚠ ${repo.name}: empty database (0 nodes) — needs re-index`);
        corrupt++;
        corruptRepos.push(repo.name);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCorrupt = msg.includes('Reading past') || msg.includes('i/o error')
        || msg.includes('Could not set lock') || msg.includes('Invalid');
      if (isCorrupt) {
        console.log(`  ✗ ${repo.name}: CORRUPT — ${msg.slice(0, 80)}`);
        corrupt++;
        corruptRepos.push(repo.name);
      } else {
        console.log(`  ⚠ ${repo.name}: ${msg.slice(0, 80)}`);
        corrupt++;
        corruptRepos.push(repo.name);
      }
      try { await closeLbug(); } catch { /* ignore */ }
    }
  }

  console.log(`\n  ── Results ──`);
  console.log(`  Healthy: ${healthy}/${repos.length}`);
  console.log(`  Needs re-index: ${corrupt}`);

  if (corruptRepos.length > 0) {
    console.log(`\n  To fix, re-index these repos:`);
    for (const name of corruptRepos) {
      const repo = repos.find(r => r.name === name);
      if (repo) {
        console.log(`    cd ${repo.path} && gitnexus analyze --force`);
      }
    }
  } else {
    console.log(`\n  All indexes are healthy.`);
  }
  console.log('');
};
